# ADR-008: Objetivo de nube y estrategia de despliegue

- **Estado**: Aceptado
- **Fecha**: 2026-09-29

## Contexto

El reto pide despliegue en la nube. La elección afecta a la forma del Dockerfile
y a cuánta infraestructura hay que escribir.

## Decisión

**Azure Container Apps**, con IaC en **Bicep**, en `deploy/main.bicep`.

## Por qué ACA y no otra cosa

El sistema ya es cinco contenedores sin estado que necesitan escalar de forma
independiente y que no se hablan entre sí salvo por HTTP. ACA da exactamente
eso:

- **Ingress por aplicación**, con `external: true` o `false`. El modelo de
  seguridad del sistema entero (tres backends inalcanzables desde Internet) se
  expresa en **una propiedad** de la plantilla en lugar de en un firewall.
- **Réplicas y escalado por aplicación**, sin gestionar un clúster.
- **Revisiones**, con reversión a la anterior si un despliegue sale mal.
- **Identidades administradas** con rol `AcrPull` sobre el registro: no hay
  contraseña de ACR guardada en ninguna parte.
- **Key Vault references**, que resuelven el secreto en tiempo de ejecución. El
  valor nunca aparece en el entorno de la revisión ni en un log de despliegue.

### Alternativas

- **Google Cloud Run.** El equivalente más cercano; la migración sería
  mínima. Se descarta sólo por afinidad con el resto del reto.
- **AWS ECS Fargate.** Requiere un balanceador y service discovery para
  conseguir el ingress interno: más piezas que ACA para el mismo resultado.
- **Kubernetes.** Correcto y necesario en cuanto haya mTLS entre servicios o
  más de una decena de servicios. Hoy son cinco, sin estado y sin necesidades de red
  particulares, así que sería operar un clúster para no ganar nada.

## Estrategia de despliegue

1. `bicep build` valida la plantilla **antes** de aplicar nada. Esta plantilla se
   compiló y revisó; **no se ha ejecutado** contra una suscripción real (ver
   `deploy/README.md`).
2. Las imágenes se construyen y suben etiquetadas por commit.
3. Key Vault se aprovisiona primero; los secretos se añaden después, porque el
   vault debe existir para poder referenciarlo.
4. Se despliega una segunda vez con el `corsOrigins` real del front, que no se
   conoce hasta que el front existe.

### Detalles que importan

- **`minReplicas: 2` en el orquestador.** Es el único backend público; con una
  sola réplica, un despliegue o un reinicio lo deja fuera de servicio.
- **`minReplicas: 1` en los backends.** Sin estado, y con `depends_on:
  service_healthy` en local, una réplica basta. Una más sería dinero gastado en
  una petición que llega una vez cada pocos segundos.
- **Probes sin dependencias.** `/health/live` y `/health/ready` no consultan
  `auth-service`. Si lo hicieran, un `auth-service` lento sacaría al
  orquestador de rotación y nadie podría entrar al sistema.
- **Registro con `adminUserEnabled: false`.** Cualquier pull se autentica con la
  identidad administrada.
- **CPU en milicores.** Es la unidad que usa Container Apps, y evita la
  ambigüedad de si `0.5` significa medio núcleo o algo distinto.

## Consecuencias

**A favor**

- El modelo de seguridad se lee en la plantilla, no en un documento aparte.
- Ningún secreto vive en el repositorio ni en la definición de la
  infraestructura.
- Cambiar de nube es reescribir `deploy/main.bicep`: los Dockerfiles no
  contienen nada específico de Azure.

**En contra, y sin resolver**

- **`zoneRedundant: false`.** Con `true` sobreviviría a la pérdida de una zona,
  a cambio de coste y capacidad reservada. Está expuesto como propiedad, no
  decidido.
- **El Key Vault tiene `publicNetworkAccess: 'Enabled'`.** Con red privada
  necesitaría un punto de conexión privado, lo que complica la identidad
  administrada de cada app.
- **Falta el rol de *secret user* en la identidad** para los tres secretos
  concretos; hoy está el rol sobre el registro pero no sobre el vault.
- **La plantilla nunca se ha aplicado.** Es lo más importante que queda por
  verificar, y está dicho en `deploy/README.md` y aquí.

## Añadidos posterior

Esta decisión no se revisa, pero se le ha añadido un despliegue que no la
contradice: `deploy/render/` publica una demostración a coste cero en Render, con
un objetivo distinto (que el ejercicio sea visible sin pagar ni dar de alta una
tarjeta) y consecuencias distintas, en particular la pérdida de la red privada en
el plan gratuito. Ver [ADR-009](009-despliegue-demo-render.md).
