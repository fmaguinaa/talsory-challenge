# Chuleta de entrevista

Una página: qué se decidió, por qué, y qué haría después. El detalle de cada
decisión está en [`docs/adr/`](adr/).

---

## La decisión de fondo

**El enunciado dice "rotación" en una diapositiva y "factorización QR" en otra.**
Implementé la factorización QR completa (`A = Q·R`, con `Q` `m×m` ortogonal y `R`
`m×n` triangular) por tres razones concretas:

1. La parte de Node del enunciado dice recibir *"las matrices"* devueltas por Go,
   **en plural**. Una rotación devuelve un producto; una factorización devuelve
   dos.
2. `A = Q·R` es una afirmación **verificable**, y la verifico en el smoke test:
   residual `2,8e-14`, ortogonalidad `6,7e-16`, triangularidad exacta. Una
   rotación no da nada comprobable.
3. La QR cubre **cualquier forma** (cuadrada, alta, ancha). Una "rotación" de QR
   está definida sólo para matriz cuadrada.

→ [ADR-001](adr/001-qr-vs-rotation.md)

---

## Arquitectura en una frase

**El orquestador posee el flujo; ningún backend conoce a otro.**

```
front ──► orchestrator ──► qr-api
              ├──────────► stats-api
              └──────────► auth-service   (validación de tokens)
```

Descarté el flujo Go → Node del PDF porque obliga al servicio en Go a saber la
URL y el formato de entrada de Node: acoplamiento entre dos servicios que no
comparten código. El orquestador añade un salto de red y a cambio da un único
sitio donde está el orden de las llamadas y donde se traducen los errores.

→ [ADR-002](adr/002-orchestrator-driven-flow.md)

---

## Las cinco decisiones que más se discuten

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| **Householder**, no Gram-Schmidt | Gram-Schmidt modificado | Pierde ortogonalidad de forma acumulativa; con columnas casi dependientes da resultados inútiles. Householder es ortogonal por construcción. ~3 ms para 100×100, el coste es irrelevante. |
| **Signos de LAPACK** (diagonal de `R` puede ser negativa) | Normalizar a positiva | Exige un recorrido extra sobre `Q`, que es la parte cara, y deja de coincidir con cualquier librería con la que comparar. |
| **"Diagonal" con `ε = 1e-9`** | Igualdad exacta | La salida de QR trae ceros que en realidad son `~1e-16`. Con igualdad exacta la bandera sería `false` justo en las matrices que el usuario espera ver
   marcadas, y no valdría nada. |
| **Introspección a auth-service**, no verificación local con JWKS | JWKS | Elimina la revocación. Un token sigue siendo válido hasta su `exp` aunque se haya revocado la sesión. |
| **Sin base de datos** | Tabla de usuarios | El enunciado no la pide. Añadirla son seis servicios, migraciones y backups para storing un usuario de demo. El puerto `UserDirectory` hace que añadirla después sea una línea. |

→ [ADR-003](adr/003-householder-and-tolerances.md) · [ADR-004](adr/004-diagonal-definition.md) · [ADR-005](adr/005-token-validation.md) · [ADR-006](adr/006-no-database.md)

---

## Seguridad: lo que hace que el diseño aguante

**Tres decisiones, y las tres tienen un porqué que sobrevive al "¿y si?":**

1. **Fail-closed con `503` distinguido del `401`.** Si `auth-service` no
   responde, la petición se rechaza con **503**, nunca con 401. Un 401 dice
   "vuelve a autenticarte"; si una caída de `auth-service` produjera 401, todos
   los usuarios entrarían en un bucle infinito de re-login del que el sistema no
   puede salir solo. Es el fallo más caro que un diseño de autenticación puede
   tener, y cuesta un `case` en el clasificador de errores.

2. **El token del cliente se propaga sin transformar.** El orquestador reenvía el
   token original a `qr-api` y a `stats-api`, y cada uno lo valida por su cuenta.
   Confianza cero: un token revocado se rechaza aunque la caché del orquestador
   diga lo contrario, y aunque mañana alguien añadiera un servicio que se saltara
   la comprobación. El coste es una introspección extra, que es lo que amortiza
   la caché de 30 s.

3. **El caché sólo guarda respuestas positivas, y nunca sobrevive al token.**
   La entrada dura `min(30 s, exp - ahora)`. Cachear un `active: false`
   significaría seguir rechazando un token reemitido legítimamente. La clave es
   el **SHA-256** del token, nunca el token: un volcado de memoria no debe
   revelar credenciales.

Además: `SERVICE_API_KEYS` en tiempo constante con relleno a longitud fija
(`timingSafeEqual` devuelve antes si las longitudes difieren, lo que filtraría
la longitud); usuario desconocido ejecuta igualmente una verificación argon2
(realista) para que el tiempo de respuesta no revele qué usernames existen;
`alg=none` y el downto a HS256 con la clave pública como secreto HMAC están
ambos rechazados porque el verificador fija RS256 en vez de confiar en el
`alg` del token; y en web **nunca** `localStorage`.

