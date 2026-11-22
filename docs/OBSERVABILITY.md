# Observability: OpenTelemetry, Collector and local backends (P7)

Status: **implemented and verified locally** for the API, the browser-to-API path, the database, identity outcomes and the probes. Not independently reviewed. Thresholds are provisional development values. No production SLOs are claimed.

## 1. Running services (compose project `aegis-local`)

| Service | Image (pinned by digest, arm64) | Role | Host port |
| --- | --- | --- | --- |
| `otel-collector` | `otel/opentelemetry-collector` 0.165.0 (core) | Ingestion and processing boundary: OTLP receiver, memory limiter, batching, bounded retrying exporters | none |
| `tempo` | `grafana/tempo` 2.9.5 | Trace storage and search (72 h retention) | none |
| `loki` | `grafana/loki` 3.6.22 | Log storage and search (72 h retention, compactor-enforced) | none |
| `prometheus` | `prom/prometheus` v3.13.5 | Metric storage and query (3 days or 2 GB, whichever comes first); native OTLP receiver for pushed metrics; alert rules | none |
| `blackbox-exporter` | `prom/blackbox-exporter` v0.28.0 | HTTP probes of the API liveness and readiness, the identity provider, and the web app | none |
| `grafana` | `grafana/grafana` 12.4.15 | Pre-provisioned data sources, a dashboard, and the alert-rule view | `127.0.0.1:3300` (authenticated, anonymous access off) |
| `api` | same API image | OpenTelemetry SDK: traces, metrics, and logs, exported to the Collector | 4110 (existing) |

Collector distribution decision: every exporter used here is a core component (`otlp_http`), because Tempo, Loki and Prometheus accept OTLP natively. The contrib distribution is therefore not needed and is not used. Adding Loki's or Prometheus's contrib-only exporters would require the contrib image and a documented change.

