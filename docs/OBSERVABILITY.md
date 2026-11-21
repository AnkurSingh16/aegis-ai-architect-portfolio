# Observability: OpenTelemetry in the local platform (P7, first slice)

Status: implemented for the API and verified locally through the OpenTelemetry Collector. Not yet connected to a telemetry backend, not extended to the web tier or to agent execution. Not independently reviewed.

## 1. What runs

| Component | Implementation | Where |
| --- | --- | --- |
| API traces and metrics | Official OpenTelemetry SDK for Node (`@opentelemetry/sdk-node` 0.301.0), OTLP/HTTP exporters, HTTP and pg instrumentation (0.301.0 and 0.78.0) | `apps/api/src/observability/otel.ts` |
| Collector | Official `otel/opentelemetry-collector` 0.165.0, digest `sha256:34b24b74…ed1b73` (arm64 verified), configuration baked into the image | `infra/otel/` |
| Structured logs | JSON lines on stdout carrying `trace_id` and `span_id` of the active span | `apps/api/src/observability/log.ts` |
| Identity metric | `aegis.identity.verifications` counter with outcome `verified` or `refused` | `apps/api/src/auth/token.ts` |
| Route naming | A `preHandler` hook names the active span from Fastify's route template | `apps/api/src/app.ts` |

The SDK starts before the application loads: the API image runs `node --import @opentelemetry/instrumentation/hook.mjs --import ./apps/api/dist/observability/register.js apps/api/dist/server.js`. Telemetry is enabled by `AEGIS_OTEL_ENABLED=1` and is off by default outside the local stack.

## 2. What is exported

Verified by `scripts/telemetry-check.mjs` (12 checks, all passing at the time of recording):

- **Route spans** named by template, for example `GET /api/tenants/:tenantId/cases`. Raw URLs and identifiers are not used for names.
- **Database spans** from the pg instrumentation, with operation and database name only (`enhancedDatabaseReporting` is off, so no statement text).
- **Identity outcomes** as a metric, with values `verified` and `refused`. No subject, token or claim value.
- **HTTP server duration** histogram from the HTTP instrumentation.
- **Connection pool metrics** (`db.client.connection.*`) from the pg instrumentation.
- **Correlated logs**: the trace identifiers written to the API's JSON logs appear in the exported traces.

## 3. The attribute allowlist

Each span passes an allowlist in-process before export (`AllowlistSpanExporter`). Only these keys survive:
`http.request.method`, `http.method`, `http.route`, `http.response.status_code`, `http.status_code`, `network.protocol.version`, `url.scheme`, `server.address`, `server.port`, `db.system`, `db.system.name`, `db.operation`, `db.operation.name`, `db.collection.name`, `db.namespace`, `db.name`, `error.type`, `aegis.identity.outcome`, `aegis.operation`.

Span events are cleared, because exception messages can contain submitted values. Removed by design: `url.full`, `http.target`, `url.query`, `db.statement`, `user.id`, any `authorization` or header value, and exception text.

Unit tests (`otel.test.ts`) check the allowlist, that forbidden keys are never permitted, that the exporter filters attributes and clears events before the inner exporter runs, and the endpoint rule.

## 4. Where telemetry may go

The OTLP endpoint must be local: a loopback address, or a named service in `AEGIS_ALLOWED_SERVICE_HOSTS`, and only in a local deployment. Any external host is refused, whatever the scheme. The Collector is not published to the host. It is reachable only on the compose network.

## 5. Verification

```bash
node scripts/local-stack.mjs up
node scripts/telemetry-check.mjs
```

The check drives an authorised request, a forbidden request and an anonymous request, waits for the batch export, then reads the Collector's output. It asserts the presence of route spans, database spans, identity outcomes and HTTP duration, the correlation of log and trace identifiers, and the absence from the Collector output of bearer tokens, the test user's subject, SQL text, full URLs with query strings, and authorisation header values. It is part of `npm run test:stack`.

## 6. Limitations

- **Single backend-free sink.** The Collector's `debug` exporter writes to its own log. There is no trace store, dashboard, alerting or retention. Replacing the exporter is a configuration change in `infra/otel/collector.yaml`.
- **Logs are not exported over OTLP.** They are JSON lines on stdout, correlated by trace identifiers. Shipping them through the Collector (filelog or OTLP logs) is not done.
- **Two tracing mechanisms exist.** The earlier hand-written OTLP JSON exporter (`observability/tracing.ts`, enabled only by `AEGIS_TRACING=enabled`) is still wired to the workflow spans. It is not enabled in the local stack. Retiring it in favour of the SDK is a follow-up.
- **Fastify instrumentation did not attach** to this ESM build. Route spans are therefore named by the explicit hook rather than by the instrumentation. The HTTP and pg instrumentations do attach.
- **The Collector's receiver has no authentication.** It is reachable by any container on the compose network. Acceptable only in the local stack. Production needs authenticated and encrypted transport, which depends on the workload identity work (P3).
- **No web-tier telemetry.** The browser is not instrumented, so a trace does not start in the user's session.
- **No agent-execution telemetry yet.** There is no multi-agent runtime to instrument (C8 is design only).
- **Collector outage behaviour is not tested.** The batch processor drops data beyond its queue limits. The API is expected to continue serving, but this was not measured.
- **Metrics cardinality is not measured.** Route templates bound the labels, but no load test has verified this.
