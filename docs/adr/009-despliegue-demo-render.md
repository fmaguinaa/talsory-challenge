# ADR-009: Despliegue de demostración en Render

- **Estado**: Aceptado
- **Fecha**: 2026-09-29

## Contexto

[ADR-008](008-cloud-target-and-deployment-strategy.md) fija Azure Container Apps
como objetivo de nube del reto, con Bicep en `deploy/main.bicep`. Eso resuelve el
requisito "despliegue en la nube" y el objetivo de diseño de dejar los tres
backends inalcanzables desde Internet.

Aparece una segunda necesidad que ACA no cubre: que el ejercicio sea **visible y
probable por quien lo revise**, sin tarjeta de crédito, sin suscripción y sin
coste. La plantilla de ACA no se ha ejecutado nunca contra una suscripción real,
así que hoy no hay ninguna URL que enseñarle a nadie.

## Decisión

**Añadir un despliegue de demostración en Render a coste cero** (blueprint en
`deploy/render/render.yaml`), *además de* Azure Container Apps, que sigue siendo
el objetivo de nube del reto.

No sustituye a ACA: son dos cosas distintas con propósitos distintos. ACA es lo
que se presenta como diseño de producción; Render es lo que se abre en el
navegador durante una entrevista.

## Por qué Render y no otra cosa

La restricción real no es "que soporte Docker", que casi todo lo hace, sino
**que soporte cinco contenedores que se hablan por HTTP con una red interna y un
único punto de entrada público**.

- **Render Hobby (gratis)** permite los cinco servicios como `web service` desde
  un único monorepo, con `render.yaml` como IaC versionada, dominios
  `*.onrender.com` sin configuración y sitio estático con CDN incluido.
- **Netlify, Vercel y Cloudflare** ejecutan **un** servicio. No hay forma de
  desplegar cinco contenedores ni de mantenerlos en una red interna: la decisión
  queda descartada por arquitectura, no por precio.
- **Cloud Run** encaja técnicamente mejor (ingress interno y tokens de identidad
  entre servicios), pero exige una cuenta de facturación con tarjeta, y no es
  "coste cero" en el sentido que importa aquí.
- **Fly.io** tiene red privada entre máquinas, pero su plan gratuito es una
  prueba de 2 horas o 7 días y luego exige tarjeta. Para un enlace que tiene que
  vivir meses, no sirve.

## Consecuencias

**A favor**

- Coste cero y sin tarjeta, y una URL que se puede enseñar.
- El blueprint es un fichero más en el repositorio: se revisa igual que el
  Bicep, y el paso de un entorno a otro es un `git push`.
- `render.yaml` no depende de nada específico de Render en el código: los
  Dockerfiles no cambian.

**En contra, y sin resolver**

- **La red privada se pierde.** En el plan gratuito no existe el tipo de servicio
  privado (`pserv` es de pago) y los servicios gratuitos no aceptan tráfico de
  red privada. Los tres backends quedan alcanzables desde Internet en
  `*.onrender.com`. Siguen exigiendo bearer token y `X-Service-Key`, así que no
  es una vía de acceso, pero es más superficie expuesta que la que afirma el resto
  del repositorio. **Es el coste real de esta decisión y hay que decirlo cuando
  se presente el proyecto.**
- **750 horas de instancia gratuitas al mes, compartidas.** Cinco servicios
  despiertos consumen 3600 h. Por eso el plan **no** mantiene nada despierto: es
  la razón por la que un "ping" periódico destruiría el enlace a mitad de mes.
- **La primera petición tarda entre 2 y 4 minutos.** Los servicios gratuitos se
  duermen a los 15 minutos y tardan ~1 minuto en despertar. Se compensa subiendo
  `AUTH_VALIDATE_TIMEOUT_MS` y `DOWNSTREAM_TIMEOUT_MS` a 90 s **en este
  despliegue**, lo que relaja el fail closed de [ADR-005](005-token-validation.md)
  durante el arranque. Sigue fallando cerrado; sólo que con más paciencia, y sin
  tocar el código.
- **`scripts/smoke.sh` mide menos en Render que en local.** Su comprobación de
  que los internos no son alcanzables sigue pasando porque los puertos no están
  publicados, pero ya no está verificando el aislamiento de la red.
- **Sin TLS propio, sin shell, sin discos, sin escalado** en plan gratuito. Nada
  de eso lo necesita el sistema, que es stateless por diseño
  ([ADR-006](006-no-database.md)).
- **La plantilla no se ha ejecutado.** No hay URL viva y no debe inventarse una.