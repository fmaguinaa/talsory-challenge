# AGENTS.md — Interseguro Coding Challenge (Senior-level solution)

You are an autonomous engineering agent. Build the full solution described below in a single monorepo.
Do not ask questions: when something is ambiguous, **decide, implement, and record the decision in `docs/adr/`**.
Quality bar: this is a senior-engineer interview deliverable. Clarity, small focused modules, tests, and defensible decisions matter more than feature count.

---

## 1. Challenge summary (source of truth)

Original requirements (Interseguro, Junio 2024):

- API in **Go** using **Fiber**; API in **Node.js** using **Express.js**.
- Go API receives a rectangular matrix (`array of arrays of numbers`) and returns its **QR factorization**.
- Node API receives the matrices returned by the Go API and computes:
  - Maximum value, minimum value, average, total sum (across the matrices).
  - Whether **any matrix is diagonal**.
- Clean, documented code; **Docker** for every service; HTTP communication; **cloud** deployment.
- Optional (we DO all of them): frontend consuming the APIs, **JWT security**, **unit + integration tests**.

### Known ambiguity (resolve via ADR-001)
The PDF's architecture slide says the Go API "rotates" the matrix, while the functional slide says it returns the **QR factorization**. **Implement QR factorization** (it is the functional requirement, and Q and R are the "matrices returned"). Record this in ADR-001.

### Our extended architecture (user requirements)

```
Expo app ──HTTPS──► Orchestrator (NestJS, BFF) ──► qr-api    (Go + Fiber)      : QR factorization
                          │                    └─► stats-api (Node + Express)  : statistics
                          └──────────────────────► auth-service                 : issues + validates tokens
qr-api, stats-api ─────────────────────────────► auth-service (validate token)  : defense in depth
```

- The **frontend talks ONLY to the orchestrator**.
- The **orchestrator** owns the workflow: `login` → validate token → call `qr-api` → feed `Q` and `R` to `stats-api` → return one aggregated response.
- **Token validation is delegated to a separate `auth-service`.** Every backend (orchestrator, qr-api, stats-api) validates the bearer token against it (zero trust: never assume the caller already validated).
- `qr-api` and `stats-api` stay **independent and stateless** (no knowledge of each other). This deviates from the PDF's literal "Go sends to Node" flow; justify in ADR-002 (single responsibility, independent scaling/testing, one place for workflow logic, easy to add steps). Mention in the ADR that switching to direct Go→Node is a small change in the orchestrator.

---

## 2. Repository layout

```
.
├── AGENTS.md
├── README.md                     # how to run, architecture diagram (mermaid), endpoints, decisions summary
├── docker-compose.yml
├── docker-compose.override.yml   # dev only: publishes internal ports, hot reload where cheap
├── .env.example
├── contracts/                    # CONTRACT-FIRST: OpenAPI 3.1 specs, written BEFORE code
│   ├── auth-service.yaml
│   ├── qr-api.yaml
│   ├── stats-api.yaml
│   └── orchestrator.yaml
├── services/
│   ├── auth-service/             # Node.js + TypeScript + Express
│   ├── qr-api/                   # Go + Fiber
│   ├── stats-api/                # Node.js + TypeScript + Express
│   └── orchestrator/             # NestJS + TypeScript
├── apps/
│   └── mobile/                   # Expo (React Native + web export), TypeScript
├── scripts/
│   ├── smoke.sh                  # end-to-end check against docker compose
│   └── gen-dev-keys.sh           # generates dev RSA keypair for auth-service
├── deploy/                       # cloud deployment (see §9)
├── docs/adr/                     # architecture decision records
└── .github/workflows/ci.yml
```

