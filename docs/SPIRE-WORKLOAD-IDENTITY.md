# SPIRE workload identity and explicit mTLS (P3)

Status: **implemented and verified locally** for four independently deployed agent workloads (orchestrator, triage, retrieval, reviewer), on
the local Docker Desktop stack. Workload attestation is **socket-free** (x509pop node attestation, Unix workload attestation). It is not
production-equivalent: section 9 states exactly what is and is not demonstrated.

Approval: the socket-free design was approved for the local AEGIS infrastructure only. No Docker socket, no privileged container, no host
networking, no broad host filesystem access. Credentials live outside the repository.

## 1. Architecture

```
            spire-control (internal)                       agent-mesh (internal)
 +-----------------+   x509pop   +-----------------+    +-----------------------+
 | spire-server    |<----------- | spire-agent-X   |    | X (workload, uid N)   |
 | (trust domain   |  attested   | pid: service:X  |--->| Workload API socket   |
 |  aegis.local)   |  SVIDs      | (shares X's PID |    | volume spire-socket-X |
 +-----------------+             |  namespace)     |    +-----------------------+
                                 +-----------------+           ^ mTLS (SVIDs)
                                                              peers X <-> Y
```

- One SPIRE **server** and one SPIRE **agent per workload container**. The agent joins its workload's PID namespace
  (`pid: service:<workload>`), which is not the host namespace and is not privileged. This is what lets the Unix attestor see the calling
  process.
- Each agent has its **own node identity** (an x509pop certificate for its own CN). A registration is bound to the agent of exactly one
  workload.
- The Workload API socket for each workload lives in a **per-workload named volume** that no other workload mounts.
- Only **spire-server** and the agents attach to `spire-control`; only workloads and the collector attach to `agent-mesh`. Both networks are
  `internal: true` (no route to the internet or the host).
- Every workload runs as a **distinct non-root UID** (1001 orchestrator, 1002 triage, 1003 retrieval, 1004 reviewer). The workload binary is
  the same for all roles; the identity is decided by the registration, never by the binary, its arguments or its environment.

Files: `infra/spire/server/` and `infra/spire/agent/` (pinned upstream images plus configuration), `infra/spire/workload/` (the Go
workload, go-spiffe v2.5.0), `infra/spire/policy.json` (peer policy, baked into the workload image), `infra/spire/registrations.json`
(entries), `scripts/spire-bootstrap.mjs`, `scripts/spire-register.mjs`, `scripts/spire-acceptance.mjs`.

Pinned images (digests in `docker-compose.yml` and the Dockerfiles): `ghcr.io/spiffe/spire-server:1.13.3`, `ghcr.io/spiffe/spire-agent:1.13.3`
(published 2025-10-23, older than two weeks). The workload build uses `golang:1.24-bookworm` and runs on `node:24-bookworm-slim`.

## 2. Node attestation and the bootstrap credential

Node attestation uses **x509pop**: the server trusts a local CA, and each agent proves possession of a certificate issued by it.

**Create.** `node scripts/spire-bootstrap.mjs` creates, in `AEGIS_SPIRE_SECRETS_DIR` (default
`~/Library/Application Support/aegis-local-secrets/spire`, mode 0700, refused if inside the repository):

- `ca.key` / `ca.crt`: the x509pop CA (ECDSA P-256, 2-year validity).
- `node-<name>.key` / `.crt`: one node credential per agent (90-day validity, clientAuth only).
- `bundle.pem`: the SPIRE trust bundle read from the running server, used by agents to verify the server.

Keys are mode 0600. The script prints paths, subjects and expiry dates only. The server gets `ca.crt` (public) only. Each agent gets only its
own `node-<name>.crt/.key`, mounted read-only. No credential is baked into an image, and no credential is committed.

**Renew.** Node certificates expire after 90 days. Re-run the bootstrap after replacing the material (section 2.1). The agent re-attests with
the new credential when it restarts.

