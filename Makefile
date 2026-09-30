# =============================================================================
# Interseguro - developer entry points.
#
# Everything here is a thin wrapper. The commands a service understands live in
# that service's package.json / Makefile, so there is exactly one place where
# "how do I run the tests for stats-api" is answered.
#
# Common:  make up | make test | make lint | make smoke
# =============================================================================

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# Node version used for local tooling. Pinned so a developer's nvm and CI agree.
NODE_MAJOR := 24

COMPOSE := docker compose
# `--wait` blocks until every service reports healthy, which removes the
# "run the smoke test too early" failure mode entirely.
UP_FLAGS := --build --wait

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------
# Stack lifecycle
# ---------------------------------------------------------------------------
.PHONY: up
up: ## Build and start the whole stack, waiting until healthy
	$(COMPOSE) up $(UP_FLAGS) --remove-orphans

.PHONY: up-backends
up-backends: ## Start only the four backend services (no front end)
	$(COMPOSE) up $(UP_FLAGS) auth-service qr-api stats-api orchestrator

.PHONY: down
down: ## Stop the stack, keeping volumes
	$(COMPOSE) down --remove-orphans

.PHONY: down-hard
down-hard: ## Stop the stack and delete images
	$(COMPOSE) down --remove-orphans --rmi local -v

.PHONY: restart
restart: ## Restart the stack
	$(COMPOSE) restart

.PHONY: ps
ps: ## Show container status and health
	$(COMPOSE) ps

.PHONY: logs
logs: ## Follow logs from every service
	$(COMPOSE) logs -f --tail=100

.PHONY: logs-service
logs-service: ## Follow logs from one service (make logs-service SERVICE=qr-api)
	@test -n "$(SERVICE)" || { echo "usage: make logs-service SERVICE=qr-api"; exit 1; }
	$(COMPOSE) logs -f --tail=100 "$(SERVICE)"

.PHONY: smoke
smoke: ## Run the end-to-end smoke test against the running stack
	./scripts/smoke.sh

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------
.PHONY: keys
keys: ## Generate the development RSA key pair and demo credentials
	./scripts/gen-dev-keys.sh

.PHONY: env
env: ## Create .env from .env.example if it does not exist
	@test -f .env || { cp .env.example .env; echo "created .env"; }

# ---------------------------------------------------------------------------
# Per-service quality gates
# ---------------------------------------------------------------------------
.PHONY: test
test: test-qr-api test-stats-api test-auth-service test-orchestrator test-mobile ## Run every test suite

.PHONY: test-qr-api
test-qr-api: ## Test qr-api (Go)
	cd services/qr-api && go test -race ./...

.PHONY: test-stats-api
test-stats-api: ## Test stats-api
	cd services/stats-api && npm run verify

.PHONY: test-auth-service
test-auth-service: ## Test auth-service
	cd services/auth-service && npm run verify

.PHONY: test-orchestrator
test-orchestrator: ## Test orchestrator
	cd services/orchestrator && npm run verify

.PHONY: test-mobile
test-mobile: ## Test the Expo app
	cd apps/mobile && npm test

.PHONY: lint
lint: lint-qr-api lint-stats-api lint-auth-service lint-orchestrator lint-mobile ## Lint and type-check every service

.PHONY: lint-qr-api
lint-qr-api: ## Vet and format-check qr-api
	cd services/qr-api && go vet ./... && test -z "$$(gofmt -l .)" || { echo "gofmt found issues"; exit 1; }

.PHONY: lint-stats-api
lint-stats-api: ## Lint and type-check stats-api
	cd services/stats-api && npm run typecheck && npm run lint

.PHONY: lint-auth-service
lint-auth-service: ## Lint and type-check auth-service
	cd services/auth-service && npm run typecheck && npm run lint

.PHONY: lint-orchestrator
lint-orchestrator: ## Lint and type-check orchestrator
	cd services/orchestrator && npm run typecheck && npm run lint

.PHONY: lint-mobile
lint-mobile: ## Lint and type-check the Expo app
	cd apps/mobile && npm run typecheck && npm run lint

.PHONY: format
format: ## Auto-format every service
	cd services/qr-api && gofmt -w .
	cd services/stats-api && npm run format
	cd services/auth-service && npm run format
	cd services/orchestrator && npm run format
	cd apps/mobile && npm run format

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
.PHONY: build
build: ## Build every service image
	$(COMPOSE) build

# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------
.PHONY: clean
clean: ## Remove build artefacts and node_modules
	rm -rf services/*/dist services/qr-api/bin
	rm -rf apps/mobile/dist apps/mobile/.expo
	@echo "node_modules left in place; use 'make nuke' to remove those too"

.PHONY: nuke
nuke: clean ## Also remove every node_modules directory
	rm -rf services/*/node_modules apps/mobile/node_modules

.PHONY: deps
deps: ## Install dependencies for every Node service
	cd services/stats-api && npm ci
	cd services/auth-service && npm ci
	cd services/orchestrator && npm ci
	cd apps/mobile && npm install
	cd services/qr-api && go mod download
