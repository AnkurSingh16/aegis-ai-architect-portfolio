#!/bin/sh
# Writes the public runtime configuration the application reads at startup. Runs once when the container starts, so the same image is
# promoted between environments by changing environment variables. Every value is checked against a strict pattern before it is written,
# and the application validates the same contract again. No secret, password or client secret is ever placed in this file.
set -eu
out=/usr/share/nginx/html/config.json

# Content Security Policy. Generated from the same configuration, so the identity provider origin is the one the application uses.
# No inline script, no eval, no inline style. The identity provider is allowed for redirects, the hidden renewal frame and form posts only.
headers=/etc/nginx/aegis-security-headers.conf
idp_origin=""
if [ "${AEGIS_WEB_OIDC_ENABLED:-false}" = "true" ]; then
  idp_origin=$(printf '%s' "${AEGIS_WEB_OIDC_ISSUER:-}" | sed -n 's#^\(https\{0,1\}://[^/]*\).*#\1#p')
fi
# style-src and font-src allow the two Google Fonts origins that the stylesheet loads. This is a deliberate, narrow exception; self-hosting
# the fonts is the follow-up (docs/WEB-AUTHENTICATION.md section 8).
policy() { printf "%s" "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'${idp_origin:+ $idp_origin}; frame-src 'self'${idp_origin:+ $idp_origin}; form-action 'self'${idp_origin:+ $idp_origin}; base-uri 'self'; object-src 'none'; $1"; }
printf 'add_header X-Content-Type-Options nosniff always;\nadd_header Referrer-Policy no-referrer always;\nadd_header Content-Security-Policy "%s" always;\n' "$(policy "frame-ancestors 'none'")" > "$headers"
# The renewal page is the only page that may be framed, and only by this same origin.
printf 'add_header X-Content-Type-Options nosniff always;\nadd_header Referrer-Policy no-referrer always;\nadd_header Content-Security-Policy "%s" always;\n' "$(policy "frame-ancestors 'self'")" > /etc/nginx/aegis-security-headers-silent.conf

if [ "${AEGIS_WEB_OIDC_ENABLED:-false}" != "true" ]; then
  printf '{"version":1,"oidc":null}\n' > "$out"
  echo "aegis-web: sign-in disabled (AEGIS_WEB_OIDC_ENABLED is not true)"
  exit 0
fi

fail() { echo "aegis-web: invalid runtime configuration: $1" >&2; exit 1; }
check() { printf '%s' "$2" | grep -Eq "$3" || fail "$1"; }
check ENVIRONMENT "${AEGIS_WEB_ENVIRONMENT:-}" '^(local|staging|production)$'
check ISSUER "${AEGIS_WEB_OIDC_ISSUER:-}" '^https?://[A-Za-z0-9._:/-]{1,200}$'
check CLIENT_ID "${AEGIS_WEB_OIDC_CLIENT_ID:-}" '^[A-Za-z0-9._-]{1,200}$'
check AUDIENCE "${AEGIS_WEB_OIDC_AUDIENCE:-}" '^[A-Za-z0-9._:/-]{1,255}$'
check SCOPES "${AEGIS_WEB_OIDC_SCOPES:-}" '^[-A-Za-z0-9:_. ]{1,255}$'
check REDIRECT_PATH "${AEGIS_WEB_REDIRECT_PATH:-/}" '^/[A-Za-z0-9/_.-]{0,200}$'
check POST_LOGOUT_PATH "${AEGIS_WEB_POST_LOGOUT_PATH:-/}" '^/[A-Za-z0-9/_.-]{0,200}$'
check SILENT_RENEW "${AEGIS_WEB_SILENT_RENEW:-true}" '^(true|false)$'
check DEMO_ROUTES "${AEGIS_WEB_DEMO_ROUTES:-false}" '^(true|false)$'

scopes_json=$(printf '%s' "$AEGIS_WEB_OIDC_SCOPES" | awk '{ for (i = 1; i <= NF; i++) printf "%s\"%s\"", (i > 1 ? "," : ""), $i }')
printf '{"version":1,"oidc":{"environment":"%s","issuer":"%s","clientId":"%s","audience":"%s","scopes":[%s],"redirectPath":"%s","postLogoutRedirectPath":"%s","apiBasePath":"/api","silentRenew":%s,"features":{"demoRoutes":%s}}}\n' \
  "$AEGIS_WEB_ENVIRONMENT" "$AEGIS_WEB_OIDC_ISSUER" "$AEGIS_WEB_OIDC_CLIENT_ID" "$AEGIS_WEB_OIDC_AUDIENCE" "$scopes_json" \
  "${AEGIS_WEB_REDIRECT_PATH:-/}" "${AEGIS_WEB_POST_LOGOUT_PATH:-/}" "${AEGIS_WEB_SILENT_RENEW:-true}" "${AEGIS_WEB_DEMO_ROUTES:-false}" > "$out"
echo "aegis-web: runtime configuration written for environment ${AEGIS_WEB_ENVIRONMENT}"
