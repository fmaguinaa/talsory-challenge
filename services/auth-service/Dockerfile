# syntax=docker/dockerfile:1
#
# auth-service - Node.js + Express, multi-stage.
#
# Four stages keep the runtime image free of the toolchain:
#   deps      - full dependency tree, used only to build
#   build     - tsc emits dist/
#   prod-deps - production dependencies only, no devDependencies
#   runtime   - node:22-alpine running plain JS, as a non-root user
#
# The entrypoint is `node dist/main.js` and not `npm start`: npm spawns a child
# process, which swallows SIGTERM, so a rolling deploy would wait out the full
# grace period and then SIGKILL the service mid-request.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=dev keeps vitest, typescript and the whole toolchain out of the runtime
# image. `npm ci` is used rather than `npm install` so the lockfile is honoured
# exactly, making the build reproducible.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini reaps zombies and, more importantly, forwards SIGTERM to the Node
# process so the graceful shutdown path actually runs.
RUN apk add --no-cache tini

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The `node` user ships with the base image (uid 1000).
USER node

EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
