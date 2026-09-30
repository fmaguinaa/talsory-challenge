# ADR-005: Validación de tokens por un servicio aparte

- **Estado**: Aceptado
- **Fecha**: 2026-09-29

## Contexto

Hay cuatro backends y sólo uno emite tokens. Cada uno tiene que decidir si una
petición viene autenticada. Hay tres formas de resolverlo:

1. **Verificar la firma localmente** con la clave pública (JWKS).
2. **Preguntar al emisor** en cada petición (introspección, RFC 7662).
3. **Confiar en que quien llama ya verificó**, es decir, que el orquestador
   autentica y los backends no.

## Decisión

Se eligió la **introspección contra un servicio de autenticación aparte**, con
tres refinamientos que la convierten en viable.

### Fail-closed

Si `auth-service` no responde, agota el tiempo de espera (1,5 s por defecto) o
devuelve algo inesperado, la petición se rechaza con **503**, nunca con 401 y
nunca con un pase.

La distinción es deliberada y es lo que separa un buen sistema de uno que
produce un bucle infinito de re-login: un 401 dice "tu token está mal, vuelve a
autenticarte"; un 503 dice "no he podido comprobarlo, inténtalo más tarde". Si se
confunden, un `auth-service` caído manda a todos los usuarios a la pantalla de
login en bucle, y no hay forma de que el sistema se recupere solo.

### Caché en memoria, con TTL corto y clave digest

Cada backend guarda las respuestas **positivas** durante
`AUTH_CACHE_TTL_SECONDS` (30 s por defecto), con dos límites:

- El TTL nunca supera lo que le queda de vida al propio token: una entrada
  expira en `min(TTL, exp - ahora)`. Sin esto, la caché podría mantener activo
  un token muerto, que es una vulnerabilidad y no una optimización.
- **Sólo se cachean las respuestas positivas.** Cachear un `active: false`
  significaría seguir rechazando un token que se ha reemitido legítimamente
  después.

La clave es el **SHA-256 del token**, nunca el token: un volcado de memoria del
proceso no debe revelar credenciales utilizables.

El caché es **por instancia**, así que la latencia de revocación está acotada
por el TTL, no es inmediata. Es un intercambio consciente: se compra un salto de
red menos en cada petición autenticada a cambio de una ventana de hasta 30 s
durante la que un token revocado todavía se acepta.

### Propagación del token original

El orquestador **reenvía el token del cliente, sin transformar**, a `qr-api` y a
`stats-api`, y ambos lo validan por su cuenta.

Es decir: confianza cero. Cada servicio comprueba la revocación por sí mismo, de
modo que un token revocado se rechaza aunque la caché del orquestador diga lo
contrario, y aunque mañana alguien añadiera un servicio nuevo que se saltara la
comprobación por confianza. El coste es una introspección extra por petición,
que es exactamente lo que la caché de 30 s amortiza.

### El endpoint de introspección está protegido

`POST /auth/validate` exige una credencial de servicio (`X-Service-Key`,
comparada en tiempo constante). Sin ella, cualquiera que consiguió un token
podría preguntar por él, y ese endpoint es lo único que puede decir si un token
sigue siendo válido.

## Alternativas descartadas

**Verificación local con JWKS.** Descartada porque elimina la revocación: un
token sigue siendo criptográficamente válido hasta su `exp`, aunque el usuario
haya iniciado sesión en otro sitio o la cuenta se haya bloqueado. A cambio
ofrece menos latencia y un salto de red menos. Es la elección correcta cuando la
revocación no importa, que es la mayoría de las APIs públicas.

**Sólo el orquestador autentica.** Descartada por el mismo motivo que la
propagación del token: convierte al orquestador en un punto donde un error se
convierte en una brecha. Además obligaría a los backends a *confiar*, que es la
propiedad más difícil de recuperar cuando algo sale mal.

La ruta de evolution está abierta: `/.well-known/jwks.json` ya está publicado y
`AuthService` ya valida `iss`, `aud` y `exp`. Añadir verificación local como
*short-circuit* (aceptar si la firma cuadra, con la introspección sólo para
revocación) es un cambio local y no una reescritura. Está en la lista de
siguientes pasos de `docs/INTERVIEW.md`.

## Consecuencias

**A favor**

- La revocación es real y su latencia está acotada y medida (`AUTH_CACHE_TTL_SECONDS`).
- Ningún servicio confía en otro para autorizar.
- Un `auth-service` caído degrada el sistema de forma explícita y recuperable,
  en vez de dejarlo en un bucle de re-login.
- Rotar la clave de firma no invalida las cachés, porque la cachea la
  introspección, no la firma.

**En contra**

- Un salto de red por petición (mitigado por la caché) y un servicio más que
  desplegar y operar.
- La credencial de servicio es un secreto compartido entre cinco componentes.
  Con mTLS o con identidades por servicio sería más limpio; está en la lista de
  siguientes pasos.
- La caché es por instancia, así que con 10 réplicas hay 10 ventanas de
  revocación independientes. Es coherente con el objetivo de consistencia
  *eventual* que se acepta aquí.
