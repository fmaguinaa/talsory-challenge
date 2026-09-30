#!/usr/bin/env bash
#
# smoke.sh - end-to-end verification against a running docker compose stack.
#
# This is deliberately NOT a unit test. Everything here goes through the real
# containers, the real network and the real tokens, because the failures that
# matter most in this system are exactly the ones no unit test would catch:
# a service that never forwards the Authorization header, a port that is
# accidentally published, a container that starts before its dependency is ready.
#
# Usage:
#   ./scripts/smoke.sh              # against the compose project
#   BASE_URL=http://host:port ./scripts/smoke.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BASE_URL="${BASE_URL:-http://localhost:${ORCHESTRATOR_PORT:-3000}}"
USERNAME="${DEMO_USERNAME:-demo}"
PASSWORD="${DEMO_PASSWORD:-demo-password}"

# Published ports the stack is *not* allowed to expose.
INTERNAL_PORTS=("4000:auth-service" "8081:qr-api" "4001:stats-api")

PASS=0
FAIL=0

# --------------------------------------------------------------------------
# Output helpers
# --------------------------------------------------------------------------
if [[ -t 1 ]]; then
  GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; BLUE=$'\033[0;34m'; DIM=$'\033[0;2m'; RESET=$'\033[0m'
else
  GREEN=''; RED=''; BLUE=''; DIM=''; RESET=''
fi

section() { printf '\n%s== %s ==%s\n' "${BLUE}" "$1" "${RESET}"; }
ok()      { PASS=$((PASS + 1)); printf '%s  PASS%s %s\n' "${GREEN}" "${RESET}" "$1"; }
fail()    { FAIL=$((FAIL + 1)); printf '%s  FAIL%s %s\n' "${RED}" "${RESET}" "$1"; }
detail()  { printf '%s        %s%s\n' "${DIM}" "$1" "${RESET}"; }

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

# Reads the HTTP status code of a request without failing on a non-2xx status.
# `curl -f` would abort on the very responses this script asserts about.
http_status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"
}

# Reads a full response body into the global RESPONSE variable.
http_body() {
  RESPONSE="$(curl -s --max-time 20 "$@")"
}

# Fails the script if the response is not valid JSON, or invokes a python
# expression against it and echoes the result.
json_eval() {
  python3 -c "
import json, sys
try:
    data = json.loads(sys.argv[1])
except Exception as error:
    print('INVALID_JSON: %s' % error)
    sys.exit(0)
try:
    print($1)
except Exception as error:
    print('MISSING: %s' % error)
" "$RESPONSE"
}

# ==========================================================================
# 1. Readiness
# ==========================================================================
section "Health checks"

body_status="$(http_status "${BASE_URL}/health/ready")"
if [[ "${body_status}" == "200" ]]; then
  ok "orchestrator /health/ready answers 200"
else
  fail "orchestrator /health/ready answered ${body_status}"
  detail "is the stack running? docker compose ps"
  exit 1
fi

http_body "${BASE_URL}/health/live"
if [[ "$(json_eval "data['status']")" == "ok" ]]; then
  ok "orchestrator /health/live reports ok"
else
  fail "orchestrator /health/live did not report ok"
fi

# ==========================================================================
# 2. Authentication
# ==========================================================================
section "Authentication"

http_body -X POST "${BASE_URL}/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"

TOKEN="$(json_eval "data['accessToken']")"

if [[ -n "${TOKEN}" && "${TOKEN}" != "INVALID_JSON:"* && "${TOKEN}" != "MISSING:"* ]]; then
  ok "login with valid credentials returns an access token"
  detail "token length ${#TOKEN}"
else
  fail "login did not return an access token"
  detail "response: ${RESPONSE}"
  exit 1
fi

# Wrong credentials must be refused with a generic message.
wrong_body="$(curl -s --max-time 15 -X POST "${BASE_URL}/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${USERNAME}\",\"password\":\"definitely-wrong\"}")"
wrong_detail="$(printf '%s' "${wrong_body}" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('detail', ''))
except Exception:
    print('')
" 2>/dev/null || true)"

if [[ "${wrong_detail}" == *"Invalid username or password"* ]]; then
  ok "wrong credentials are refused with a generic message"
