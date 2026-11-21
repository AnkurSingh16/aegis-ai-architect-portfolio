# SPIRE agent with the AEGIS configuration baked in. Pinned upstream image. Node credentials are mounted at run time from
# AEGIS_SPIRE_SECRETS_DIR; the image holds no credential.
FROM ghcr.io/spiffe/spire-agent@sha256:df9502625d910710f48b27eb861345ffeb3cd91c79a874f989f2150c391fd9f9
COPY agent.conf /opt/spire/conf/agent/agent.conf
