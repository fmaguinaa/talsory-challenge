# ADR-006: Sin base de datos

- **Estado**: Aceptado
- **Fecha**: 2026-09-29

## Contexto

El sistema autentica usuarios. La respuesta habitual es "tabla de usuarios".

## Decisión

**No hay base de datos.** Los usuarios se siembran desde variables de entorno en
el arranque (`AUTH_USERS`, o el par `DEMO_USERNAME` / `DEMO_PASSWORD_HASH`), y
el directorio es un `Map` en memoria.

## Por qué

1. **El requisito no lo pide.** El enunciado no menciona persistencia de
   usuarios. Añadirla sería añadir un sexto servicio, un esquema, migraciones, un
   plan de copias de seguridad y una política de retención, todo para storing
   un usuario de demostración.
2. **El alcance es una demostración con un solo objetivo técnico**: una
   factorización QR con sus estadísticas, sobre una arquitectura de servicios y
   un modelo de seguridad. Una base de datos compite por la atención de revisión
   con lo que se supone que se está evaluando.
3. **El puerto hace que sea barato añadirla después.**
   `UserDirectory` es una interfaz de una línea. Sustituir
   `InMemoryUserDirectory` por uno que consulte Postgres o un LDAP no toca el
   caso de uso, ni el controlador, ni los tests: sólo el adaptador y sus tests.

## Qué se acepta a cambio

- **No se pueden crear usuarios en caliente.** Cambiar el conjunto de usuarios
  exige reiniciar `auth-service`.
- **No hay historial.** No se sabe quién se autenticó ni cuándo, más allá de los
  logs.
- **Un reinicio pierde cualquier estado**, que en este caso es ninguno: los
  tokens siguen siendo válidos porque son firmados con una clave privada que
  viene de Key Vault y sobrevive al reinicio.

## Cuando se revisaría esta decisión

En cuanto exista un segundo usuario real, o un requisito de alta o baja de
usuarios, o una necesidad de auditoría. En ese momento la respuesta es escribir
un `SqlUserDirectory` que implemente `UserDirectory`, cambiar la línea de
composición en `main.ts` y añadir la variable de conexión. La estructura ya
está preparada para eso; la decisión aquí es de *alcance*, no de *arquitectura*.
