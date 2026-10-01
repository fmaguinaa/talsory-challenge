# Despliegue en Render (demostración pública, coste cero)

Plan para publicar el sistema completo en <https://render.com> sin pagar nada,
para que el recruitment team pueda probarlo desde el navegador.

> **Estado: plan escrito, no ejecutado.** No hay credenciales de Render ni
> despliegue real detrás de estas instrucciones. No existe ninguna URL viva y no
> debe inventarse una. Cuando se ejecute, esta cabecera cambia a "ejecutado" y
> se pegan aquí las URLs reales.
>
> La diferencia con `deploy/README.md` (Azure) es intencionada: **la IaC
> principal del reto sigue siendo Azure Container Apps** ([ADR-008](../../docs/adr/008-cloud-target-and-deployment-strategy.md)).
> Render es *además* un despliegue de demostración a coste cero. El desvío y sus
> consecuencias están en [ADR-009](../../docs/adr/009-despliegue-demo-render.md).

---

## 1. Qué se despliega

| Servicio | Tipo en Render | Puerto | Notas |
|---|---|---|---|
| `auth-service` | web service (docker) | 10000 | Emite e introspecta tokens |
| `qr-api` | web service (docker) | 10000 | Factorización QR |
| `stats-api` | web service (docker) | 10000 | Estadísticas |
| `orchestrator` | web service (docker) | 10000 | **Única API pública** |
| front (Expo web) | static site | — | CDN, nunca se duerme |

El front es un **sitio estático** y no un web service: no necesita CPU, no se
duerme y por eso es la primera cosa que el recruitment team ve funcionar.

---

## 2. Lo primero: qué NO puede hacer Render en plan gratuito

Conviene decirlo antes que descubrirlo desplegando. Estas cuatro limitaciones
son las que definen todo el plan, y ninguna se puede resolver con configuración.

### 2.1 No hay red privada entre servicios gratuitos

> "Free web services can't *receive* private network traffic."

En el plan gratuito **no existe el tipo de servicio privado**: `pserv` es de
pago. Por tanto los cuatro backends reciben una URL pública
`https://talsory-qr.onrender.com` etc., y el orquestador los llama por Internet
en vez de por la red interna de `docker-compose.yml`.

Esto **degrada el modelo de seguridad** que el resto del repositorio afirma:
en `docker-compose.yml` y en la plantilla de ACA los tres backends son
inalcanzables desde Internet; aquí no lo son.

Lo que **no** se degrada es la autorización: `qr-api`, `stats-api` y
`auth-service` siguen exigiendo un bearer token válido, y la introspección sigue
exigiendo `X-Service-Key`. Queda más superficie expuesta, no una vía de acceso.

### 2.2 750 horas de instancia gratuitas al mes, **compartidas**

Render concede 750 `free instance hours` por workspace y mes. Los servicios
dormidos no las consumen.

| Escenario | Horas/mes | ¿Cabe? |
|---|---|---|
| 5 servicios despiertos 24/7 | 5 × 720 = **3600** | **No.** Agota el presupuesto en ~6 días y Render **suspende todos** los servicios gratuitos hasta el mes siguiente |
| 5 servicios dormidos, ~30 visitas al mes | ~25 h/mes | **Sí**, con holgura |

Esta tabla es la razón de que el plan **no** incluya nada que mantenga los
servicios despiertos. Un "ping" periódico para mantenerlos calientes es
exactamente lo que hace que el enlace del portfolio se caiga a mitad de mes.

### 2.3 Los servicios gratuitos se duermen a los 15 minutos

Despiertan con la siguiente petición, en **~1 minuto**. No es un detalle
cosmético: es el problema técnico más serio del despliegue (sección 4).

### 2.4 Sin shell, sin discos persistentes, sin escalado

No hace falta nada de eso para este sistema, que es stateless por diseño
([ADR-006](../../docs/adr/006-no-database.md)). Se anota sólo para que conste que
se revisó.

---

## 3. Requisitos previos

1. Cuenta en Render (workspace **Hobby**, gratuito) y el repositorio público en
   `https://github.com/fmaguinaa/talsory-challenge`.
2. Generar el material de claves **en local**, para subirlo al panel. Nunca en el
   repositorio:

   ```bash
   ./scripts/gen-dev-keys.sh
   ./scripts/render-secrets.sh
   ```

   El segundo comando imprime los cuatro valores ya listos para pegar en el
   panel, junto con el porqué de **no** pegarlos directamente desde
   `.env.dev-keys` (sección 5.2).
3. Desactivar "Allow unlisted public repositories" si el repo es privado; con
   repo público no hace falta.

---

## 4. El problema del arranque en frío, y cómo lo resuelve el plan

Este es el trabajo real de este despliegue y conviene entenderlo.