**Replace (routine).** `node scripts/spire-bootstrap.mjs --rotate-node <name>` replaces one node key and certificate. Then restart
`spire-agent-<name>`. The old node identity remains registered on the server until purged (`agent purge`), so purge it after the restart.

**Recover after compromise.**
- A single node credential is suspected: `spire-server agent ban -spiffeID <agent id>` (the agent can no longer attest or re-attest, and its
  SVIDs stop being renewed), then `--rotate-node <name>`, then restart the agent, then `agent purge` for the banned ID. Re-run
  `scripts/spire-register.mjs` (it creates the entries for the new agent ID).
- The CA is suspected: stop the stack, delete the secrets directory's CA and every node credential, re-run the bootstrap (a new CA, a new
  bundle), recreate `spire-server-data` (its trust domain keys), then re-register. Every existing SVID is invalid after that, because the
  trust bundle changes. This is a full re-issuance.

**What the bootstrap credential can do.** It proves that an agent belongs to this local trust domain. It does not, by itself, grant any
workload an identity. Registrations and the workload's UID do that.

### 2.1 Where the keys sit (Docker Desktop)
The CA and node keys are bind-mounted from the secrets directory into the server and agent containers only. They are not in the repository,
the images, or the Docker volumes. Docker Desktop's file sharing reads them from the host home directory.

## 3. Workload attestation (Unix selectors)

Each registration has one selector, `unix:uid:<UID>`, and a parent equal to the agent of the same workload. The agent's Unix attestor reads
the calling process's UID from `/proc` in the shared PID namespace. A caller that cannot be resolved is refused before any identity is
considered.

Entries are created by `scripts/spire-register.mjs` from `infra/spire/registrations.json`. It is idempotent and fail-closed: an entry whose
parent or selector differs is reported as a conflict and not overwritten.

## 4. Peer authorisation (explicit, not trust-domain-wide)

A certificate from the trust domain is **not** enough. Each workload loads `policy.json`, which maps its own SPIFFE ID to the peer IDs it accepts:

| Server | Accepts clients |
| --- | --- |
| orchestrator | none |
| triage | orchestrator |
| retrieval | orchestrator, triage |
| reviewer | orchestrator |

- The **server** checks the client's ID during the handshake (`tlsconfig.Authorizer`). A refused peer never gets an HTTP response.
- The **client** requires the exact expected server ID (`tlsconfig.AuthorizeID`). A wrong peer is refused on the client side.
- The **policy** fails closed: a workload with no entry does not serve; a policy entry from another trust domain is refused at load time.
- The workload's own identity is taken from its SVID, never from a message, environment variable or request parameter.

## 5. Credential lifecycle

- SVIDs have a **5-minute** TTL (`default_x509_svid_ttl`, and per entry). The workload's `X509Source` renews them automatically; the process
  is not restarted and TLS uses the current SVID for every new handshake.
- Outage behaviour: while the server or the agent is down, a workload keeps using its current SVID until it expires. After expiry, the
  handshake is refused. Recovery is automatic once the dependency returns.
- Trust bundle: the workload and agents use the bundle from the Workload API. A chain that does not verify against that bundle is refused
  (section 6).

## 6. Adversarial evidence

Run `node scripts/spire-acceptance.mjs` (add `--outage` for the outage phase). Results are recorded in section 8.

| Case | Expected | Mechanism that refuses it |
| --- | --- | --- |
| Unregistered container with the same UID (1002) | no SVID | its own agent finds no entry (`registered=false`) |
| Same-UID container handed triage's socket volume | no SVID | triage's agent cannot resolve the caller (different PID namespace: "could not resolve caller information") |
| Root or UID 1003 inside triage's own container | no SVID | no entry for that UID under triage's agent |
| Reviewer calls triage (not authorised) | refused at handshake | triage's peer policy |
| Retrieval calls orchestrator (not authorised) | refused at handshake | orchestrator accepts no clients |
| Orchestrator calls triage expecting retrieval's ID | refused by client | exact-ID check |
| Impersonation: a server claiming `spiffe://aegis.local/workload/triage` in a certificate signed by an untrusted CA | refused | `x509: certificate signed by unknown authority` |
| Workload signals the agent process (`kill -9`) | denied | different UID; the agent runs as root with all capabilities dropped |
| Workload reads the agent's node key or data volume | not present | the key is mounted only into the agent container; the data volume only into the agent |

