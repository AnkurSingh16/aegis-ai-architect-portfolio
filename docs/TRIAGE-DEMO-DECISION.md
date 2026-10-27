# Decision: local deterministic case triage

## Scope and data flow

React presents three invented cases, submits only an allowlisted `caseId` to `POST /api/demo/triage`, checks the returned contract and case identity, and displays a fixed recommendation. Fastify validates the exact request shape before looking up a deterministic fixture. No state is persisted and no support action is executed.

The examples cover an incident/high-priority outage, medium-priority billing review, and low-priority documentation guidance. Results have no random values or timestamps. Repeating a request produces the same response.

## Trade-offs

One browser-safe TypeScript module under the API source owns types, case descriptors, JSON schemas and a response guard. This keeps the existing API build layout and introduces no dependencies or additional build step. The frontend deliberately depends on that API-owned module; extract a shared package if another consumer needs it.

Fixed cases provide an inspectable end-to-end workflow without accepting real customer text. They do not implement the roadmap's authenticated multi-tenant foundation, retrieval, inference or approved escalation flow. A database, queue, model service and action executor would add scope without improving this demonstration.

## Failure and threat boundaries

- Reject unknown IDs, missing/extra fields and wrong types without coercion. Limit triage bodies to 1 KiB.
- Return nontechnical errors without echoing request bodies, stack traces or validator internals. Request logging is disabled.
- Validate response enums, bounded text, literal mock labels and matching case identity in the browser. Render strings through React text nodes.
- Disable selection/submission while pending, expire requests after ten seconds, abort on unmount, and ignore late responses. Selection changes and retries clear earlier output.
- Bind development servers to loopback; omit demo routes in production and hide the production triage form. This is not authentication: never expose development servers publicly.
- No secrets, external AI calls, customer records, tenant data or executed actions. Paid-service cost is zero; ordinary local compute remains the developer's responsibility.

## Acceptance and verification

All three cases must produce repeatable recommendations through the HTTP boundary. Tests must cover deterministic outputs, contract rejection, invalid requests, production exclusion, pending/retry/reset behavior, wrong-case responses, timeout and cleanup. Lint, typecheck, tests, coverage and build must pass without reducing existing coverage thresholds. This decision does not authorize deployment, commits to main, pushes or merges.
