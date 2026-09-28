# One image for the API (which also serves the built web app) and the worker (design §4.2).
# The API runs its TypeScript through tsx: the workspace packages export their sources, and
# method.md and the migrations are read from their places in the repo.

FROM node:24-slim AS base
# Where corepack keeps pnpm, so the unprivileged runtime user finds the copy fetched at build time.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && corepack install --global pnpm@9.13.2
WORKDIR /app

# Build the web app with every dependency installed.
FROM base AS web
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm --filter @grounded/web build

# Run with only the API's production dependencies (and those of the packages it uses).
FROM base
ENV NODE_ENV=production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY method.md ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --prod --frozen-lockfile --filter "@grounded/api..."
COPY --from=web /app/apps/web/dist ./apps/web/dist
ENV WEB_DIST_DIR=/app/apps/web/dist
USER node
WORKDIR /app/apps/api
EXPOSE 8787
# The worker runs the same image with `node --import tsx src/worker.ts`.
CMD ["node", "--import", "tsx", "src/server.ts"]
