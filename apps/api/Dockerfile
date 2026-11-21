# AEGIS API. Official Node.js base image, pinned by digest (arm64 and amd64 are published under this digest's index).
FROM node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /repo
ENV npm_config_fund=false npm_config_audit=false
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/api apps/api
RUN npm run build --workspace=@aegis/api \
 && npm prune --omit=dev --workspace=@aegis/api

FROM node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /repo/apps/api/db ./apps/api/db
USER node
EXPOSE 4000
# Listens on loopback by default. The compose file sets AEGIS_API_HOST=0.0.0.0 inside the container's own network namespace.
# The instrumentation hook and telemetry register load before the application, so libraries are patched before use.
CMD ["node", "--import", "@opentelemetry/instrumentation/hook.mjs", "--import", "./apps/api/dist/observability/register.js", "apps/api/dist/server.js"]