else
  fail "wrong credentials produced an unexpected response: ${wrong_detail}"
fi

# ==========================================================================
# 3. The analysis workflow
# ==========================================================================
section "Analysis workflow"

ANALYZE_BODY="$(curl -s --max-time 30 -X POST "${BASE_URL}/api/v1/matrix/analyze" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'X-Request-Id: smoke-test-request' \
  -d '{"matrix":[[12,-51,4],[6,167,-68],[-4,24,-41]]}')"

# The single most important assertion in this script: Q * R must rebuild the
# input, and Q must be orthogonal. A QR implementation that returns plausible
# but wrong numbers would still pass a status-code check.
reconstruction="$(printf '%s' "${ANALYZE_BODY}" | python3 -c '
import json, sys

data = json.load(sys.stdin)
original = [[12, -51, 4], [6, 167, -68], [-4, 24, -41]]
q = data["qr"]["q"]
r = data["qr"]["r"]

rows, cols = len(original), len(original[0])

if len(q) != rows or len(q[0]) != rows:
    print("BAD_SHAPE: Q is %dx%d, want %dx%d" % (len(q), len(q[0]), rows, rows))
    sys.exit(0)
if len(r) != rows or len(r[0]) != cols:
    print("BAD_SHAPE: R is %dx%d, want %dx%d" % (len(r), len(r[0]), rows, cols))
    sys.exit(0)

# ||Q R - A||_max
residual = 0.0
for i in range(rows):
    for j in range(cols):
        value = sum(q[i][k] * r[k][j] for k in range(rows))
        residual = max(residual, abs(value - original[i][j]))

# ||Q^T Q - I||_max
orthogonality = 0.0
for i in range(rows):
    for j in range(rows):
        value = sum(q[k][i] * q[k][j] for k in range(rows))
        orthogonality = max(orthogonality, abs(value - (1.0 if i == j else 0.0)))

# R must be upper triangular.
lower = 0.0
for i in range(rows):
    for j in range(min(i, cols)):
        lower = max(lower, abs(r[i][j]))

if residual > 1e-9:
    print("BAD_RECONSTRUCTION: max|QR - A| = %g" % residual)
elif orthogonality > 1e-9:
    print("BAD_ORTHOGONALITY: max|Q^T Q - I| = %g" % orthogonality)
elif lower > 1e-12:
    print("NOT_TRIANGULAR: max sub-diagonal |R| = %g" % lower)
else:
    print("OK residual=%g orthogonality=%g triangularity=%g" % (residual, orthogonality, lower))
' 2>/dev/null || echo "INVALID_RESPONSE")"

case "${reconstruction}" in
  OK*)
    ok "Q * R reproduces the input matrix, Q is orthogonal and R is upper triangular"
    detail "${reconstruction}"
    ;;
  INVALID_RESPONSE)
    fail "analyze did not return the expected JSON"
    detail "response: ${ANALYZE_BODY}"
    ;;
  BAD_SHAPE*)
    fail "Q and R have the wrong shape"
    detail "${reconstruction}"
    ;;
  BAD_RECONSTRUCTION*)
    fail "Q * R does not reproduce the input matrix"
    detail "${reconstruction}"
    ;;
  BAD_ORTHOGONALITY*)
    fail "Q is not orthogonal"
    detail "${reconstruction}"
    ;;
  NOT_TRIANGULAR*)
    fail "R is not upper triangular"
    detail "${reconstruction}"
    ;;
  *)
    fail "unexpected reconstruction result: ${reconstruction}"
    ;;
esac

# The statistics block must be present and consistent.
stats_check="$(printf '%s' "${ANALYZE_BODY}" | python3 -c '
import json, sys

data = json.load(sys.stdin)
stats = data["stats"]
per = stats["perMatrix"]
ids = [entry["id"] for entry in per]

if ids != ["Q", "R"]:
    print("BAD_LABELS: %s" % ids)
elif not all(key in stats["global"] for key in ("max", "min", "average", "sum", "anyDiagonal")):
    print("MISSING_GLOBAL_FIELDS")
elif not stats["global"]["anyDiagonal"] and any(entry["isDiagonal"] for entry in per):
    print("INCONSISTENT_DIAGONAL")