Conventions (all services):
- Code, identifiers, comments: **English**. `README.md` and `docs/adr/*`: **Spanish** (reviewers are Spanish-speaking).
- Use the **latest stable LTS** of each runtime/framework at the time you work; verify versions instead of assuming, and pin them (Dockerfiles, lockfiles, `go.mod`).
- Config only via environment variables, validated at startup (fail fast with a clear message). Provide `.env.example`; never commit secrets.
- Structured JSON logs; every request carries `X-Request-Id` (generate if missing, propagate downstream, include in logs and error bodies).
- Errors follow **RFC 9457 Problem Details** (`application/problem+json`): `type`, `title`, `status`, `detail`, `instance`, plus `requestId`.
- Every service exposes `GET /health/live` and `GET /health/ready` (public, unauthenticated). Ready checks dependencies that matter (e.g., auth-service reachability is NOT required for liveness).
- Public API prefix: `/api/v1`. Auth endpoints: `/auth`.
- Small, conventional commits (`feat(qr-api): …`). Commit after each completed phase.

---

## 3. Architecture principles (apply everywhere)

- **Clean/Hexagonal**: `domain` (pure logic, no I/O, no framework) → `application` (use cases, ports/interfaces) → `adapters/infrastructure` (HTTP handlers, HTTP clients, config). Frameworks (Fiber/Express/Nest) live only in adapters. Dependencies point inward.
- **Contract-first**: write `contracts/*.yaml` first. Validate requests/responses against them (Go: e.g. `oapi-codegen` or spec-driven validation; Express: `express-openapi-validator`; Nest: types aligned with the spec + Swagger). If a tool causes friction, keep the spec authoritative and add a contract test that checks handlers against it.
- **Boring and readable**: no clever metaprogramming, no unused abstractions, no dead code, no premature databases. State is intentionally absent (no DB); document that in an ADR.
- **Fail closed** on security: if auth-service is unreachable, return `503` (never let the request through).
- Explicit input limits (max matrix dimensions, max body size, numeric finiteness) → `400`/`413`/`422` with useful messages.

---

## 4. Service specs

### 4.1 `auth-service` (Node + TS + Express)

Purpose: authenticate users, issue JWTs, and **validate tokens for other services**.

Endpoints:
- `POST /auth/login` — body `{ "username": string, "password": string }` → `200 { "accessToken", "tokenType": "Bearer", "expiresIn": <seconds> }`. `401` on bad credentials (same message for unknown user/wrong password; constant-time comparison).
- `POST /auth/validate` — token introspection (RFC 7662-style). Input: `Authorization: Bearer <token>` (or body `{ "token": … }`). Output: `200 { "active": true, "sub", "scope", "exp", "iat" }` or `200 { "active": false }`. **This endpoint is service-to-service**: protect it with a service credential (`X-Service-Key` header matched against `SERVICE_API_KEYS` env, comma-separated, constant-time compare). No credential → `401`.
- `GET /.well-known/jwks.json` — public keys (documented as the alternative/complement for local verification).
- `GET /health/live`, `GET /health/ready`.

Rules:
- JWT signed with **RS256** (use `jose`). Private key from env/secret (`JWT_PRIVATE_KEY_PEM`); `scripts/gen-dev-keys.sh` generates a dev pair. Include `kid`, `iss`, `aud`, `sub`, `iat`, `exp`, `scope`. Short TTL (default 15 min, env-configurable). Validate `iss`, `aud`, `exp`, algorithm allowlist (never accept `none`/HS*).
- Users: no database. Seed users from env (`AUTH_USERS` JSON or a single `DEMO_USER`/`DEMO_PASSWORD_HASH`); passwords hashed with **argon2id** (or bcrypt). Document this as a deliberate scope decision.
- Rate-limit `/auth/login` (e.g. `express-rate-limit`), `helmet`, no user enumeration, no secrets in logs.
- Tests: login success/failure, token tampering, expired token, wrong `aud`/`iss`, missing service key, introspection of valid/invalid tokens.

### 4.2 `qr-api` (Go + Fiber)

`POST /api/v1/qr/factorize` (auth required)

Request:
```json
{ "matrix": [[12, -51, 4], [6, 167, -68], [-4, 24, -41]] }
```
Response `200`:
```json
{ "q": [[...]], "r": [[...]] }
```