→ [ADR-005](adr/005-token-validation.md) · [ADR-007](adr/007-token-storage-mobile.md)

---

## Complejidad

| Operación | Complejidad | Nota |
|---|---|---|
| QR (Householder) | **O(m·n²)** | `min(m,n)` reflectores, cada uno un recorrido sobre el bloque activo. `100×100` en ~3 ms, 8 asignaciones |
| Estadísticas | **O(total)** | Una sola pasada, memoria constante; la suma global se acumula en un único `CompensatedSum` y **no** sumando las sumas por matriz, que reintroduciría el error que el acumulador compensado elimina |
| Caché de tokens | O(1) | `Map` con SHA-256 como clave, máximo 4096 entradas |
| Validación | O(m·n) | Recorre la matriz hasta el primer error, para que el mensaje sea accionable |

**Por qué suma compensada.** `1e16 + (-1e16) + 1` con `sum += x` da `0`; con
Neumaier da `1`. Las matrices que llegan a stats-api son factores QR, cuyas
entradas abarcan muchos órdenes de magnitud y cuya diagonal es negativa, así que
los términos grandes se cancelan con los pequeños constantemente. Reportar una
suma incorrecta en un servicio cuyo trabajo *es* reportar números correctos sería
un fallo silencioso. Se usa **Neumaier** y no Kahan a secas porque Kahan falla
justo cuando el acumulador es menor que el valor que se suma, que es el caso
habitual aquí.

---

## Qué haría después, en orden

1. **Refresh tokens.** Hoy el token dura 15 minutos y hay que volver a
   autenticarse. Es un sistema de autenticación entero, y decidir cuándo
   refrescar (al expirar, proactivamente, o en segundo plano) cambia la UX más
   que ninguna otra cosa de esta lista.
2. **mTLS entre servicios.** La identidad del servicio la daría el handshake y el
   secreto compartido `SERVICE_API_KEYS` desaparecería. Hoy la frontera es la red
   interna más un secreto compartido por cinco componentes.
3. **OpenTelemetry.** El `X-Request-Id` ya permite seguir una petición por los
   logs, que es lo que hace útil el smoke test. Falta duración por dependencia y
   trazas; con cinco servicios en cadena, ver dónde se va el tiempo es lo primero
   que optimaría.
4. **Tests de contrato en CI generados desde OpenAPI.** Hoy los contratos se
   validan y un test comprueba que rutas y códigos coinciden con lo implementado,
   pero las peticiones no se validan contra el esquema en ejecución.
5. **Base de datos**, en cuanto haya un segundo usuario real o requisitos de
   auditoría. El puerto `UserDirectory` ya está preparado: es un adaptador nuevo,
   no un rediseño.
6. **Rotación de claves sin reinicio.** Hoy `kid` permite publicar un JWKS nuevo,
   pero el servicio carga el par al arrancar. Con dos pares aceptados
   simultáneamente, la rotación dejaría de ser un evento.

---

## Lo que este diseño hace *mal*, dicho claramente

- **La plantilla de Bicep nunca se ha ejecutado.** Compila y el ARM está
  revisado, pero no hay despliegue real. Es lo primero que verificaría.
- **`401` y revocar.** La caché es de 30 s por instancia; con diez réplicas hay
  diez ventanas. Aceptable para consistencia eventual, pero si el requisito
  fuese "revocar en menos de un segundo", es otra respuesta.
- **`Q` responde `m²` números.** Una matriz `100×3` devuelve una `100×100`. Con
  el límite actual son 10 000 números, aceptable; con un límite mayor, la forma
  reducida es lo natural.
- **En web, recargar cierra sesión.** Es el precio de no usar `localStorage`, y
  lo asumo conscientemente.
- **NestJS quedó en 11, no en 12**, porque 12 exige TypeScript 6 y la cadena de
  lint todavía no lo soporta. Preferí una combinación coherente y verificada a la
  última versión de una pieza; el coste son 2 avisos moderados transitivos en
  `@nestjs/swagger`, en una ruta que el sistema no ejercita.

---

## Cómo demostrarlo en cinco minutos

```bash
cp .env.example .env
./scripts/gen-dev-keys.sh
docker compose up --build --wait
./scripts/smoke.sh
```

`smoke.sh` comprueba, contra el stack real: los tres invariantes numéricos de la
factorización, la coherencia de las estadísticas, que los cuatro tipos de token
inválido (ausente, alterado, con estructura inválida, credenciales incorrectas)
son rechazados, que un `422` nombra la fila exacta, y que **los puertos de los
tres backends están cerrados desde el host**. Esa última comprobación es la que
convierte el diagrama de redes en una propiedad verificada.
