# syntax=docker/dockerfile:1

# Node 22 (prod parity — local dev may run newer; we pin 22 here).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.26.2 --activate
WORKDIR /app

# Build: full deps → generate the Prisma client (offline) → react-router build.
FROM base AS build
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm db:generate && pnpm build

# Runtime. Carries the FULL node_modules so the same image also runs the migrate
# job (`prisma migrate deploy` needs the prisma CLI, a devDependency). The prod
# server is the custom Express entry run via tsx (NOT react-router-serve).
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
RUN groupadd -r app && useradd -r -g app -m app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/app ./app
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/server.ts /app/prisma.config.ts /app/package.json /app/pnpm-lock.yaml ./
# `node --import tsx scripts/admin-reset-password.ts <email>`: the operator
# recovery command (pnpm is not used at runtime). tsx needs
# tsconfig.json to resolve the `~/` imports of the app modules it loads.
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/scripts/admin-reset-password.ts ./scripts/
RUN mkdir -p /data/uploads && chown -R app:app /data
USER app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Run tsx directly (NODE_ENV already set) — avoids pnpm/corepack/cross-env at
# runtime, so the container needs no network at start (on-prem/air-gapped safe).
CMD ["node", "--import", "tsx", "server.ts"]
