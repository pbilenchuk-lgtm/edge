#!/bin/sh
# EDGE LAB production entrypoint: seed the demo DB on first boot, then serve.
set -e

# Cap V8's heap so it garbage-collects before RSS approaches the instance's RAM
# limit. The service runs on a 2 GB instance (Render Standard), so 1024 MB of heap
# leaves ~1 GB for native (node:sqlite page cache/WAL) + non-heap with comfortable
# headroom. NOTE: this was 400 MB back when the box was 512 MB — far too low for 2 GB,
# it pinned the heap and made V8 GC-thrash (stalling the event loop during the heavy
# cycle, which starved Render's post-deploy port scan). Applies to seed and server.
export NODE_OPTIONS="--experimental-sqlite --max-old-space-size=1024"

DB="${EDGE_DB_PATH:-/app/data/edge.db}"
mkdir -p "$(dirname "$DB")"

if [ ! -f "$DB" ]; then
  echo "→ seeding demo database at $DB"
  node --experimental-sqlite --import tsx scripts/seed.ts
else
  echo "→ database exists at $DB (skipping seed)"
fi

echo "→ starting EDGE LAB on 0.0.0.0:${PORT:-3000}"
exec node_modules/.bin/next start -p "${PORT:-3000}" -H 0.0.0.0
