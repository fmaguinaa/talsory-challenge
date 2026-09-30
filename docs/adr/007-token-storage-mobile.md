# ADR-007: Dónde se guarda el token en el cliente Expo

- **Estado**: Aceptado
- **Fecha**: 2026-09-29

## Contexto

La aplicación es una sola base de código que corre en iOS, Android y web (el
mismo export web se sirve desde nginx en Docker). El token es un **bearer
token**: quien lo posee es el usuario. Dónde se guarde decide qué obtiene un
atacante.

## Decisión

- **iOS y Android**: `expo-secure-store`, con `WHEN_UNLOCKED`. La clave va al
  llavero del sistema (iOS) o al almacén de claves cifrado del hardware (Android).
- **Web**: **sólo en memoria**, más `sessionStorage` cuando existe.

**`localStorage` no se usa nunca.** Es la regla dura de este ADR.

## Por qué

### Por qué no `localStorage` en web

`localStorage` es accesible desde **cualquier script que se ejecute en el
mismo origen**. Eso convierte una sola vulnerabilidad XSS —una dependencia con una
dependencia transitiva vulnerable, un `innerHTML` sin escapar— en el robo
completo de la sesión del usuario. Además sobrevive al cierre de la pestaña, así
que un token robado sigue siendo válido días después.

El coste de no usarlo es real y hay que decirlo: **el usuario pierde la sesión
al recargar la página**. Para este caso es aceptable. Volver a pedir la
contraseña es preferible a dejar una credencial utilizable al alcance de
cualquier script inyectado.

`sessionStorage` es el compromiso: también es legible por scripts del mismo
origen, pero desaparece al cerrar la pestaña. La exposición no empeora respecto a
una variable en memoria, y a cambio el usuario no pierde la sesión en cada
recarga dentro de la misma pestaña.

`sessionStorage` puede lanzar en el modo privado de Safari en lugar de devolver
`null`. Por eso todo el acceso va con `try/catch` y hay un respaldo en memoria:
que el navegador bloquee el almacenamiento no puede impedir que el usuario
mantenga la sesión durante la visita en curso.

### Por qué `expo-secure-store` y no `AsyncStorage` en nativo

`AsyncStorage` guarda en un directorio de la aplicación sin cifrar: en un
dispositivo rooteado o con un backup extraíble, el token se lee directamente. El
almacén de claves del sistema cifra en reposo y puede atarse al estado de
bloqueo del dispositivo, que además de ser más seguro es lo que espera un
usuario al abrir la app en el dispositivo de otra persona.

### La clave se borra

Un 401 es la única señal que el cliente recibe del backend de que su
token dejó de ser válido. La app responde **cerrando la sesión y volviendo al
login**, no mostrando un error. Dejar al usuario en una pantalla cuyas acciones
todas van a fallar es peor que devolverle al principio.

## Consecuencias

**A favor**

- Un XSS en la versión web no da acceso directo al token.
- En nativo, el token está cifrado en reposo y no aparece en las copias de
  seguridad de la aplicación.
- La regla es comprobable: `localStorage` no aparece en ninguna parte del
  código.

**En contra**

- En web, recargar es cerrar sesión. Muchas SPAs asumen mal lo contrario;
  aquí se acepta conscientemente.
- `expo-secure-store` necesita un módulo nativo, así que el export web debe
  evitarlo en la ruta de ejecución. `createTokenStore()` decide por plataforma
  y el bundle web nunca llama a `SecureStore`.
- El estado de autenticación vive en el código y no en el servidor, así que no
  se puede revocar una sesión concreta sin esperar al TTL del token. Es la
  contrapartida de ser un token sin sesión en el servidor.