Versions: the chosen releases are the most recent stable tags on their release lines that were older than the newest tags at selection time. The two-week age check could not be verified mechanically for every image (the registry's per-tag endpoint did not return a date in this environment). Re-check release ages before a promotion.

## 2. Signals

**Traces.** Route spans are named by the Fastify route template (for example `GET /api/tenants/:tenantId/cases`), set by an explicit hook. The HTTP and PostgreSQL instrumentations produce the child spans. Fastify's own instrumentation did not attach to this ESM build, so it is not relied on.

**Metrics.** `http.server.request.duration` (route and status labels), `db.client.*` (pool and operation timings), `aegis.identity.verifications` (labelled `aegis.identity.outcome` = `verified` or `refused`), the blackbox `probe_success` series, and the Collector's own `otelcol_*` telemetry.

**Logs.** Each structured event is written as a JSON line to stdout and as an OpenTelemetry log record. The record carries the active trace and span identifiers. Two events exist: `http_request_completed` (every request: route template, status, outcome) and `protected_case_request` / `identity.refused` (failures). In Loki the trace identifier is structured metadata, not an index label, so it adds no streams.

## 3. Attribute allowlists (all three signals)

- **Traces:** `SPAN_ATTRIBUTE_ALLOWLIST` in `observability/otel.ts`. Route, method, status, network protocol, server address, database system and operation names, error type. Span events are cleared, because exception messages can contain submitted values.
- **Logs:** `LOG_ATTRIBUTE_ALLOWLIST` in `observability/log.ts`. Outcome, code, reason, request identifier (random, per request), route template, status, identity outcome, bounded readiness counts. Values are truncated to 120 characters.
- **Metrics:** only the labels listed in section 2, all bounded by route templates and fixed outcome sets.

Excluded by design across all signals: bearer tokens, subjects and other identifiers of a person, raw headers, query strings, request and response bodies, SQL text and parameters, full URLs, and secrets. A caller cannot add one of these by passing it to `logEvent`, because the allowlist drops it before either output.

Verified in the stored data (not only in code): the telemetry check searches Tempo, Loki and Prometheus for the test token, the test user's subject, SQL text, the query string marker and the authorization header. All are absent.

## 4. Where telemetry may go

The export endpoint must be local (loopback, or a named service listed in `AEGIS_ALLOWED_SERVICE_HOSTS`, in a local deployment). Any external host is refused in every scheme (`validateCollectorEndpoint`, unit-tested). Only Grafana is published to the host, and only on loopback. The Collector, Tempo, Loki, Prometheus and the probe exporter have no host port.

## 5. Failure behaviour (measured)

| Condition | Measured behaviour |
| --- | --- |
| Tempo stopped for about 2 minutes under traffic | The API keeps serving (readiness 200, protected requests 200). The Collector holds trace batches in its bounded queue, then records failed exports once its retry window (120 s) is exhausted. |
| Collector memory during and after the outage | 37–44 MiB before, during and after; the limiter bound is 200 MiB. No unbounded growth observed. |
| Tempo restarted | Traces are stored again within the recovery window. Verified by searching only the window after the restart. |
| API stopped | The `AegisApiUnavailable` and `AegisReadinessFailing` alerts fire, and both resolve after the API recovers. |
| Prometheus, Loki, Tempo and Grafana restarted | Stored probe series and traces survive (volumes). |

Decision on the retry window: 120 s (was 300 s). A shorter window surfaces a sustained backend outage as failed exports within the time an operator watches, at the cost of dropping batches that could not be delivered within two minutes. This is a development value to be reviewed.

## 6. Alerts (provisional thresholds)

Defined in `infra/observability/aegis-rules.yml` and loaded by Prometheus. Grafana shows them through the Prometheus data source. No notification routing (Alertmanager, email, chat) is configured.

| Alert | Condition | Verified |
| --- | --- | --- |
| `AegisApiUnavailable` | liveness probe failing for 30 s | fires and resolves (outage check, phase A) |
| `AegisReadinessFailing` | readiness probe failing for 30 s (database or migrations) | fires during the API outage |
| `AegisIdentityProviderUnavailable` | identity provider readiness probe failing for 30 s | loaded; not exercised in this run |
| `AegisHighServerErrorRate` | more than 5% of requests return 5xx over 5 min | loaded; not exercised |
| `AegisHighRequestLatency` | p95 above 1 s over 5 min | loaded; not exercised |
| `AegisIdentityRefusalsElevated` | more than 0.5 token refusals per second over 2 min | loaded; not exercised. Identity outages and key retirements produce this pattern. |
| `AegisTelemetryExportFailing` | Collector failing to deliver to a backend over 2 min | loaded; the export failure counter increases during the Tempo outage |

Not exercised: the error-rate, latency and refusal alerts were not driven to firing in this run. They are loaded, evaluated and visible, but their trigger was not produced. This is recorded as a gap, not claimed.

## 7. Dashboard

`AEGIS local overview (provisional thresholds)`, provisioned from `infra/observability/grafana/dashboards/aegis-overview.json` and read-only in the UI. Panels: liveness, readiness, identity provider and web probes; request rate by route and status; API p95 latency; authentication outcomes; database p95; telemetry export failures; API logs.

## 8. Operator procedures

- **Start:** `node scripts/local-stack.mjs up`. Grafana: `http://127.0.0.1:3300`, user `aegis-admin`, password in `.env.local` (`AEGIS_GRAFANA_ADMIN_PASSWORD`, never printed).
- **Investigate a request:** in Grafana Explore, Tempo, search `{resource.service.name="aegis-api"}`; open the trace and follow the logs link (the Tempo data source links to Loki by trace identifier).
- **Backend outage:** the application keeps serving. Restore the backend (`docker compose ... start tempo`); traces resume. Batches older than the retry window are not recovered.
- **Retention change:** edit the retention in the backend's configuration under `infra/observability/`, rebuild, and restart. Existing data is kept within the volume.

## 9. Verification commands

```bash
npm run test:stack                  # includes telemetry-check (backend queries) and the browser suite
node scripts/telemetry-check.mjs    # stored traces, logs, metrics and the sensitive-value exclusions
npm run test:observability          # outage and recovery: alerts, backend outage, memory bounds, persistence (about 12 minutes)
```

The browser suite includes `observability.spec.ts`: a real authenticated browser request is found in Tempo by its route span, and its trace identifier returns a Loki log record.

## 10. Risks and open items

- **Tempo discards incomplete WAL blocks on restart: this is data loss, not only a recoverability risk.** Investigated in P3 (2026-11-21):
  - Mechanism: when Tempo is stopped while it is ingesting, its shutdown logs `Abandoning op in flush queue because ingester is shutting down`
    and exits. A WAL block that was being written is left without `meta.json`. On the next start, replay logs `failed to replay block.
    removing.` and deletes the directory. Tempo has no way to recover those spans.
  - Evidence in this stack: 8 removals were logged between 09:59 and 10:25 UTC, all during repeated restarts in the outage checks. A
    controlled stop under load (`docker stop`, default options) reproduced one more removal. Idle stops, and a SIGKILL while idle, removed
    nothing. A SIGKILL under load replayed cleanly in the one run made. The number of spans lost per removal was not measured.
  - Scope: only spans in the block being written at stop time, as far as the evidence shows. In the idle SIGKILL run, 25 traces were found
    before the stop and 26 after the restart, so nothing written earlier was lost. The loaded runs did not count spans before and after,
    so the exact extent of loss under load is not established.
  - Mitigations (not yet applied; each needs its own evidence before adoption): give Tempo a longer shutdown window and verify that the
    flush completes; shorten the head block duration so fewer spans are ever in an unflushed block; make the Collector's sending queue
    persistent (file-backed) so spans can be re-sent after a backend restart. The Collector queue is in-memory today, so a Collector restart
    also loses its queued batches.
  - Until a mitigation is verified, treat local traces as best-effort diagnostics, not an audit record.
  - Re-investigation in P4 (2026-11-21), status **still open**:
    - Log evidence, read in detail. An abandoned flush op (`Abandoning op in flush queue`) is not lost: its WAL block is replayed on the next
      start and reloaded (for example block `0cd6030f`). The blocks removed on replay (`failed to replay block. removing.`) are different
      directories, without `meta.json`, which were the head blocks still open at stop time. Their contents were not recovered, but the number
      of spans in them was not measured in any incident.
    - Tempo 2.9.5 configuration checked against the binary. There is no ingester option that flushes every open block on shutdown. The
      relevant settings are `-shutdown-delay`, `-ingester.max-block-duration` (default 30 m) and `-ingester.max-block-bytes`. None is changed here.
    - Collector queue: in-memory. A persistent queue needs the `file_storage` extension, which is in the contrib distribution and not in the
      core distribution this stack uses. Not adopted.
    - Reproduction: `scripts/tempo-wal-check.mjs` (`npm run test:tempo-wal`). It sends anonymous API requests (each stores one root span named
      `GET`), stops and starts Tempo while the load runs, and measures loss end to end (responses minus traces stored after settling).
      Results: unordered stop, 300 requests twice and 3,000 requests once: no loss and no replay removals in those three runs. The loss was
      not reproduced at these volumes.
    - Ordered stop (Collector first, then Tempo) was measured as a candidate and **rejected**: it lost 300 of 300 traces at 300 requests and
      444 of 3,000 at 3,000 requests. The loss is on the API side. Its batch span processor still held spans when the Collector stopped, and
      it does not retry long enough to survive the outage. Stopping the Collector first is only safe after the API has drained its queue,
      which the stack does not enforce.
    - Next steps, each needing its own evidence before adoption: find a load that does reproduce the removal (the loss was seen during the
      repeated outage checks, not under this script's load); measure a shorter `max-block-duration` against that reproduction; measure the
      API's span export retry window before choosing any ordering procedure.
- **Telemetry is sent without authentication.** The OTLP receiver accepts any client on the compose network. Acceptable only in the local stack. Production needs authenticated, encrypted transport, which depends on workload identity (P3).
- **Logs are not authenticated end to end.** Anyone with Grafana access can read the logs (allowlisted fields only). Grafana access control is the admin account in this stack.
- **Old exporter.** The earlier hand-written OTLP JSON exporter (`observability/tracing.ts`, `AEGIS_TRACING`) is still wired to the workflow spans. It cannot run together with the SDK (`assertSingleTracingExporter` refuses startup). Migrating the workflow spans onto the SDK and removing the old exporter is the remaining step.
- **Notification routing is not configured.** Alerts are visible in Grafana and Prometheus; nothing pages anyone.
- **Thresholds are provisional.** Not calibrated, and not SLOs.
- **Cardinality is bounded by design, not measured under load.**
- **Browser telemetry.** The browser is not instrumented; traces start at the API.
- **Not independently reviewed.**

## 11. P5 messaging telemetry

The P5 runtime (dispatcher and inbox) and the agent proxies export through the same Collector. Metric labels are bounded: outcomes, a closed reason set, and the agent identifier from the fixed registry. Tenant, execution and message identifiers, payloads and envelopes never become labels.

| Instrument | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `aegis.outbox.enqueued` | counter | none | Outbound messages committed with their P4 decision |
| `aegis.outbox.deliveries` | counter | `outcome`, `reason`, `agent` | Delivery decisions: delivered, retry, dead, ack_refused |
| `aegis.outbox.delivery.duration` | histogram (ms) | `agent` | One delivery attempt, from send to response |
| `aegis.outbox.attempts` | histogram | `agent` | Attempts a message took to reach its final state |
| `aegis.outbox.lease.recoveries` | counter | `agent` | Messages re-leased after an expired lease |
| `aegis.outbox.pending` | gauge | `agent` | Undelivered messages for the sending agent |
| `aegis.outbox.oldest_pending_age` | gauge (s) | `agent` | Age of the oldest undelivered message |
| `aegis.outbox.requeues` | counter | none | Operator requeues of dead-lettered messages |
| `aegis.inbox.decisions` | counter | `outcome`, `reason`, `agent` | Inbound decisions: processed, duplicate, refused, transient |
| `aegis.inbox.duplicates` | counter | `agent` | Repeated deliveries suppressed by the inbox |

Spans: `aegis.message.deliver` (dispatcher), `aegis.message.inbound` and `aegis.message.outbound` (proxies). Span attributes are allowlisted: message and execution identifiers (random UUIDs), agent identifiers, the bounded outcome and reason, and the attempt number. W3C `traceparent` is forwarded for correlation only; it grants nothing. P4's `aegis.agent.*` instruments are emitted by the same runtime for every store decision.
