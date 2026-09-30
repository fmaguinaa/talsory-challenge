# Despliegue en la nube

Infraestructura como código con **Bicep** para **Azure Container Apps**.

> **Estado de esta infraestructura: validada pero NO ejecutada.**
> `deploy/main.bicep` compila sin errores ni advertencias con `bicep build` y el
> ARM generado ha sido revisado, pero nunca se ha aplicado contra una suscripción
> real: no había credenciales de Azure disponibles. Los pasos de abajo son
> completos y están escritos para seguirse tal cual, pero **no existe ninguna URL
> desplegada** y no se debe dar por hecho que el despliegue funciona hasta
> ejecutarlo una vez. EsteREADME lo dice de forma explícita porque una URL
> inventada sería peor que ninguna.

---

## 1. Por qué Azure Container Apps

La decisión está en [ADR-008](../docs/adr/008-cloud-target-and-deployment-strategy.md).
En corto: el sistema ya es un conjunto de contenedores sin estado que escalan
horizontalmente, y ACA da a cada uno su propio ingress, revisión y regla de
escalado sin que haya que operar un clúster. Cloud Run y ECS Fargate serían
igualmente válidos; los Dockerfiles no contienen nada específico de Azure.

---

## 2. Qué crea la plantilla

| Recurso | Exposición | Notas |
|---|---|---|
| Key Vault | — | Guarda la clave privada, la pública, el hash de la contraseña demo y `SERVICE_API_KEYS` |
| Container Registry | Red privada | `adminUserEnabled: false`; se usa identidad administrada |
| Container Apps Environment | — | Zona única (ver limitaciones) |
| Identidad administrada (usuario asignado) | — | Compartida por las cinco apps, con rol `AcrPull` |
| `auth-service` | **internal** | Único que recibe el par de claves |
| `qr-api` | **internal** | |
| `stats-api` | **internal** | |
| `orchestrator` | **external** | Único backend público; mínimo 2 réplicas |
| `mobile-web` | **external** | nginx sirviendo el export de Expo |

El modelo de seguridad está en la propia plantilla, no sólo en
`docker-compose.yml`: los tres backends tienen `external: false`, es decir que la
plataforma nunca les da una dirección pública. `allowInsecure: false` en un
entorno de producción impide además que un bearer token viaje en claro.

---

## 3. Requisitos previos

```bash
az login
az account set --subscription "<subscription-id>"
az bicep install          # sólo una vez
```

Permisos necesarios en el grupo de recursos: `Contributor` (o
`User Access Administrator` + `Network Contributor`).

---

## 4. Despliegue

### 4.1 Grupo de recursos y registro

```bash
export LOCATION=westeurope
export RG=interseguro-rg

az group create --name "$RG" --location "$LOCATION"
```

### 4.2 Parámetros

`deploy/main.parameters.json` usa marcadores `${...}` que el pipeline sustituye.
Para un despliegue manual:

```bash
export ACR_LOGIN_SERVER="$(az acr show --name interseguro --query loginServer -o tsv)"

cat > /tmp/params.json <<EOF
{
  "\$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "location":                  { "value": "$LOCATION" },
    "environmentName":           { "value": "interseguro-env" },
    "namePrefix":                { "value": "interseguro" },
    "containerRegistryServer":   { "value": "$ACR_LOGIN_SERVER" },
    "isProduction":              { "value": true },
    "corsOrigins":               { "value": "https://PLACEHOLDER.azurecontainerapps.io" },
    "keyVaultAccessPolicies":    { "value": [] },
    "tags": { "value": { "application": "interseguro", "managedBy": "bicep" } }
  }
}
EOF
```

`corsOrigins` es un parámetro y no una referencia a la URL del front porque el
front, a su vez, necesita la URL del orquestador: derivarlo crearía un ciclo de
dependencias. En el primer despliegue se pone un valor cualquiera y, cuando el
front exista, se vuelve a desplegar con su URL real (es el único dato que
`deploy/README.md` no puede conocer de antemano).

### 4.3 Validar antes de aplicar

```bash
bicep build deploy/main.bicep --stdout > /dev/null   # debe salir sin errores
```

