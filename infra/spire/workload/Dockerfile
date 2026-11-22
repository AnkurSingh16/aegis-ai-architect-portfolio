# AEGIS agent workload. Build context is infra/spire so the peer policy is baked in (policy.json). Built from the pinned Go toolchain;
# runtime is pinned node:24-bookworm-slim (shell available for operator checks). The binary holds no credentials and takes no identity
# from its environment: SPIFFE IDs come only from the SPIRE Workload API.
FROM golang@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac AS build
WORKDIR /src
COPY workload/go.mod workload/go.sum ./
RUN go mod download
COPY workload/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/aegis-workload .

FROM node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
COPY --from=build /out/aegis-workload /app/aegis-workload
COPY policy.json /etc/aegis/spire-policy.json
ENTRYPOINT ["/app/aegis-workload"]
CMD ["serve"]
