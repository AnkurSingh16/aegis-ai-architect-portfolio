# AEGIS web application: static build served by nginx, which proxies /api to the API service.
FROM node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /repo
ENV npm_config_fund=false npm_config_audit=false
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
# The web build imports API contract types, so the API source is needed for the build.
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build --workspace=@aegis/web

FROM nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