El orquestador llama a `qr-api` y a `stats-api` con
`DOWNSTREAM_TIMEOUT_MS=3000`, y todos validan tokens llamando a `auth-service`
con `AUTH_VALIDATE_TIMEOUT_MS=1500`. Esos 1500 ms están elegidos a conciencia:
si el servicio de autenticación no responde **rápido**, es que no va a
responder, y el sistema falla cerrado con un `503` (ver
[ADR-005](../../docs/adr/005-token-validation.md)).

En local, esa política es correcta: los backends están a un milisegundo de
distancia. En Render gratuito los cuatro están **dormidos**, y un arranque en
frío de Node puede tardar 20–40 s. Con los valores por defecto, la primera
petición de cada visita fallaría así:

| Paso | Qué ocurre | Resultado con los valores por defecto |
|---|---|---|
| El visitante abre el front | sitio estático | correcto |
| `POST /auth/login` | orquestador dormido → ~60 s | Render espera y responde |
| el orquestador valida el token | `auth-service` dormido → ~30 s | **`503`** (fail closed a los 1500 ms) |
| `POST /matrix/analyze` | orquestador despierto, `qr-api` dormido | **`504`** (timeout a los 3 s) |

La solución es **subir los timeouts en este despliegue**, sin tocar el código:
en `render.yaml`, `AUTH_VALIDATE_TIMEOUT_MS=90000` y
`DOWNSTREAM_TIMEOUT_MS=90000` en los servicios afectados.

Qué cuesta y qué no cuesta:

- **Se relaja el fail closed.** El sistema pasa a esperar hasta 90 s a
  `auth-service` antes de declarar `503`. Sigue fallando cerrado, sólo que con
  más paciencia. Es un commitment de *configuración* al entorno, no un cambio de
  política: el límite de 1500 ms sigue siendo el correcto para el resto del
  sistema.
- **No es un cambio de código**, así que la política de seguridad sigue siendo la
  de [ADR-005](../../docs/adr/005-token-validation.md) y sus tests siguen
  valiendo.

Experiencia resultante: la **primera** petición tras 15 min de inactividad tarda
entre 2 y 4 minutos (el visitante ve la página de "starting up" de Render). Las
peticiones siguientes durante los siguientes 15 minutos son instantáneas, porque
la cadena entera queda caliente. No es una experiencia de producto; es el precio
de no pagar.

---

## 5. Despliegue

### 5.0 Se crea con un Blueprint, no con cinco servicios a mano

Render ofrece dos caminos y aquí sólo sirve uno:

| Camino | ¿Sirve? |
|---|---|
| Crear un "Web Service" → Dockerfile → repetir cinco veces | **No.** Habría que escribir a mano el directorio de cada uno, el contexto de build, las variables y las URLs cruzadas, y nada quedaría en el repositorio. Además las URLs no se conocen hasta que existen: cada servicio necesita la URL de los otros, y ese problema se repite cinco veces. |
| **New → Blueprint**, indicando `render.yaml` | **Sí.** Un solo fichero declara los cinco servicios, sus entornos y cómo se referencian entre sí. Es IaC versionada y revisable en un pull request. |

Los subdominios se pueden conocer **antes** del primer despliegue: Render deriva
la URL del `name` del servicio. De ahí los nombres `talsory-*` del blueprint y las
URLs fijadas en `QR_API_URL`, `STATS_API_URL` y `CORS_ORIGINS`. Si alguno ya
estuviera ocupado, Render añadirá un sufijo y habrá que corregir esas tres
variables.

### 5.1 Crear el blueprint

1. Sube el código a GitHub primero (`git push -u origin master`). Render
   despliega desde el repositorio, no desde el disco local.
2. En <https://dashboard.render.com>: **New → Blueprint**.
3. **Connect repository** → elige `fmaguinaa/talsory-challenge`.
4. En **Blueprint Path** escribe `deploy/render/render.yaml`.
   **No está en la raíz del repo** a propósito: la convención del proyecto es que
   la IaC viva en `deploy/`. Si Render no encuentra el fichero, es esto.
5. Pulsa **Apply**. En el valor de *Region* acepta `Oregon`.

Aparecen los cinco servicios y Render pide los valores marcados `sync: false`.
Pégalos desde `./scripts/render-secrets.sh` (sección 5.2) y continúa.

Lo que verás después, con cada servicio en `Free`:

| Servicio | URL |
|---|---|
| front | `https://talsory-web.onrender.com` |
| orquestador | `https://talsory-orchestrator.onrender.com` |
| auth | `https://talsory-auth.onrender.com` |
| qr | `https://talsory-qr.onrender.com` |
| stats | `https://talsory-stats.onrender.com` |

Los cuatro web service tardan varios minutos en el **primer** despliegue: compilan
la imagen en la nube. El sitio estático es más rápido.

### 5.2 Secretos

El blueprint marca cuatro variables con `sync: false`. Render las pide en el
panel la primera vez que sincroniza; después quedan guardadas en el workspace y
no se vuelven a mostrar. Para obtenerlas:

