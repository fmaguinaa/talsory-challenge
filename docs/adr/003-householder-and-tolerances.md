# ADR-003: Reflectores de Householder frente a Gram-Schmidt

- **Estado**: Aceptado
- **Fecha**: 2026-09-29

## Contexto

La factorización QR se puede calcular de dos maneras elementalmente distintas:
el **método de Gram-Schmidt modificado**, que ortonormaliza columnas una a una,
y los **reflectores de Householder**, que "doblan" el espacio. Elegir es elegir
entre lo que se escribe en cinco líneas y lo que se escribe en cincuenta.

## Decisión

**Householder**, implementado a mano en `internal/domain/qr/householder.go`, sin
librerías numéricas.

### Por qué no Gram-Schmidt

Gram-Schmidt modificado pierde la ortogonalidad de `Q` de forma acumulativa:
el error crece como `O(n·ε)` con el tamaño, y ante columnas casi linealmente
dependientes —exactamente el caso que un endpoint de QR recibe— el resultado es
inútil. Householder construye reflectores que son ortogonales por construcción,
así que `Q` se mantiene ortogonal hasta la precisión de la máquina para
cualquier entrada.

El coste son unas 2x más operaciones, lo cual es irrelevante aquí: el límite de
dimensiones es 100 y una `100 x 100` tarda unos 3 ms.

### Estabilidad numérica

Tres detalles que no son cosméticos:

1. **Escala antes de medir.** La norma se calcula sobre `x` dividido por su mayor
   valor absoluto. Sin eso, entradas cerca del límite de `float64` desbordan al
   sumar cuadrados y producen `NaN` para una entrada perfectamente finita. Hay
   una prueba con valores de `1e15` que lo verifica.

2. **Signo de `alpha` opuesto al de `v[0]`.** `alpha = -sign(x[0])·‖x‖` garantiza que
   `v[0] - alpha` no suffer cancelación. Es la razón de que la diagonal de `R`
   pueda salir negativa (ver más abajo) y también de que el algoritmo sea
   estable.

3. **Zeros exactos bajo la diagonal.** El algoritmo escribe ceros duros, igual
   que LAPACK, en vez de dejar el ruido de redondeo. Sin eso, `R` tendría
   entradas de orden `1e-16` bajo la diagonal, que ensuciarían la respuesta de
   estadísticas y romperían la comprobación "R es triangular".

### Convención de signos

Se conserva la de LAPACK: la diagonal de `R` **no** se normaliza a positiva.
Para `[[12,-51,4],[6,167,-68],[-4,24,-41]]` la diagonal sale
`(-14, -175, 35)`, no `(14, 175, 35)`.

Ambas factorizaciones son igualmente válidas —cambiar el signo de una columna de
`Q` y de la fila de `R` por el mismo signo da la otra—, pero normalizar la
diagonal tendría dos costes reales: obliga a un recorrido extra sobre filas de
`Q`, que es la parte más cara del algoritmo, y deja de coincidir con cualquier
librería numérica con la que un revisor pueda comparar el resultado. Se
documenta con una prueba explícita para que no parezca un descuido.

### Tolerancias

Las pruebas usan `1e-9` como residuo absoluto en matrices pequeñas y bien
escaladas. El residual real del ejemplo del enunciado es de orden `1e-14`, tres
órdenes de magnitud por debajo del umbral, así que la prueba sigue detectando
una regresión. Se prefiere una tolerancia *absoluta y generosa* a una relativa
porque los fixtures son Known-good: el objetivo es detectar que el algoritmo se
rompe, no medir su precisión.

## Consecuencias

**A favor**

- `Q` ortogonal y `A = Q·R` con residuo `~1e-14` en todas las formas probadas:
  cuadrada, alta, ancha, 1x1, identidad, todo ceros, rangos deficientes y
  magnitudes extremas.
- Coste `O(m·n²)`, con 8 asignaciones para una `100 x 100` y sin asignaciones
  por elemento en los bucles internos.
- Sin dependencia de una librería numérica: el algoritmo es el ejercicio.

**En contra**

- Más código que Gram-Schmidt, y con más sitio donde introducir un error. La
  primera versión tenía tres bugs reales (una vista de columna que era
  contiguous cuando las columnas están espaciadas, el orden de acumulación de
  `Q`, y el tamaño del bucle de bloque), que los tests de tabla detectaron.
- `R` con diagonal negativa puede sorprender a quien espere la convención de
  signo positivo de la literature introductoria. Está documentado en el código
  y con una prueba dedicada.
