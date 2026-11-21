# Keycloak with the AEGIS local realm baked in as an immutable build input. Pinned to the official image digest (arm64 verified).
FROM quay.io/keycloak/keycloak:26.4@sha256:9409c59bdfb65dbffa20b11e6f18b8abb9281d480c7ca402f51ed3d5977e6007
COPY aegis-realm.json /opt/keycloak/data/import/aegis-realm.json
