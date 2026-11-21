# SPIRE server with the AEGIS configuration baked in. Pinned upstream image; the CA and bundle are NOT in the image (they are mounted
# from AEGIS_SPIRE_SECRETS_DIR at run time). The data directory is created owned by the upstream user (1000) so that a new named
# volume inherits that ownership.
FROM ghcr.io/spiffe/spire-server@sha256:16607dd148640cecbfba5cc620d0ba346350eacd5bc4105448fed867f6c08c77
COPY --chown=1000:1000 server.conf /opt/spire/conf/server/server.conf
COPY --chown=1000:1000 data/ /opt/spire/data/