**Known limit (asserted, not hidden).** A second process running as the same UID *inside triage's own container* receives triage's
identity. The container is the workload boundary, not the process. This is why each workload has its own container and why no other
workload shares its socket volume.

## 7. Observability (P7 integration)

Metrics (Prometheus, scraped on the internal networks):
- SPIRE server and agents: the SPIRE telemetry set, including `spire_agent_node_attestor_new_svid` (node attestation) and
  `spire_agent_rpc_workload_api_fetch_x509svid` (issuance).
- Workloads: `aegis_workload_mtls_requests_total{direction,outcome}` (fixed label sets; no identity is a label),
  `aegis_workload_svid_expires_at_seconds`, `aegis_workload_svid_rotations_total`.

Alerts (`infra/observability/aegis-rules.yml`, group `aegis-workload-identity`): `AegisSpireServerDown`, `AegisSpireAgentDown`,
`AegisWorkloadSvidExpiringSoon` (SVID under 90 s and not renewed), `AegisMtlsRefusalsPresent` (expected during acceptance tests).

Traces (Tempo, through the Collector): `aegis.svid.issued`, `aegis.svid.renewed`, `aegis.peer.authorize` (outcome `authorised` or
`refused`), `aegis.identity.serve`, `aegis.mtls.probe`. Span attributes are an explicit allowlist: the SPIFFE IDs of this workload and its
peer, the outcome, and the SVID expiry time. Tracing is opt-in (`AEGIS_OTEL_ENDPOINT`).

Never exported: private keys, certificate bodies, bearer tokens, request or response bodies, headers. The acceptance run checks the logs,
and the stored traces are checked for key and token markers.

## 8. Verification results

Verified on 2026-11-21 against the running `aegis-local` stack (Docker Desktop 29.5.2, arm64):

| Check | Result |
| --- | --- |
| Full stack acceptance (`npm run test:stack`) | exit 0: health and readiness, authentication, telemetry, SPIRE acceptance, browser lifecycle (11 passed) |
| SPIRE acceptance, base (`npm run test:spire`) | all cases passed, including the impersonation case (untrusted CA: `x509: certificate signed by unknown authority`) |
| SPIRE acceptance with outage (`npm run test:spire:outage`) | all cases passed: mTLS on the cached SVID during server outage; refusal after expiry; recovery after server return; agent outage and recovery |
| Adversarial isolation (manual, same stack) | workload cannot read the agent node key or data volume; workload `kill -9` on the agent denied; agent stayed up |
| Go unit tests (policy parsing, fail-closed identity) | 5 tests, passed (run in `golang:1.24-bookworm`) |
| PostgreSQL integration (`npm run test:integration`, disposable `pgvector/pgvector:pg17`, `aegis_test`) | 159 passed, 10 skipped (same counts as before the P7 commit) |
| Unit (`npm test`) | API 1032 passed; web 69 passed; infrastructure node tests passed |
| Lint and typecheck | passed |

Identity issuance observed: `spiffe://aegis.local/workload/{orchestrator,triage,retrieval,reviewer}`, five-minute SVIDs, renewed while the process kept running (triage observed three SVIDs without restart).

Trace and metric checks: workload spans are present in Tempo (`aegis.peer.authorize` with `refused` outcome, `aegis.mtls.probe`, `aegis.svid.issued`). Stored traces contain no key or token markers. Prometheus `aegis_workload_mtls_requests_total` labels are `direction` and `outcome` only.

Known limits from these runs are in section 9. The Tempo WAL finding is in `docs/OBSERVABILITY.md` section 10.

## 9. Limitations of Unix UID selectors under Docker Desktop, and what this does not prove

1. **UID is the only selector.** Under this design, identity is per container. Inside a container, any process with the registered UID gets
   that identity. A compromised workload process can therefore obtain its own identity, which it already had; it cannot obtain another
   workload's identity (section 6).
