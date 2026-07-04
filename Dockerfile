# EDGE LAB — container image for any Docker host (Render / Railway / Fly / Cloud Run).
# Uses Node 22 for the built-in node:sqlite (--experimental-sqlite). The demo DB
# is seeded on first boot by scripts/start.sh; add ANTHROPIC_API_KEY to enable
# live Claude analysis (optional — the app runs with heuristic fallbacks without it).
FROM node:22-slim

WORKDIR /app

# Install all deps (dev included: the build needs typescript, first-boot seed uses tsx).
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production \
    PORT=3000 \
    EDGE_DB_PATH=/app/data/edge.db

EXPOSE 3000
CMD ["sh", "scripts/start.sh"]
