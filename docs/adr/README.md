# Architecture Decision Records

Registro de decisiones de arquitectura. Cada documento responde a tres preguntas:
**contexto**, **decisión** y **consecuencias** (buenas y malas).

El idioma es español porque quien va a leerlos es quien revisa el ejercicio; el
código, los comentarios y la documentación de uso están en inglés por ser el
idioma estándar del ecosistema.

| ADR | Título |
|---|---|
| [001](001-qr-vs-rotation.md) | Factorización QR frente a "rotación" |
| [002](002-orchestrator-driven-flow.md) | Flujo dirigido por el orquestador frente a Go → Node |
| [003](003-householder-and-tolerances.md) | Householder frente a Gram-Schmidt |
| [004](004-diagonal-definition.md) | Definición de matriz diagonal y épsilon |
| [005](005-token-validation.md) | Validación de tokens por servicio aparte |
| [006](006-no-database.md) | Sin base de datos |
| [007](007-token-storage-mobile.md) | Almacenamiento de tokens en Expo |
| [008](008-cloud-target-and-deployment-strategy.md) | Objetivo de nube y estrategia de despliegue |

## Plantilla

```markdown
# ADR-NNN: Título

- **Estado**: Aceptado
- **Fecha**: YYYY-MM-DD

## Contexto
Qué obliga a decidir.

## Decisión
Qué se decide, y por qué esta opción y no las alternativas.

## Consecuencias
Qué mejora y qué empeora. Sin eufemismos.
```
