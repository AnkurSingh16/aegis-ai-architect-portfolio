# C5 observability: what is built, and what production needs (no infrastructure changed)

Status: the repository contains the instrumentation. Retention, shipping and alerting are production infrastructure and are
not configured here. Nothing in this document changes a deployment.

## What the repository emits

| Signal | Where | Enabled by default | Contents (allowlisted) |
| --- | --- | --- | --- |
| Driver log lines (JSON, stdout) | `workflow/durable-driver.ts`, triage route | yes | event, execution id, correlation id, trace id, outcome, attempt, error class, reason, duration |
| Route log lines (JSON, stdout) | `workflow/workflow-routes.ts` | yes | event, request id, correlation id, route, outcome, execution id, state, count |
| Process metrics (Prometheus text) | `workflow/workflow-metrics.ts`, `observability/metrics-endpoint.ts` | **no**: needs `AEGIS_METRICS_ENDPOINT=enabled` and a token with `observe:metrics` | counters and duration histogram by outcome; fixed labels only |
| Spans (OTLP/HTTP JSON) | `observability/tracing.ts` | **no**: needs `AEGIS_TRACING=enabled` and `AEGIS_OTLP_ENDPOINT` on loopback | span name `workflow.triage`, trace id from the incoming `traceparent`, outcome, attempt, duration |

## What is never emitted

Case text, questions, answers, tool arguments, output, actor names, cancellation reasons, error messages, approval ids,
tenant ids in metrics, and bearer tokens. The span code uses an allowlist, and an integration test checks that the case id sent in a triage request does not
appear in the exported span. The metrics endpoint test checks that its body contains no tenant, execution, correlation or case identifiers.

## Requirements for production (owner and infrastructure, not this repository)

1. **Retention.** Driver and route log lines are kept for a period set by the data owner. The minimum for incident review is
   the period in which a dead-letter can be requeued. The period is a decision, and it is not chosen here.
2. **Shipping.** A log shipper reads stdout from the API process to a central store. The shipper must run in the same
   network zone as the API, and the store must be access-controlled. Log lines contain identifiers only, so access to them
   is still personal-data processing where a tenant user is identifiable. Treat them as operational data.
3. **Correlation.** Operators join a request to its driver lines by `correlationId`, and to an upstream trace by `traceId`.
   Callers that need this must send `x-correlation-id` and a valid `traceparent`.
4. **Metrics access.** The endpoint stays disabled in production until the identity configuration defines a dedicated
   operator scope and assigns it. Scrapes must come from a network that is allowed to read operational counts.
5. **Tracing.** Export is off by default. A production collector would be remote, which the exporter currently refuses. A
   remote collector needs an owner decision on data residency and an exporter change reviewed on its own.
6. **Alerting.** Recommended, not built: alert on a rising `aegis_workflow_attempts_total{outcome="failed"}` rate,
   on `error` outcomes, and on the dead-letter count (the dead-letter route is the source for that count).

## Open decisions

- Retention period and the owner of the log store.
- The operator scope name in the identity configuration (the repository uses `observe:metrics`).
- Whether a remote trace collector is ever permitted.
