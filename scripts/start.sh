#!/bin/sh
# EDGE LAB production entrypoint: seed the demo DB on first boot, then serve.
set -e

DB="${EDGE_DB_PATH:-/app/data/edge.db}"
mkdir -p "$(dirname "$DB")"

if [ ! -f "$DB" ]; then
  echo "→ seeding demo database at $DB"
  node --experimental-sqlite --import tsx scripts/seed.ts
else
  echo "→ database exists at $DB (skipping seed)"
fi

echo "→ starting EDGE LAB on 0.0.0.0:${PORT:-3000}"
export NODE_OPTIONS=--experimental-sqlite
exec node_modules/.bin/next start -p "${PORT:-3000}" -H 0.0.0.0