Implementation requirements:
- Implement **Householder QR** yourself in `domain/qr` (numerically stable; do not use Gram-Schmidt). Output **full** factorization: `A (m×n) = Q (m×m) · R (m×n)`, `Q` orthogonal, `R` upper triangular. Document the sign convention (Householder yields a possibly negative diagonal in `R`, as LAPACK does) in ADR-003. Works for any `m×n` (m<n, m=n, m>n).
- Validation (`application` layer): non-empty; all rows same length ≥ 1 (rectangular); all values finite (no NaN/Inf); dimensions ≤ `MAX_MATRIX_DIM` (default 100); body size limit. Return `400` (malformed JSON), `422` (invalid matrix, with a precise reason like "row 2 has length 2, expected 3").
- Hexagonal layout:
  ```
  internal/
    domain/qr/            # pure algorithm + Matrix type
    application/          # FactorizeUseCase, ports (TokenValidator)
    adapters/http/        # Fiber handlers, DTOs, problem+json, middleware
    adapters/authclient/  # HTTP client for auth-service /auth/validate (+ small TTL cache)
    config/
  cmd/qr-api/main.go
  ```
- Fiber middleware: request-id, structured logger, recover, body limit, timeout, auth (calls `TokenValidator` port), CORS disabled (internal service).
- Graceful shutdown (SIGTERM), server timeouts.
- **Tests**: table-driven unit tests of the algorithm asserting (1) `‖Q·R − A‖ ≤ 1e-9`, (2) `‖QᵀQ − I‖ ≤ 1e-9`, (3) `R` is upper triangular within tolerance, across square/tall/wide/identity/zero/single-element/negative-value matrices, plus the known textbook example. Integration tests with `app.Test()` covering 200/400/401/422/503 (fake auth server via `httptest`). Add a benchmark for a 100×100 matrix. Run with `-race`.
- Lint: `golangci-lint` config committed; `go vet` clean.

### 4.3 `stats-api` (Node + TS + Express)

`POST /api/v1/stats` (auth required)

Request (generic: any list of matrices, labeled for traceability):
```json
{ "matrices": [ { "id": "Q", "data": [[...]] }, { "id": "R", "data": [[...]] } ] }
```
Response `200`:
```json
{
  "global": { "max": 0, "min": 0, "average": 0, "sum": 0, "anyDiagonal": false },
  "perMatrix": [ { "id": "Q", "max": 0, "min": 0, "average": 0, "sum": 0, "isDiagonal": false } ]
}
```

Rules:
- `global` aggregates **all values across all matrices** (max, min, average = sum / total count, sum). `anyDiagonal` = any matrix diagonal. `perMatrix` gives the breakdown.
- **Diagonal definition (ADR-004)**: square AND every off-diagonal element satisfies `|x| ≤ EPSILON` (default `1e-9`, configurable). Tolerance is mandatory because QR output has floating-point noise. Non-square → `false`. A 1×1 matrix is diagonal.
- Use compensated (Kahan/Neumaier) summation for `sum`; document why. Single pass per matrix, O(n) memory-free.
- Validation: at least 1 matrix, each rectangular and non-empty, finite numbers, size limits (`MAX_MATRICES`, `MAX_TOTAL_ELEMENTS`), body-size limit. `422` with precise reasons.
- Layout: `src/domain` (pure functions: `computeStats`, `isDiagonal`), `src/application` (use case, `TokenValidator` port), `src/adapters/http` (Express routers, openapi validator, problem+json), `src/adapters/authclient`, `src/config`, `src/main.ts`.
- Middleware: `helmet`, request-id, pino logger, JSON body limit, auth, central error handler.
- **Tests** (Vitest or Jest + supertest): unit tests for stats and diagonal (identity, diagonal with noise `1e-12`, upper-triangular → false, non-square, negatives, single element, large values), integration tests for 200/401/422/503 with a mocked auth server. Coverage ≥ 90% on `domain` and `application`.

### 4.4 `orchestrator` (NestJS)

Public entrypoint for the frontend (BFF). Modules: `AuthModule` (login proxy + guard), `MatrixModule` (workflow), `HealthModule`, `Common` (interceptors, filters, config).