### 4.4 Aplicar

```bash
az deployment group create \
  --resource-group "$RG" \
  --template-file deploy/main.bicep \
  --parameters @/tmp/params.json
```

La salida incluye `orchestratorUrl` y `mobileWebUrl`.

### 4.5 Secretos

Se crean **después** del despliegue, porque Key Vault debe existir primero:

```bash
# Clave RSA de 2048 bits para firmar los tokens.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem

# Hash argon2id de la contraseña del usuario demo.
cd services/auth-service
node -e "
const argon2 = require('argon2');
argon2.hash(process.argv[1], { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
  .then((h) => console.log(h));
" 'CAMBIAR-ESTA-CONTRASENA'

cd ../..

for secret in jwt-private-key jwt-public-key service-api-keys demo-password-hash; do
  :
done

az keyvault secret set --vault-name interseguro-kv --name jwt-private-key  --value "$(cat private.pem)"
az keyvault secret set --vault-name interseguro-kv --name jwt-public-key   --value "$(cat public.pem)"
az keyvault secret set --vault-name interseguro-kv --name service-api-keys --value "$(openssl rand -base64 32)"
az keyvault secret set --vault-name interseguro-kv --name demo-password-hash --value '<hash argon2id>'
```

Nunca se commitean: ni el `.pem` ni el hash. En un despliegue real estos valores
llegarían desde el pipeline o desde un gestor de secretos, no desde un
terminal.

### 4.6 Construir y subir las imágenes

```bash
export ACR_LOGIN_SERVER="$(az acr show --name interseguro --query loginServer -o tsv)"
az acr login --name interseguro

for svc in auth-service qr-api stats-api orchestrator; do
  docker build -t "$ACR_LOGIN_SERVER/$svc:latest" "services/$svc"
  docker push "$ACR_LOGIN_SERVER/$svc:latest"
done

docker build -t "$ACR_LOGIN_SERVER/mobile-web:latest" apps/mobile
docker push "$ACR_LOGIN_SERVER/mobile-web:latest"
```

Cada app toma la etiqueta `:latest` de la plantilla, así que un `push` seguido
de un redeploy es suficiente.

### 4.7 Verificar

```bash
BASE_URL="$(az deployment group show -g "$RG" -n main --query properties.outputs.orchestratorUrl.value -o tsv)" \
  ./scripts/smoke.sh
```

El `smoke.sh` comprueba además que los puertos internos **no** son alcanzables
desde fuera, que en ACA es una propiedad de la plataforma y no una regla de
firewall.

---

## 5. Qué haría falta antes de un despliegue real

Nada de esto está implementado, y es deliberado: son las limitaciones
conocidas del objetivo de nube de este ejercicio.

- **Certificados TLS gestionados.** ACA termina TLS, pero el dominio
  personalizado y el certificado quedan por configurar. Hoy `transport: 'http'`
  deja el TLS en manos de la plataforma con su certificado por defecto.
- **Alta disponibilidad zonal.** `zoneRedundant: false`. Con `true` la plantilla
  sobrevive a la pérdida de una zona, a costa de coste y de capacidad reservada.
- **Key Vault con `publicNetworkAccess: 'Disabled'`** y punto de conexión
  privado: hoy la red pública del vault es alcanzable desde Internet, y su
  protección real depende de que las secretos no se puedan *enumerar*.
- **Autenticación de los contenedores hacia Key Vault.** La identidad
  administrada tiene rol sobre el registro, pero falta concederle el acceso de
  *secret user* sobre los tres secretos concretos.
- **Registros con IA y Private Link**, para que el flujo de despliegue sea
  reproducible sin permitir el acceso público.

---

## 6. Alternativas

- **Google Cloud Run.** El equivalente más cercano. No cambia nada en los
  Dockerfiles.
- **AWS ECS Fargate.** Requiere un ALB y un service discovery para el ingress
  interno; más piezas que ACA para el mismo resultado.
- **Kubernetes.** Excesivo para cinco servicios sin estado. Es lo que se elegiría
  si hiciera falta mTLS entre servicios (ver la lista de "siguientes pasos" en
  `docs/INTERVIEW.md`).