else:
    print("OK labels=%s max=%g min=%g sum=%g" % (
        ids, stats["global"]["max"], stats["global"]["min"], stats["global"]["sum"]))
' 2>/dev/null || echo "INVALID")"

if [[ "${stats_check}" == OK* ]]; then
  ok "statistics cover both factors and are self-consistent"
  detail "${stats_check}"
else
  fail "statistics block is wrong: ${stats_check}"
fi

# The correlation id must round-trip.
echo "${ANALYZE_BODY}" | grep -q '"requestId":"smoke-test-request"' \
  && ok "the correlation id is echoed in the response body" \
  || fail "the correlation id was not echoed"

echo "${ANALYZE_BODY}" | grep -q '"input":{"rows":3,"cols":3}' \
  && ok "the input shape is reported back" \
  || fail "the input shape is missing or wrong"

# ==========================================================================
# 4. Rejected tokens
# ==========================================================================
section "Rejected credentials"

# Each of these must fail identically in all three backends, which is what the
# per-service suites verify individually and what this confirms end to end.
assert_401() {
  local label="$1"; shift
  local status
  status="$(http_status -X POST "${BASE_URL}/api/v1/matrix/analyze" \
    -H 'Content-Type: application/json' "$@")"
  if [[ "${status}" == "401" ]]; then
    ok "${label} is rejected with 401"
  else
    fail "${label} returned ${status}, want 401"
  fi
}

assert_401 "a request with no token" -d '{"matrix":[[1,2],[3,4]]}'
assert_401 "a tampered token" \
  -H "Authorization: Bearer ${TOKEN}tampered" -d '{"matrix":[[1,2],[3,4]]}'
assert_401 "a structurally invalid token" \
  -H "Authorization: Bearer not-a-jwt" -d '{"matrix":[[1,2],[3,4]]}'

# Validation failures must be distinguishable from authentication failures, so
# a client knows which one to act on.
validation_status="$(http_status -X POST "${BASE_URL}/api/v1/matrix/analyze" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"matrix":[[1,2,3],[4,5]]}')"
if [[ "${validation_status}" == "422" ]]; then
  ok "a ragged matrix is rejected with 422"
else
  fail "a ragged matrix returned ${validation_status}, want 422"
fi

http_body -X POST "${BASE_URL}/api/v1/matrix/analyze" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"matrix":[[1,2,3],[4,5]]}'
reason="$(json_eval "data['detail']")"
if [[ "${reason}" == *"row 1 has length 2, expected 3"* ]]; then
  ok "the 422 names the offending row"
  detail "${reason}"
else
  fail "the 422 detail is not specific: ${reason}"
fi

# ==========================================================================
# 5. Network isolation
# ==========================================================================
section "Network isolation"

# The whole security model rests on these ports being unreachable from the host.
# They are reachable only from another container on the internal network.
for entry in "${INTERNAL_PORTS[@]}"; do
  port="${entry%%:*}"
  service="${entry##*:}"
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${port}/health/live" 2>/dev/null || true)"
  if [[ -z "${status}" || "${status}" == "000" ]]; then
    ok "${service} is not reachable from the host (port ${port} closed)"
  else
    fail "${service} answered on host port ${port} with status ${status}"
    detail "internal services must not publish a port"
  fi
done

# The orchestrator must, of course, be reachable.
if [[ "$(http_status "${BASE_URL}/health/live")" == "200" ]]; then
  ok "the orchestrator is reachable from the host"
else
  fail "the orchestrator is not reachable from the host"
fi

# ==========================================================================
# Summary
# ==========================================================================
printf '\n%s== Summary ==%s\n' "${BLUE}" "${RESET}"
printf '  %spassed: %d%s\n' "${GREEN}" "${PASS}" "${RESET}"
if [[ "${FAIL}" -gt 0 ]]; then
  printf '  %sfailed: %d%s\n' "${RED}" "${FAIL}" "${RESET}"
  printf '\n%sSMOKE TEST FAILED%s\n' "${RED}" "${RESET}"
  exit 1
fi
printf '\n%sSMOKE TEST PASSED%s\n' "${GREEN}" "${RESET}"
