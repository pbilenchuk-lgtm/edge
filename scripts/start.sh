#!/bin/sh
# EDGE LAB production entrypoint: seed the demo DB on first boot, then serve.
set -e

# Cap V8's heap so it garbage-collects BEFORE RSS blows past the 512Mi instance
# limit. Without this, V8's default (multi-GB) heap lets the process balloon past
# the container's cgroup limit before GC runs → OOM-kill. 400MB heap leaves ~112MB
# for native (node:sqlite) + non-heap. Applies to both the seed and the server.
export NODE_OPTIONS="--experimental-sqlite --max-old-space-size=400"

DB="${EDGE_DB_PATH:-/app/data/edge.db}"
mkdir -p "$(dirname "$DB")"

if [ ! -f "$DB" ]; then
  echo "→ seeding demo database at $DB"
  node --experimental-sqlite --import tsx scripts/seed.ts
else
  echo "→ database exists at $DB (skipping seed)"
fi

# Apply schema migrations HERE, before the server binds — not lazily on the first
# /api/health call (Render's port scan), where a heavy migration blocks the event loop
# or spikes RSS on the 512Mi box and fails the port scan → crash loop. Best-effort:
# migrate.ts exits 0 even on error and `|| true` guards the process itself, so a hiccup
# never wedges the deploy — the server just re-attempts initSchema on its first getDb().
echo "→ applying schema migrations"
node --experimental-sqlite --import tsx scripts/migrate.ts || true

echo "→ starting EDGE LAB on 0.0.0.0:${PORT:-3000}"
exec node_modules/.bin/next start -p "${PORT:-3000}" -H 0.0.0.0
