# ADR-002: Flujo dirigido por el orquestador frente a Go → Node

- **Estado**: Aceptado
- **Fecha**: 2026-09-29

## Contexto

El PDF describe un flujo "Go llama a Node": el backend en Go recibe la matriz,
calcula la factorización y **se la pasa** al backend en Node, que calcula las
estadísticas. Esa es la lectura literal de la flecha en la diapositiva de
arquitectura.

Ese flujo tiene un problema concreto: obliga al servicio en Go a conocer la
dirección del servicio en Node y a decidir su formato de entrada. Go tendría que
saber que Node espera `{ "matrices": [...] }` con etiquetas. Para dos servicios
que no compartirán código, eso es acoplamiento por contrato implícito y por
configuración: si mañana Node cambia su API, Go se rompe, aunque Go no tenga
nada que ver con las estadísticas.

## Decisión

El **orquestador** (NestJS) es el dueño del flujo:

```
frontend ──► orchestrator ──► qr-api    (Q, R)
                  │
                  └──────────► stats-api (Q, R) ──► respuesta agregada
```

El orquestador es además el **único backend público**: el front no habla con
ninguno de los otros tres.

Cuatro razones, en orden de peso:

1. **Responsabilidad única.** El orden "validar → factorizar → estadist →
   agregar" está escrito en un sitio. Con Go → Node, el orden está repartido entre
   dos servicios y el punto donde se decide qué pasa si el segundo falla también.
2. **Los servicios no se conocen entre sí.** `qr-api` no sabe que existe
   `stats-api`, ni su URL, ni su formato. Añadir un tercer paso al flujo (por
   ejemplo, comparar contra una matriz de referencia) es tocar un fichero, no
   dos.
3. **Escalado y pruebas independientes.** Cada servicio se despliega, escala y
   prueba por separado, sin dependencias de despliegue.
4. **Un solo lugar donde se traduce el error.** El mapeo de "el backend de QR no
   respondió" a un 502 con un `problem+json` concreto está entero en el filtro
   de excepciones del orquestador, en vez de repartido entre dos lenguajes.

### Cómo se volvería al flujo directo

El cambio está contenido en `AnalyzeWorkflow`: si `qr-api` ganara un puerto
`/api/v1/analyze` que llamase a `stats-api` y devolviese el resultado agregado,
el orquestador pasaría a reenviar su respuesta sin transformarla y el resto del
sistema no cambiaría. Se ha evitado hacerlo aquí por dos motivos: hoy el flujo
Go → Node trasladaría la traducción de errores a Go, y el orquestador ya aporta
el proxy de login y el `requestId` que atraviesan las cuatro llamadas.

## Consecuencias

**A favor**

- Cada servicio tiene una responsabilidad y una URL.
- Los errores tienen un punto de traducción, y un cliente recibe siempre el
  mismo formato `application/problem+json` sin importar qué falló.
- El frente tiene una sola URL que conocer.

**En contra**

- Un salto de red más: el cliente pasa por el orquestador, que a su vez llama a
  dos servicios. En la red interna de Docker o de ACA son microsegundos; sobre
  una WAN con dos regiones sería el punto a optimizar.
- El orquestador es un punto único de fallo y, con él, todo el sistema. Es
  aceptable porque no guarda estado y `depends_on: service_healthy` más
  `minReplicas: 2` en la nube evitan que un reinicio lo convierta en una caída.
- El orquestador conoce los esquemas de los otros tres, así que un cambio en
  cualquiera de ellos le afecta. Eso es irreducible: alguien tiene que conocer
  el flujo.
