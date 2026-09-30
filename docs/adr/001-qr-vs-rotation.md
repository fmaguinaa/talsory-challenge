# ADR-001: Factorización QR en lugar de "rotación"

- **Estado**: Aceptado
- **Fecha**: 2026-09-29

## Contexto

El enunciado del reto es ambiguo en un punto concreto. La diapositiva de
arquitectura describe que la API en Go *"rota la matriz"*, mientras que la
diapositiva funcional pide *"devolver la factorización QR"*.

"Rotar" y "factorizar" son cosas distintas:

- Una **rotación** (descomposición QR, descomposición de Schur o descomposición
  de valores singulares) devuelve una matriz ortogonal y una triangular. En la
  práctica, casi todo el mundo llama "rotación" a la descomposición QR, porque
  es la que se usa para pasar de una imagen a un sistema de coordenadas
  rotado.
- Una **factorización QR** devuelve explícitamente dos matrices: `Q` ortogonal
  (`m x m`, con `Qᵀ·Q = I`) y `R` triangular superior (`m x n`), con
  `A = Q·R`.

El PDF además dice que la API en Node *recibe las matrices devueltas por la API
en Go* y calcula estadísticas sobre ellas. En plural. Una rotación devuelve un
único producto; una factorización devuelve dos. El enunciado, leído entero,
describe la factorización.

## Decisión

Se implementa la **factorización QR completa**: para una matriz `A` de dimensión
`m x n` se devuelve `Q` de `m x m` y `R` de `m x n`, con `A = Q·R`, `Q` ortogonal
y `R` triangular superior.

Se opta por la forma **completa** y no por la reducida ("thin"/"core") porque:

1. Es la que no es ambigua para matrices anchas (`m < n`), donde la
   descomposición reducida no está bien definida tal cual.
2. Permite comprobar las dos propiedades por separado (`Qᵀ·Q = I` y
   `R` triangular), que son aserciones mucho más fuertes que "el producto se
   parece a la entrada".
3. El enunciado habla de "las matrices" en plural, y `Q` y `R` se calculan y se
   etiquetan por separado en la respuesta.

La convención de signos que se produce es la de LAPACK, y se documenta en
[ADR-003](003-householder-and-tolerances.md).

## Consecuencias

**A favor**

- El producto `Q·R` reconstruye la entrada, lo que da una comprobación
  verificable de extremo a extremo en `scripts/smoke.sh`.
- Las dos matrices tienen significados distintos e interpretables, y la
  estadística por matriz (`perMatrix` en stats-api) tiene algo que distinguir.
- Funciona para cualquier forma: cuadrada, alta (`m > n`) y ancha (`m < n`).

**En contra**

- Para una matriz alta, `Q` es mucho más grande que la entrada: una `100 x 3`
  produce una `100 x 100`. El coste de memoria de la respuesta crece con `m²`.
  Con `MAX_MATRIX_DIM = 100` el peor caso son 10 000 números, lo cual es
  aceptable pero no es gratis. Si hiciera falta, la forma reducida sería el
  siguiente paso natural.
- Al no seguir literalmente la palabra "rotar" de la diapositiva de
  arquitectura, hay una divergencia con el PDF que un revisor podría notar. Se
  asume que la especificación funcional manda sobre la ilustrativa, que es lo
  habitual, y que además coincide con el plural de la parte de Node.