Endpoints:
- `POST /auth/login` → proxies to auth-service, returns its response.
- `POST /api/v1/matrix/analyze` (auth required). Request `{ "matrix": number[][] }`. Workflow:
  1. Guard validates token via auth-service (small TTL cache, fail closed).
  2. Call `qr-api` `POST /api/v1/qr/factorize` (forward bearer token + `X-Request-Id`).
  3. Call `stats-api` `POST /api/v1/stats` with `[ {id:"Q"}, {id:"R"} ]` from step 2 (forward bearer token).
  4. Return:
  ```json
  { "requestId": "…", "input": { "rows": 3, "cols": 3 }, "qr": { "q": [[…]], "r": [[…]] }, "stats": { "global": {…}, "perMatrix": […] } }
  ```
- `GET /health/live|ready`.

Rules:
- Downstream calls through typed **client ports** (`QrClient`, `StatsClient`, `TokenValidator`) with adapters using `@nestjs/axios`: timeouts (default 3s), bounded retries with backoff only for idempotent failures (network/5xx), no retry on 4xx. Optional simple circuit breaker (e.g. `opossum`) — keep only if it stays readable.
- Map downstream errors: upstream `4xx` validation → `422` with the original reason; upstream unreachable/timeout → `502/504`; auth-service down → `503`. Never leak internals/stack traces.
- Input validation with `class-validator`/`class-transformer` (or `zod`) plus the same limits as qr-api (fail early, before any network call).
- `helmet`, CORS restricted to `CORS_ORIGINS` env, `@nestjs/throttler`, Swagger UI at `/docs` (generated, must match `contracts/orchestrator.yaml`), global exception filter emitting problem+json, request-id middleware + logger (pino).
- **Tests**: unit tests for the workflow use case (mock ports: happy path, qr failure, stats failure, timeout mapping); e2e tests with `supertest` + mocked downstream servers (nock or in-process fake servers).

### 4.5 `mobile` (Expo, TypeScript, Expo Router)

Screens:
1. **Login** (username/password → orchestrator `/auth/login`).
2. **Analyze**: matrix editor — choose rows × cols, edit cells in a grid (numeric keyboard), and "paste JSON" mode; client-side validation mirroring server limits; buttons: Analyze, Clear, Load example.
3. **Results**: Q and R rendered as readable tables (horizontal scroll, sensible number formatting, e.g. 4 decimals with full value on long-press/tap), stats cards (max, min, average, sum), diagonal badges per matrix, `requestId` shown in a collapsible "details" section.

Rules:
- Talks **only** to the orchestrator via a single `api/client.ts` (typed, generated from or aligned to `contracts/orchestrator.yaml`). Handles 401 (auto-logout), 422 (show reason), network/5xx (friendly error + retry).
- Token storage: `expo-secure-store` on native; on web use in-memory (+ `sessionStorage` if needed) — never `localStorage` for tokens. Document the tradeoff.
- Config: `EXPO_PUBLIC_API_URL` for dev. For the Docker/web build use **runtime config** (`/config.json` written at container start from env) so the same image is promotable across environments.
- Architecture inside the app: `features/{auth,matrix}/{components,hooks,services}`, `shared/ui`, state via React Context + a small reducer or Zustand (pick one, keep minimal). Strict TypeScript, ESLint + Prettier.
- Must run on **web** (`expo export --platform web`, served by Docker) and be usable on iOS/Android via Expo Go (`npx expo start`); document both.
- Tests: `jest-expo` + React Native Testing Library for the matrix-editor validation logic and the API client error mapping (keep small but meaningful).

---

## 5. Token validation design (senior showcase — document in ADR-005)

