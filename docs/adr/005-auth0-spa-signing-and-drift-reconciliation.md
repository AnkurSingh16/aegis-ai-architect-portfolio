# ADR 005: Auth0 SPA signing and drift reconciliation

## Status

Proposed for review. No Auth0 or HCP changes are authorized by this record.

## Context

The local React application uses Auth0's Authorization Code + PKCE flow and validates issuer-signed JWTs using JWKS. Auth0 SPA SDK requires RS256-signed JWTs. The Terraform API resource server separately uses RS256 and is not part of this change. Auth0 Support documents a Dashboard bug in which a default signing algorithm may be displayed although the backend has no `jwt_configuration.alg`. The previous Aegis Dashboard observation of HS256 is therefore not proof of the stored backend value. A local operator-only read helper was prepared to classify the exact Management API field without printing any other client settings; Codex has not called the live API.

The local Terraform provider lock pins `auth0/auth0` 1.59.0. Its installed schema defines `jwt_configuration` as an optional, maximum-one list block. `alg` is optional and non-computed; `lifetime_in_seconds` and `secret_encoded` are optional/computed; `scopes` is optional. Therefore, a plan that adds the block must be inspected for every nested before/after value; only `alg` may change. Any other nested difference or unknown value remains a stop condition.

The operator-supplied sanitized live evidence identifies four configurable SPA fields: `allowed_clients`, `async_approval_notification_channels`, `client_aliases`, and `client_metadata`, plus one provider-sensitive field whose name remains masked. All four fields are Optional in the pinned v1.59.0 client schema and are not explicitly configured in the Aegis HCL. The supplied evidence says each remote value matches both the refreshed pre-action baseline and planned desired value, but does not provide value shapes. That is compatible with provider/API normalization of omitted optional settings, but it does not prove normalization or authorization; `allowed_clients` can affect delegation and `client_metadata` may contain application-specific data. Historical Auth0 audit logs are unavailable.

The sanitized diagnostic reports only fixed value-shape categories for allowlisted non-sensitive fields. For a provider-sensitive field, it compares in memory only when the schema identifies the field as sensitive, both source values are present, sensitivity masks match the source value structures, and no unknown marker applies. It emits only `equal`, `different`, or `unavailable`; the sensitive attribute name and all values remain suppressed. Incomplete or contradictory metadata yields `unavailable`, which blocks state reconciliation.

## Decision

Configure only:

```hcl
jwt_configuration {
  alg = "RS256"
}
```

Preserve the API resource server's existing RS256 signing setting and all existing SPA identity, grant, OIDC, connection and URL settings. Treat all four named, unconfigured optional fields as unresolved until their sanitized value shapes and security impact are reviewed. Keep the sensitive field identity hidden; its equality result must be `equal` before state reconciliation can be considered.

The update-specific validator may accept a candidate plan only if it contains exactly one in-place update to `auth0_client.local_spa`, consisting of the three approved browser URL additions and `jwt_configuration.alg` changing from exactly an empty provider value to RS256. It rejects HS256, any other nonempty starting algorithm, unknown/sensitive or malformed values, and all changes to other top-level or nested JWT fields. It requires exactly the three declared Terraform outputs as verified no-ops and retains the exact five-resource inventory and existing HCP binding/freshness checks. Every nonempty `resource_drift` entry remains rejected. The validator must not infer or auto-accept the reported drift. The empty-string transition is consistent with the pinned provider's optional `alg` schema and historical HCL that omitted the field, and with Auth0's documented Dashboard behavior; the operator GET remains necessary to verify the live backend before any deployment proposal.

Terraform's JSON plan masks are sparse: omitted `after_unknown` leaves are known, and omitted sensitivity-mask leaves are non-sensitive. The validator therefore checks present mask entries against their corresponding before/after value shapes, rejects malformed or out-of-shape entries, and rejects any explicit unknown or sensitive marker under the JWT configuration. It does not require invented explicit `false` leaves.

## Operator evidence required before deployment

Use the sanitized read-only Terraform diagnostic to inspect the four field shapes, all three comparisons, and the masked sensitive equality result. Review the Auth0 Dashboard read-only for the security meaning and approval of `allowed_clients`, application metadata, and any nonempty optional settings; do not copy values into chat or logs or save Dashboard settings. Correlate available client update logs if present, while recognizing historical audit logs are unavailable. An empty/null/absent representation can be consistent with normalization but is not proof of a harmless or authorized change.

Deployment remains blocked until the four fields are reviewed, the sensitive equality is verified as `equal`, and a separately approved state/configuration reconciliation is complete. If the sensitive comparison is `different` or `unavailable`, stop. A read-only Management API GET may classify `jwt_configuration.alg` as missing, empty, HS256, RS256 or unexpected; it requests only `read:clients`, and missing permission is a stop rather than a reason to broaden access. Then require the candidate plan to show exactly the three URL additions plus the empty-to-RS256 application signing change, no other nested JWT changes, no unexpected outputs and no resource drift. Applying remains a separate human approval.

State reconciliation is distinct from Auth0 configuration deployment. A refresh-only plan is read-only, but applying it writes a new HCP state version and may record sensitive values. Do not propose that state write until all drifted fields and the sensitive-field impact are identified and approved. The separate local apply gate protects the plan, rechecks workspace/backend/state-version identity and inventory immediately before the state write, and requires two typed human approvals. Its implementation and merge do not authorize execution; the operator must separately accept the specific remote values and approve the exact plan fingerprint. The `allowed_clients` transition affects Auth0 client delegation/access associations and needs explicit review of the empty-list behavior. Afterwards, verify the finalized version and exact inventory through metadata only, then separately approve and perform local marker binding. After state-only reconciliation, the normal plan should show exactly the separately approved pending browser/signing update (zero add, one in-place update, zero destroy); a no-op plan is expected only after that update is separately deployed and verified. No refresh-only apply, binding, or deployment was performed for this ADR. A successful state-only reconciliation must leave the local marker unchanged until a separately approved `bind-reviewed-state`; the ordinary plan should then show only the pending browser/JWT update, with a no-op expected only after that deployment.

## Consequences

- Browser login continues to require the existing exact loopback callback, logout and web-origin URLs. `allowed_origins` and all port-49321 smoke URLs remain unchanged.
- The API continues validating RS256 access tokens independently of the SPA's ID-token signing setting.
- The current diagnostic evidence is insufficient to label the existing drift approved external change or provider normalization. It remains unexplained and security-relevant.
- The gate remains scoped to a reviewed candidate plan; it cannot resolve, suppress or refresh away drift. No `-refresh=false`, `-target`, manual state operation or automatic retry is permitted.
- The sensitive drift value is never logged, displayed, or compared by this ADR's evidence process.

## References

- [Auth0 SPA SDK invalid algorithm guidance](https://support.auth0.com/center/s/article/Invalid-Algorithm-Error-In-Auth0-SPA-JS)
- [Auth0 Support: Dashboard displays a default JWT algorithm when backend configuration is absent](https://support.auth0.com/center/s/article/id-token-returns-incorrect-jwt-signature-algorithm)
- [Auth0 Terraform provider v1.59.0 release](https://github.com/auth0/terraform-provider-auth0/releases/tag/v1.59.0)
- [Auth0 `auth0_client` resource documentation](https://registry.terraform.io/providers/auth0/auth0/1.59.0/docs/resources/client)
- [Terraform JSON plan format](https://developer.hashicorp.com/terraform/internals/json-format)