2. **gid is not used.** Processes started with `docker exec` default to gid 0. Selectors on gid would be unreliable, so none are used.
3. **Socket permissions.** The agent creates the Workload API socket with mode 0777 (root:root). The boundary is the volume mount and the
   PID-namespace check, not the file mode. A container that is handed the volume is still refused, because its PIDs are unresolvable.
4. **PID namespace sharing.** The agent can see every process of its workload through `/proc`. Its capabilities are all dropped, so it should
   not be able to signal processes owned by other UIDs; that agent-side direction was not tested. The workload cannot signal the agent
   (tested: `kill -9` returned "denied" and the agent stayed up). This is acceptable for the local stack; in production the agent should
   run in its own pod or VM.
5. **Docker Desktop.** Containers run in a Linux VM. The Unix attestor depends on the kernel reporting the caller's UID and PID to the agent
   in the same namespace; this was verified on Docker Desktop 29.5.2 (arm64). A different runtime may differ.
6. **Root in a workload container.** Root inside the workload container is a different UID (0) and is refused by the registration. It is not
   a separate trust boundary from the workload's own processes.
7. **x509pop node credentials are long-lived (90 days) files** on the developer's disk. They are protected by file mode and location, not by
   hardware. They are local test credentials, not production node identities.
8. **No kernel-level workload attestation.** The Unix attestor cannot prove which image a process runs. A same-UID process inside the
   correct container is indistinguishable from the workload. This is the principal reason this is not production-equivalent.

## 10. Production migration design

The runtime depends only on SPIFFE IDs, SVIDs and the peer policy (`policy.json`). It does not depend on the local attestor. Changing the
deployment changes the attestor configuration and the registrations, not the application.

| Local (this stack) | Target deployment (for example Kubernetes) |
| --- | --- |
| x509pop node attestation with a local CA | the platform's node attestor (for example `k8s_psat` for Kubernetes, or the cloud instance-identity attestor) |
| one agent per workload container, sharing its PID namespace | one agent per node (DaemonSet), with the Kubernetes workload attestor (pod UID, service account, container image) |
| Unix UID selector | Kubernetes selectors (namespace, service account, pod label) and, where possible, the image digest |
| Workload API socket in a per-workload volume | a per-pod hostPath socket, scoped to the pod, or CSI driver delivery |
| `policy.json` | the same format, deployed as configuration reviewed under change control |

The mechanisms above are the intended target and are **not** demonstrated here. Nothing in this document claims that the local mechanism
is production-secure: section 9 lists what it does not prove.

## 11. Runbook

- **`AegisSpireServerDown`:** `docker compose -p aegis-local ps spire-server`; check `docker compose logs spire-server`. Workloads keep their
  SVIDs until expiry. Restart with `docker compose up -d spire-server`. If the trust domain data is lost, follow section 2 (recover).
- **`AegisSpireAgentDown`:** identify the agent (`spire-agent-<name>`), restart it. The workload behind it keeps its SVID until expiry.
- **`AegisWorkloadSvidExpiringSoon`:** the agent cannot renew. Check the agent logs and the server. Restart the agent.
- **`AegisMtlsRefusalsPresent`:** list the refused peers in the workload logs (`peer_refused`). An unexpected peer is a policy or an
  impersonation attempt; do not add a peer to `policy.json` without review.

## 12. Commands

```bash
node scripts/spire-bootstrap.mjs            # create credentials outside the repository, start spire-server, write the bundle
node scripts/spire-register.mjs             # create the four workload entries (idempotent)
node scripts/spire-acceptance.mjs           # identity, mTLS matrix, adversarial cases, rotation
node scripts/spire-acceptance.mjs --outage  # also expiry, server outage and agent outage, recovery (about 15 minutes)
```

The acceptance-only services (the unregistered probe, the same-UID intruder, the impersonation server) run only with
`docker compose --profile spire-tests up -d probe spire-agent-probe intruder rogue`.
