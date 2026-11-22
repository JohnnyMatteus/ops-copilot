# Imagem do ops-copilot: build em estágio separado, runtime sem ferramentas de build e sem root.
FROM node:22.21.1-alpine3.22 AS base
RUN npm install --global pnpm@12.21.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY evals ./evals
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:22.21.1-alpine3.22
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node playbooks ./playbooks
COPY --chown=node:node config ./config
COPY --chown=node:node runbooks ./runbooks
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=90s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/src/main.js"]
