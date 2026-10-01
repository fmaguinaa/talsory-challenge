#!/usr/bin/env bash
#
# render-secrets.sh - prints the values Render asks for, ready to paste.
#
# Render asks for four values on the first Blueprint sync (the ones marked
# `sync: false` in deploy/render/render.yaml). They all come from
# .env.dev-keys, but NOT verbatim, and getting this wrong fails in confusing
# ways:
#
#   * DEMO_PASSWORD_HASH has its `$` doubled as `$$`, because docker compose
#     interpolates `$` even in env_file values. Render does not interpolate, so
#     pasting the raw value yields `$$argon2id$...`. auth-service checks
#     `startsWith('$argon2')` and refuses to start with "DEMO_PASSWORD_HASH must
#     be an argon2id hash" -- an error that points nowhere near the real cause.
#     Even if that check were bypassed, argon2 rejects the string outright.
#
#   * The PEMs are already single-line with escaped `\n`, which is exactly what
#     Render wants, and auth-service's normalizePem turns them back into real
#     newlines. Those two are pasted as they are.
#
# Usage: ./scripts/render-secrets.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE="${REPO_ROOT}/.env.dev-keys"

[[ -f "${SOURCE}" ]] || {
  printf 'error: %s not found; run ./scripts/gen-dev-keys.sh first\n' "${SOURCE}" >&2
  exit 1
}

# Reads one value out of the file, un-escaping the doubled dollar signs that
# Compose needs and that nothing else does.
read_value() {
  local key="$1"
  local value
  value="$(grep -m1 "^${key}=" "${SOURCE}" | cut -d= -f2-)"
  [[ -n "${value}" ]] || {
    printf 'error: %s not found in %s\n' "${key}" "${SOURCE}" >&2
    exit 1
  }
  printf '%s' "${value//\$\$/\$}"
}

private_pem="$(read_value JWT_PRIVATE_KEY_PEM)"
public_pem="$(read_value JWT_PUBLIC_KEY_PEM)"
kid="$(read_value JWT_KID)"
hash="$(read_value DEMO_PASSWORD_HASH)"

# Fail here rather than in Render: the two ways this goes wrong (a hash that
# still starts with `$$`, or a PEM split over several lines) both look like a
# Render problem and are not.
if [[ "${hash}" == \$\$* ]]; then
  printf 'error: the hash still has escaped dollar signs\n' >&2
  exit 1
fi
[[ "${private_pem}" == *'\n'* ]] || {
  printf 'error: the private PEM has no escaped newlines\n' >&2
  exit 1
}

printf '%s\n' "Paste these into the Render dashboard (values marked 'sync: false'):"
printf '\n%s\n' '--- JWT_PRIVATE_KEY_PEM ---'
printf '%s\n' "${private_pem}"
printf '\n%s\n' '--- JWT_PUBLIC_KEY_PEM ---'
printf '%s\n' "${public_pem}"
printf '\n%s\n' '--- JWT_KID ---'
printf '%s\n' "${kid}"
printf '\n%s\n' '--- DEMO_PASSWORD_HASH ---'
printf '%s\n' "${hash}"
printf '\n'

printf 'demo login: %s / %s\n' "$(read_value DEMO_USERNAME)" "$(read_value DEMO_PASSWORD)"
printf '\n'
printf '%s\n' 'The hash above is un-escaped on purpose. Do not paste it straight'
printf '%s\n' 'from .env.dev-keys: compose escapes the dollar signs there and'
printf '%s\n' 'Render does not undo them.'