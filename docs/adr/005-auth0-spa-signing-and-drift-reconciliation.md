# ADR 005: Auth0 SPA signing and drift reconciliation

## Status

Proposed for review. No Auth0 or HCP changes are authorized by this record.

## Context

The local React application uses Auth0's Authorization Code + PKCE flow and validates issuer-signed JWTs using JWKS. Auth0 SPA SDK requires RS256-signed JWTs; the current live SPA reports HS256 for its JWT application signing algorithm. The Terraform API resource server separately uses RS256 and is not part of this change.

The local Terraform provider lock pins `auth0/auth0` 1.59.0. Its installed schema defines `jwt_configuration` as an optional, maximum-one list block. `alg` is optional and non-computed; `lifetime_in_seconds` and `secret_encoded` are optional/computed; `scopes` is optional. Therefore, a plan that adds the block must be inspected for every nested before/after value; only `alg` may change. Any other nested difference or unknown value remains a stop condition.

The previously sanitized live diagnostic reported four configurable drifted SPA attributes, one sensitive drifted attribute, and one security-relevant affected setting. `allowed_clients` is one identified attribute. The remaining configurable names and sensitive attribute name/value are not available in the sanitized evidence. Four refreshed-value comparisons do not prove that changes were harmless or authorized, and historical Auth0 audit logs are unavailable.

## Decision

Configure only:

```hcl
jwt_configuration {
  alg = "RS256"
}
```

Preserve the API resource server's existing RS256 signing setting and all existing SPA identity, grant, OIDC, connection and URL settings. Keep the four unnamed configurable drift attributes and the sensitive attribute unresolved until an operator identifies them through read-only review.

The update-specific validator may accept a candidate plan only if it contains exactly one in-place update to `auth0_client.local_spa`, consisting of the three approved browser URL additions and `jwt_configuration.alg` changing from HS256 to RS256. It must preserve every other top-level and nested JWT value, reject unknown/sensitive or malformed values, require exactly the three declared Terraform outputs as verified no-ops, and retain the exact five-resource inventory and existing HCP binding/freshness checks. Every nonempty `resource_drift` entry remains rejected. The validator must not infer or auto-accept the reported drift.

Terraform's JSON plan masks are sparse: omitted `after_unknown` leaves are known, and omitted sensitivity-mask leaves are non-sensitive. The validator therefore checks present mask entries against their corresponding before/after value shapes, rejects malformed or out-of-shape entries, and rejects any explicit unknown or sensitive marker under the JWT configuration. It does not require invented explicit `false` leaves.

## Operator evidence required before deployment

Use read-only Auth0 Dashboard inspection to identify all four configurable drift attributes and the sensitive field without copying its value. Check SPA application authentication method, grant types, application type, JWT signing algorithm, delegation / Allowed Apps setting (`allowed_clients`), and any other named drifted fields. Correlate available client update logs with the known Terraform update. Audit history is unavailable, so missing historical attribution cannot be replaced by assumption. Do not modify or save Dashboard settings during this review.

Deployment remains blocked until the drift is fully identified and reconciled in an explicitly reviewed Terraform state/configuration path and a fresh plan shows no drift. If the sensitive value cannot be safely verified, stop for security review. Then require the candidate plan to show exactly the three URL additions plus the HS256-to-RS256 application signing change, no other nested JWT changes, no unexpected outputs and no resource drift. Applying remains a separate human approval.

## Consequences

- Browser login continues to require the existing exact loopback callback, logout and web-origin URLs. `allowed_origins` and all port-49321 smoke URLs remain unchanged.
- The API continues validating RS256 access tokens independently of the SPA's ID-token signing setting.
- The current diagnostic evidence is insufficient to label the existing drift approved external change or provider normalization. It remains unexplained and security-relevant.
- The gate remains scoped to a reviewed candidate plan; it cannot resolve, suppress or refresh away drift. No `-refresh=false`, `-target`, manual state operation or automatic retry is permitted.
- The sensitive drift value is never logged, displayed, or compared by this ADR's evidence process.

## References

- [Auth0 SPA SDK invalid algorithm guidance](https://support.auth0.com/center/s/article/Invalid-Algorithm-Error-In-Auth0-SPA-JS)
- [Auth0 Terraform provider v1.59.0 release](https://github.com/auth0/terraform-provider-auth0/releases/tag/v1.59.0)
- [Auth0 `auth0_client` resource documentation](https://registry.terraform.io/providers/auth0/auth0/1.59.0/docs/resources/client)
- [Terraform JSON plan format](https://developer.hashicorp.com/terraform/internals/json-format)