```bash
./scripts/render-secrets.sh
```

**No las copies a mano desde `.env.dev-keys`.** Ese fichero está escrito para
docker compose, que interpola `$` incluso en los valores de `env_file`, así que
el hash sale con los dólares duplicados (`$$argon2id$...`). Render no interpola
nada, y el resultado falla de dos maneras:

- `auth-service` comprueba `startsWith('$argon2')` y **se niega a arrancar** con
  *"DEMO_PASSWORD_HASH must be an argon2id hash"*, un error que no señala su
  causa real.
- Si esa comprobación se saltara, `argon2` rechaza la cadena y
  `Argon2PasswordPort.verify` convierte la excepción en `false`: el login
  fallaría siempre, en silencio y sin log.

`render-secrets.sh` deshace ese escape y avisa antes de que llegues a Render con
un valor que no va a funcionar. Los dos PEM sí se pegan tal cual: ya son una
única línea con `\n` escapados, que es justo lo que Render espera, y
`normalizePem` los convierte de vuelta en saltos de línea reales.

La credencial de servicio **no** se introduce a mano: `SERVICE_API_KEYS` se
genera sola en `auth-service` (`generateValue: true`) y los otros tres la
referencian con `fromService`. Es importante que sea así: si cada servicio
generara su propia, los backends presentarían una credencial distinta a la que
`auth-service` acepta, y la introspección fallaría con un `401` sin explicación
útil.

### 5.3 Primer despliegue y verificación

```bash
BASE_URL=https://talsory-orchestrator.onrender.com ./scripts/smoke.sh
```

Advertencia sobre `scripts/smoke.sh` en Render: su comprobación de que los
servicios internos **no** son alcanzables sigue pasando (en Render los puertos
4000/8081/4001 no están publicados), pero **está midiendo menos de lo que
cree**. En local verifica que la red interna no tiene salida a Internet; en
Render lo único que verifica es que esos puertos no existen. La aislamiento real
que se pierde está en la sección 2.1, y conviene decirlo de forma explícita
cuando se presente el proyecto.

### 5.4 CORS y el ciclo de dependencias

El front necesita la URL del orquestador en tiempo de build, y el orquestador
necesita la URL del front para CORS. Con los nombres fijos el ciclo se resuelve
sola (`talsory-web.onrender.com` está escrito en `CORS_ORIGINS`), pero **en
cuanto se añada un dominio propio hay que redesplegar el orquestador** con:

```
CORS_ORIGINS=https://talsory-web.onrender.com,https://<dominio-propio>
```

Es el mismo problema que aparece en `deploy/README.md` para ACA, y por la misma
razón: `corsOrigins` es un parámetro, no una referencia.

---

## 6. Coste real

| Concepto | Coste |
|---|---|
| 4 web services `free` | 0 € |
| 1 static site | 0 € |
|registry | 0 € |
| Salida de red | Incluida (5 GB/mes en el plan Hobby; el surplus se factura o suspende el workspace si no hay tarjeta) |
| Minutos de pipeline | Incluidos (500/mes); los `buildFilter` del blueprint evitan recompilar los cinco servicios en cada commit |

El único escenario que cuesta dinero es que alguien deje los cinco servicios
despiertos: eso supera las 750 horas y Render factura o suspende.

---

## 7. Si el enlace tiene que estar disponible 24/7

El plan gratuito no lo garantiza, y conviene saber qué se pagaría antes de
decidirlo. La opción que **respeta la arquitectura** (los tres backends como
`pserv`, inalcanzables desde Internet) cuesta del orden de **15–20 €/mes**: tres
private services y un web service de pago. Con eso desaparecen los cuatro
problemas de la sección 2, porque un servicio privado no se duerme por tráfico
ausente... salvo que el presupuesto de la plataforma siga aplicando.

La alternativa sin coste alguno es un VPS gratuito (Oracle Cloud Always Free),
donde `docker compose up` funciona exactamente como en local y la red interna
sigue siendo real. Es lo que se recommendaría si el requisito fuese "el
recruitment team lo abre mañana y funciona".

---

## 8. Verificación previa a decir que funciona

```bash
# 1. El blueprint es válido contra el esquema oficial de Render.
pip install jsonschema pyyaml
python3 - <<'PY'
import json, urllib.request, yaml, jsonschema
schema = json.load(urllib.request.urlopen('https://render.com/schema/render.yaml.json'))
doc = yaml.safe_load(open('deploy/render/render.yaml'))
errs = list(jsonschema.Draft7Validator(schema).iter_errors(doc))
print("VALID" if not errs else errs)
PY

# 2. El flujo completo contra el despliegue.
BASE_URL=https://talsory-orchestrator.onrender.com ./scripts/smoke.sh
```

Regla de este repositorio que sigue vigente: **si no se ha ejecutado, no se
afirma que funciona**. Esta sección y la cabecera de este README son las que hay
que actualizar cuando se ejecute.