- `auth-service` is the single authority. Backends call `POST /auth/validate` (with `X-Service-Key`).
- Each backend implements a `TokenValidator` **port** with an HTTP adapter and a tiny in-memory cache: cache only `active: true` results, TTL = `min(AUTH_CACHE_TTL_SECONDS (default 30), token exp − now)`, keyed by SHA-256 of the token (never store raw tokens as keys/logs). Cache is per instance; document the revocation-latency tradeoff (≤ TTL).
- Auth-service failure or timeout (default 1.5s) → **fail closed** (`503`, `Retry-After`).
- Document the alternative (local JWKS verification: lower latency, no revocation) and why introspection was chosen here (central revocation/audit, one place for policy). The JWKS endpoint exists so the design can evolve.
- Pass the original bearer token downstream from the orchestrator (token propagation), so each service authorizes independently.

---

## 6. Dockerization (all services)

For every service create a **multi-stage** `Dockerfile`, `.dockerignore`, and a `HEALTHCHECK` (or rely on compose healthchecks for distroless).

- **qr-api (Go)**: builder `golang:<latest>-alpine` with module cache mount (`--mount=type=cache`), `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"`; runtime `gcr.io/distroless/static:nonroot` (or `scratch` + CA certs). Non-root, read-only-fs friendly.
- **auth-service / stats-api / orchestrator (Node)**: stages `deps` (`npm ci`) → `build` (`tsc`/`nest build`) → `prod-deps` (`npm ci --omit=dev`) → runtime `node:<lts>-alpine` (or distroless nodejs). `NODE_ENV=production`, `USER node`, `CMD ["node","dist/main.js"]` (no `npm start`, so signals reach the process), use `tini`/`--init` or compose `init: true`.
- **mobile (Expo web)**: stage 1 `node:<lts>-alpine` runs `npx expo export --platform web`; stage 2 `nginxinc/nginx-unprivileged` serves `dist/` with SPA fallback (`try_files $uri /index.html`), gzip, cache headers (immutable for hashed assets, no-cache for `index.html`), and an entrypoint that renders `/config.json` from env (`API_URL`) via `envsubst`.
- General: pin base image tags (digest optional), order layers for cache efficiency, no secrets in images/build args, images small (report sizes in README).

`docker-compose.yml`:
- Services: `auth-service`, `qr-api`, `stats-api`, `orchestrator`, `mobile-web`.
- Two networks: `edge` (mobile-web, orchestrator) and `internal` (all backends; `internal: true`). **Only `orchestrator` (e.g. 3000) and `mobile-web` (e.g. 8080) publish host ports.** The dev override publishes internal ports for debugging.
- `depends_on` with `condition: service_healthy`, healthchecks for each service, `restart: unless-stopped`, resource limits (`deploy.resources`), `read_only: true` + `tmpfs` where feasible, `security_opt: no-new-privileges`, `cap_drop: [ALL]`.
- All config from `.env` (`.env.example` documents each variable, including `SERVICE_API_KEYS`, `JWT_*`, `AUTH_CACHE_TTL_SECONDS`, `MAX_MATRIX_DIM`, `CORS_ORIGINS`, `API_URL`).
- `docker compose up --build` must bring the whole system up from a clean clone after `cp .env.example .env && ./scripts/gen-dev-keys.sh`.

---

## 7. Testing & quality gates

- Unit + integration tests per service (see each spec). Add `scripts/smoke.sh`: after `docker compose up -d --wait`, it (1) hits `orchestrator /health/ready`, (2) logs in, (3) calls `analyze` with the known 3×3 example and asserts `Q·R ≈ A` and non-empty stats, (4) asserts `401` without token and with a tampered token, (5) asserts internal services are NOT reachable from the host.
- A Makefile (or `just`) with targets: `make up`, `make down`, `make test`, `make lint`, `make smoke`.
- CI (`.github/workflows/ci.yml`): matrix job per service (lint → test → build image), then compose smoke test. Cache dependencies. Fail on lint/test errors.

---

## 8. Documentation deliverables

