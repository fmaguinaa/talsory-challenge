#!/bin/sh
#
# Renders /config.json from the environment at container start.
#
# This is what makes a single image promotable between environments: the bundle
# is byte-identical, and only this file changes. Running it from the official
# entrypoint directory means it happens before nginx starts, so the very first
# request the browser makes already finds a valid configuration.
set -eu

# The document is written into the tmpfs rather than into the web root, because
# the container runs with a read-only filesystem. nginx serves it from there via
# an exact-match location, so the URL the browser asks for is still /config.json.
OUTPUT_DIR="/tmp/runtime-config"
OUTPUT="${OUTPUT_DIR}/config.json"
API_URL="${API_URL:-http://localhost:3000}"

mkdir -p "${OUTPUT_DIR}"
# nginx runs as an unprivileged user and has to be able to read the file it
# serves, so the mode is explicit rather than left to the umask.
chmod 0755 "${OUTPUT_DIR}"

# Escaped for JSON rather than for shell: the value ends up inside a JSON string
# literal, where a quote or a backslash would otherwise break the document.
ESCAPED=$(printf '%s' "${API_URL}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')

cat >"${OUTPUT}" <<EOF
{
  "apiUrl": "${ESCAPED}"
}
EOF

# World-readable: nginx is a different user from the one running this script.
chmod 0644 "${OUTPUT}"

echo "runtime config written: apiUrl=${API_URL}"
