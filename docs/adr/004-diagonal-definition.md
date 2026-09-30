# ADR-004: Qué significa "diagonal" y por qué hace falta una tolerancia

- **Estado**: Aceptado
- **Fecha**: 2026-09-29

## Contexto

stats-api tiene que responder si alguna de las matrices recibidas es diagonal.
La definición de libro es "todos los elementos fuera de la diagonal son cero".
Tal cual, esa definición es inútil para el caso real de este sistema.

Las matrices que llegan a stats-api son `Q` y `R` de una factorización QR
calculada en coma flotante por otro servicio. Una matriz que es diagonal en
aritmética exacta llega aquí con ceros que en realidad son valores de orden
`1e-16` en posiciones matemáticamente iguales a cero. Una comprobación de
igualdad exacta informaría `isDiagonal: false` precisamente de las matrices que
el usuario espera ver marcadas, y la bandera no valdría nada.

## Decisión

Una matriz es diagonal si y sólo si:

1. Es **cuadrada** (`m == n`, con al menos 1 fila y 1 columna), **y**
2. todo elemento fuera de la diagonal satisface `|x| <= EPSILON`.

`EPSILON` vale `1e-9` por defecto y se configura con `DIAGONAL_EPSILON`.

#### Por qué `1e-9`

Es unas siete órdenes de magnitud por encima del ruido de `float64` (~`1e-16`)
para entradas de orden 1, y está dos órdenes por debajo de la precisión con la
que una persona lee un número en una pantalla. El margen es ancho a propósito:
el objetivo es absorber el ruido de la factorización, no tratar como cero un
valor que el usuario pueda ver.

### Casos límite, decididos explícitamente

- **`1 x 1`**: diagonal. No tiene elementos fuera de la diagonal, así que la
  condición se cumple vacuamente. Es lo que espera cualquiera.
- **No cuadrada**: nunca diagonal, aunque todas las entradas que no están
  en su diagonal principal sean cero. La forma es parte de la definición.
- **Tolerance `0`**: se acepta como configuración. Un despliegue que quiera
  igualdad exacta puede pedirla, aunque no es lo recomendado.

### Por qué no comparar contra cero con un `Math.abs(x) < 0.5` tipo "redondeo"

Porque el redondeo a un número fijo de decimales no distingue `1e-17` (ruido)
de `0.4` (un valor real). La tolerancia es una propiedad de la aritmética, no de
la presentación.

La misma lógica se aplica en el cliente, en `looksDiagonal`, para que la app
coincida con el servidor en lugar de contradecirlo.

## Consecuencias

**A favor**

- La bandera significa algo: identifica las matrices *matemáticamente*
  diagonales, que es lo que el usuario quiere saber.
- El criterio está escrito una vez y compartido, y hay tests para cada caso
  límite, incluido el ruido de `1e-16` y el ruido de `1e-8` que ya no debe
  contar.

**En contra**

- Un umbral, por pequeño que sea, es una decisión. Con `EPSILON` mal puesto, o
  una matriz con una entrada de `1e-10` genuinamente distinta de cero, se
  informará como diagonal. Se asume que ese matiz no importa en este dominio y
  que el coste de ser exacto (informar `false` casi siempre) es mucho mayor.
- La bandera es un booleano y no un residuo. Informar "diagonal salvo un
  `3e-11`" sería más honesto, a costa de una API más compleja de consumir.