- `README.md` (Spanish): overview, mermaid architecture + sequence diagram of `analyze`, quick start (Docker and local dev), endpoints table with curl examples, env vars, testing, deployment, decisions summary, limitations/next steps.
- `docs/adr/` (Spanish, short, decision/context/consequences):
  - ADR-001 QR factorization vs "rotation" ambiguity; full vs reduced QR; sign convention
  - ADR-002 Orchestrator-driven flow vs direct Go→Node
  - ADR-003 Householder over Gram-Schmidt; numerical tolerances
  - ADR-004 Diagonal definition and epsilon
  - ADR-005 Token validation by a separate service (introspection vs JWKS, caching, fail-closed)
  - ADR-006 No database / stateless scope; seeded users
  - ADR-007 Token storage in Expo (native vs web)
  - ADR-008 Cloud target and deployment strategy
- `docs/INTERVIEW.md` (Spanish): a one-page cheat sheet of the key decisions, tradeoffs, complexity analysis (Householder QR is O(m·n²)), what you would do next (refresh tokens, mTLS between services, OpenTelemetry tracing, caching, contract tests in CI), and known limitations.
- Inline docs: doc comments on every exported function/type (Go doc format / TSDoc); explain *why*, not *what*.

---

## 9. Cloud deployment (challenge requirement)

Target: **Azure Container Apps** (alternatives: Google Cloud Run, AWS ECS Fargate — keep Dockerfiles cloud-agnostic so switching is trivial).

- Provide `deploy/` with either Bicep or Terraform (pick one) plus a short `deploy/README.md` that creates: resource group, container registry, Container Apps environment, 5 apps. `orchestrator` and `mobile-web` have **external ingress**; `auth-service`, `qr-api`, `stats-api` have **internal ingress only**. Secrets (`JWT_PRIVATE_KEY_PEM`, `SERVICE_API_KEYS`, demo user hash) via the platform's secrets mechanism (Key Vault reference if available), never in the repo.
- Add a `deploy` job to CI (manual trigger / tag) that builds and pushes images and updates the apps. Configure health probes, min/max replicas, and CORS origin for the deployed front.
- You may lack cloud credentials: in that case produce complete, validated IaC (`bicep build` / `terraform validate`) and step-by-step instructions, and state clearly in the README that the deployment scripts were validated but not executed. Never fabricate a live URL.

---

## 10. Working method

Execute in phases; after each phase run its checks and commit. Do not start the next phase with failing tests.

1. **Contracts & scaffolding**: monorepo layout, `contracts/*.yaml`, `.env.example`, ADR stubs, tooling (lint/format).
2. **qr-api**: domain algorithm + tests first, then use case, HTTP adapter, auth adapter. Dockerfile.
3. **stats-api**: domain + tests, HTTP + auth adapter. Dockerfile.
4. **auth-service**: keys, login, validate, JWKS, tests. Dockerfile.
5. **orchestrator**: ports/adapters, workflow, guard, error mapping, tests. Dockerfile.
6. **Compose + smoke test**: bring everything up, run `scripts/smoke.sh`.
7. **mobile**: screens, API client, tests, web export, Dockerfile, add to compose.
8. **CI, deploy IaC, docs**: README, ADRs, INTERVIEW.md, final review.

### Definition of done
- [ ] From a clean clone: `cp .env.example .env && ./scripts/gen-dev-keys.sh && docker compose up --build` works; app usable at the published front port.
- [ ] `make test` and `make lint` pass in every service; `scripts/smoke.sh` passes.
- [ ] Unauthenticated/tampered/expired tokens are rejected in **all three** backends.
- [ ] The known example `[[12,-51,4],[6,167,-68],[-4,24,-41]]` yields `Q·R ≈ A`, and `R` upper triangular; stats endpoint returns correct values for it.
- [ ] Only the orchestrator and web front are reachable from the host in the default compose.
- [ ] No secrets committed; images run as non-root.
- [ ] All ADRs, README and INTERVIEW.md written; contracts match the implemented behavior.

### Do NOT
- Do not add databases, message brokers, or extra services beyond the five listed.
- Do not use `localStorage` for tokens, `latest` image tags, or `npm start` as container command.
- Do not swallow errors or return stack traces to clients.
- Do not over-engineer: if a pattern doesn't make the code clearer, leave it out and note it in the README's "next steps".
