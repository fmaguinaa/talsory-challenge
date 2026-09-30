# syntax=docker/dockerfile:1
#
# qr-api - Go + Fiber, multi-stage.
#
# Stage 1 (builder) compiles a fully static binary. CGO_ENABLED=0 is what makes
# the distroless/static runtime possible: that image has no libc at all.
# Stage 2 (runtime) is gcr.io/distroless/static, which contains no shell and no
# package manager, so the attack surface is the binary plus its CA bundle.
FROM golang:1.23-alpine AS builder

WORKDIR /src

# go.mod/go.sum are copied first so the dependency layer is cached and is not
# invalidated by every source change.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY cmd ./cmd
COPY internal ./internal

# -trimpath removes local filesystem paths from the binary (reproducibility and
# no build-host leakage); -s -w drop the symbol table and DWARF data.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build \
      -trimpath -ldflags="-s -w" \
      -o /out/qr-api ./cmd/qr-api

FROM gcr.io/distroless/static-debian12:nonroot AS runtime

# The CA bundle comes from the builder, because the distroless image has no
# package manager to install one with. qr-api talks to auth-service over HTTP
# internally, but a CA bundle keeps the door open for TLS without a rebuild.
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /out/qr-api /usr/local/bin/qr-api

# distroless has no shell, so a HEALTHCHECK that shells out is impossible.
# The readiness endpoint is exercised by docker-compose healthcheck using
# wget-less probes via the orchestrator; the image itself stays minimal.
USER nonroot:nonroot
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/qr-api"]
