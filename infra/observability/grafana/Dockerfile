# Grafana (official image, pinned by digest, arm64 verified) with pre-provisioned data sources and dashboards baked in.
FROM grafana/grafana@sha256:2894082f6cf7081aefdc1389265c04000812309208c190d75e8c65f7a30e4b7e
COPY provisioning/ /etc/grafana/provisioning/
COPY dashboards/ /var/lib/grafana/dashboards/
