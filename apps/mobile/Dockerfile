# syntax=docker/dockerfile:1
#
# mobile-web - the Expo web export, served by nginx.
#
# The build is static and the runtime configuration is not: stage 2 renders
# /config.json from an environment variable at container start, so one image can
# be promoted from staging to production without a rebuild. The app reads that
# file before it makes its first API call (see src/config/runtimeConfig.ts).

# -----------------------------------------------------------------------------
# Stage 1: build the web bundle
# -----------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Dependencies are installed before the sources are copied so an edit to a
# component does not invalidate a 400 MB npm layer.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY app.json ./
COPY tsconfig.json ./
COPY eslint.config.mjs ./
COPY app ./app
COPY src ./src
COPY assets ./assets

# EXPO_PUBLIC_API_URL is deliberately NOT set. Leaving it unset is what makes the
# image environment-agnostic: the bundle falls back to /config.json at runtime.
ENV EXPO_PUBLIC_API_URL=
ENV NODE_ENV=production
ENV CI=1

# `expo export` with output:"static" in app.json produces a plain directory of
# files that any static host can serve.
RUN npx expo export --platform web --output-dir dist

# -----------------------------------------------------------------------------
# Stage 2: serve it
# -----------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# The unprivileged nginx image runs as uid 101 and listens on 8080, which is why
# the compose file publishes 8080 rather than 80: binding a low port would need
# CAP_NET_BIND_SERVICE, which the container does not have.
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.d/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh

# The entrypoint scripts in this directory are executed, in order, before nginx
# starts. Making the config script executable at build time -- rather than
# through a RUN in the image -- keeps the layer cacheable.
USER root
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh
USER nginx

EXPOSE 8080
