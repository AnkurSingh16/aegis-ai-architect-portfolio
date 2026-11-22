// Command aegis-workload is the AEGIS agent workload used to demonstrate SPIRE workload identity and explicit mTLS peer authorisation.
//
// Identity: the process obtains its X.509 SVID only through the SPIRE Workload API socket. Nothing in the environment, arguments or
// requests supplies or changes its SPIFFE ID. The binary is identical for every role; SPIRE issues a different identity per UID.
//
// Authorisation: a server accepts a client only when the client's SPIFFE ID (taken from the verified certificate) is listed for the
// server's own SPIFFE ID in the policy file. A valid certificate from the trust domain is not enough by itself.
//
// Subcommands:
//
//	serve                      run the mTLS endpoint (GET /identity) and the metrics endpoint
//	proxy                      run the P5 agent proxy (inbound mTLS, loopback egress, loopback identity); see proxy.go
//	probe <url> <serverID>     call a peer over mTLS, requiring the exact expected server SPIFFE ID
//
// Output never contains key material, certificate bodies or bearer tokens.
package main

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	sdkresource "go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	oteltrace "go.opentelemetry.io/otel/trace"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
	"github.com/spiffe/go-spiffe/v2/svid/x509svid"
	"github.com/spiffe/go-spiffe/v2/workloadapi"
)

const (
	defaultSocket     = "unix:///run/spire/sockets/agent.sock"
	defaultPolicyPath = "/etc/aegis/spire-policy.json"
	defaultListen     = ":8443"
	defaultMetrics    = ":9100"
)

var (
	mtlsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "aegis_workload_mtls_requests_total",
		Help: "mTLS requests by direction and outcome. Labels are fixed sets; no identities are used as labels.",
	}, []string{"direction", "outcome"})
	svidExpiry = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "aegis_workload_svid_expires_at_seconds",
		Help: "Expiry time of the workload's current X.509 SVID, as a Unix timestamp.",
	})
	svidRotations = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "aegis_workload_svid_rotations_total",
		Help: "Number of times the workload observed a new X.509 SVID from the Workload API.",
	})
)

func init() {
	prometheus.MustRegister(mtlsTotal, svidExpiry, svidRotations)
}

// tracer returns the process tracer. Without AEGIS_OTEL_ENDPOINT the global no-op tracer is used, so tracing is strictly opt-in.
//
// Span attributes are an explicit allowlist: the SPIFFE IDs of this workload and its peer, the authorisation outcome, and SVID expiry
// times. Requests, certificates, keys, headers and bodies are never attached to spans.
func tracer() oteltrace.Tracer {
	return otel.Tracer("aegis.spire.workload")
}

func initTracing(ctx context.Context, service string) (func(context.Context) error, error) {
	endpoint := os.Getenv("AEGIS_OTEL_ENDPOINT")
	if endpoint == "" {
		return func(context.Context) error { return nil }, nil
	}
	exp, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpoint(endpoint), otlptracehttp.WithInsecure())
	if err != nil {
		return nil, fmt.Errorf("trace exporter: %w", err)
	}
	res := sdkresource.NewSchemaless(attribute.String("service.name", service))
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	return tp.Shutdown, nil
}

func outcomeSpan(span oteltrace.Span, outcome string) {
	span.SetAttributes(attribute.String("aegis.authorization.outcome", outcome))
}

type serviceRule struct {
	AllowClients []string `json:"allowClients"`
}

type policyFile struct {
	TrustDomain string                 `json:"trustDomain"`
	Services    map[string]serviceRule `json:"services"`
}

// loadPolicy parses the peer policy and fails closed on any malformed or cross-domain entry.
func loadPolicy(path string) (policyFile, error) {
	var p policyFile
	raw, err := os.ReadFile(path)
	if err != nil {
		return p, fmt.Errorf("read policy: %w", err)
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, fmt.Errorf("parse policy: %w", err)
	}
	td, err := spiffeid.TrustDomainFromString(p.TrustDomain)
	if err != nil {
		return p, fmt.Errorf("policy trust domain: %w", err)
	}
	for svc, rule := range p.Services {
		id, err := spiffeid.FromString(svc)
		if err != nil || id.TrustDomain() != td {
			return p, fmt.Errorf("policy service %q is not in trust domain %s", svc, td)
		}
		for _, c := range rule.AllowClients {
			cid, err := spiffeid.FromString(c)
			if err != nil || cid.TrustDomain() != td {
				return p, fmt.Errorf("policy client %q for %q is not in trust domain %s", c, svc, td)
			}
		}
	}
	return p, nil
}

func (p policyFile) allowedClients(self spiffeid.ID) (map[string]bool, bool) {
	rule, ok := p.Services[self.String()]
	if !ok {
		return nil, false
	}
	out := make(map[string]bool, len(rule.AllowClients))
	for _, c := range rule.AllowClients {
		out[c] = true
	}
	return out, true
}

func socketAddr() string {
	if v := os.Getenv("AEGIS_SPIRE_SOCKET"); v != "" {
		return v
	}
	return defaultSocket
}

func logger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, nil))
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: aegis-workload serve | proxy | probe <url> <serverSPIFFEID>")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve(ctx)
	case "proxy":
		err = proxy(ctx)
	case "probe":
		if len(os.Args) != 4 {
			fmt.Fprintln(os.Stderr, "usage: aegis-workload probe <url> <serverSPIFFEID>")
			os.Exit(2)
		}
		os.Exit(probe(ctx, os.Args[2], os.Args[3]))
	default:
		err = fmt.Errorf("unknown subcommand %q", os.Args[1])
	}
	if err != nil {
		logger().Error("workload_stopped", "error", err.Error())
		os.Exit(1)
	}
}

// newSource blocks until the Workload API issues an SVID. An unregistered or unattested process never gets one, so it never starts.
func newSource(ctx context.Context) (*workloadapi.X509Source, error) {
	return workloadapi.NewX509Source(ctx, workloadapi.WithClientOptions(workloadapi.WithAddr(socketAddr())))
}

// watchRotation records expiry and rotations for observability. It never copies key material.
func watchRotation(ctx context.Context, src *workloadapi.X509Source, log *slog.Logger) {
	var last string
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		if svid, err := src.GetX509SVID(); err == nil {
			serial := svid.Certificates[0].SerialNumber.String()
			if serial != last {
				name := "aegis.svid.issued"
				if last != "" {
					svidRotations.Inc()
					name = "aegis.svid.renewed"
				}
				last = serial
				_, span := tracer().Start(ctx, name)
				span.SetAttributes(attribute.String("aegis.self.spiffe_id", svid.ID.String()),
					attribute.String("aegis.svid.expires_at", svid.Certificates[0].NotAfter.UTC().Format(time.RFC3339)))
				span.End()
				log.Info("svid_observed", "spiffe_id", svid.ID.String(), "expires_at", svid.Certificates[0].NotAfter.UTC().Format(time.RFC3339))
			}
			svidExpiry.Set(float64(svid.Certificates[0].NotAfter.Unix()))
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func serve(ctx context.Context) error {
	log := logger()
	shutdownTracing, err := initTracing(ctx, serviceName())
	if err != nil {
		return err
	}
	defer flush(shutdownTracing)
	policyPath := os.Getenv("AEGIS_POLICY_PATH")
	if policyPath == "" {
		policyPath = defaultPolicyPath
	}
	policy, err := loadPolicy(policyPath)
	if err != nil {
		return err
	}
	src, err := newSource(ctx)
	if err != nil {
		return fmt.Errorf("workload api: %w", err)
	}
	defer src.Close()

	svid, err := src.GetX509SVID()
	if err != nil {
		return err
	}
	self := svid.ID
	allowed, ok := policy.allowedClients(self)
	if !ok {
		// Fail closed: an identity without a policy entry does not serve.
		return fmt.Errorf("no peer policy for own identity %s", self)
	}
	log.Info("workload_started", "spiffe_id", self.String(), "allowed_clients", len(allowed))

	// The peer's SPIFFE ID comes from its verified certificate chain (go-spiffe checks the chain against the trust bundle first).
	authorizer := tlsconfig.Authorizer(func(peer spiffeid.ID, _ [][]*x509.Certificate) error {
		_, span := tracer().Start(context.Background(), "aegis.peer.authorize")
		defer span.End()
		span.SetAttributes(attribute.String("aegis.peer.spiffe_id", peer.String()), attribute.String("aegis.self.spiffe_id", self.String()))
		if !allowed[peer.String()] {
			mtlsTotal.WithLabelValues("inbound", "refused").Inc()
			outcomeSpan(span, "refused")
			log.Warn("peer_refused", "peer_spiffe_id", peer.String(), "self_spiffe_id", self.String())
			return fmt.Errorf("peer %s is not authorised", peer)
		}
		outcomeSpan(span, "authorised")
		return nil
	})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /identity", func(w http.ResponseWriter, r *http.Request) {
		peer := ""
		if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
			if id, err := x509svid.IDFromCert(r.TLS.PeerCertificates[0]); err == nil {
				peer = id.String()
			}
		}
		_, span := tracer().Start(r.Context(), "aegis.identity.serve")
		span.SetAttributes(attribute.String("aegis.peer.spiffe_id", peer), attribute.String("aegis.self.spiffe_id", self.String()))
		outcomeSpan(span, "accepted")
		span.End()
		mtlsTotal.WithLabelValues("inbound", "accepted").Inc()
		log.Info("peer_accepted", "peer_spiffe_id", peer, "self_spiffe_id", self.String())
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"self": self.String(), "peer": peer})
	})

	server := &http.Server{
		Addr:              envOr("AEGIS_WORKLOAD_LISTEN", defaultListen),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		TLSConfig:         tlsconfig.MTLSServerConfig(src, src, authorizer),
	}
	metrics := &http.Server{Addr: envOr("AEGIS_WORKLOAD_METRICS", defaultMetrics), Handler: promhttp.Handler(), ReadHeaderTimeout: 5 * time.Second}

	go watchRotation(ctx, src, log)
	go func() { _ = metrics.ListenAndServe() }()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
		_ = metrics.Shutdown(shutdownCtx)
	}()
	err = server.ListenAndServeTLS("", "")
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// probe calls a peer over mTLS and requires the exact expected server identity. Exit codes: 0 accepted, 3 refused, 1 error.
func probe(ctx context.Context, url, expected string) int {
	log := logger()
	shutdownTracing, err := initTracing(ctx, serviceName())
	if err != nil {
		log.Error("probe_tracing", "error", err.Error())
		return 1
	}
	defer flush(shutdownTracing)
	want, err := spiffeid.FromString(expected)
	if err != nil {
		log.Error("probe_invalid_expected_id", "error", err.Error())
		return 1
	}
	// A probe that cannot obtain an identity must fail, not wait forever. The deadline is for the identity wait only.
	idCtx, cancelID := context.WithTimeout(ctx, identityWait())
	src, err := newSource(idCtx)
	cancelID()
	if err != nil {
		log.Warn("probe_no_identity", "error", sanitize(err))
		return 1
	}
	defer src.Close()
	svid, err := src.GetX509SVID()
	if err != nil {
		log.Warn("probe_no_identity", "error", sanitize(err))
		return 1
	}
	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: tlsconfig.MTLSClientConfig(src, src, tlsconfig.AuthorizeID(want)),
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(url, "/")+"/identity", nil)
	if err != nil {
		log.Error("probe_bad_url", "error", err.Error())
		return 1
	}
	pctx, span := tracer().Start(ctx, "aegis.mtls.probe")
	span.SetAttributes(attribute.String("aegis.self.spiffe_id", svid.ID.String()),
		attribute.String("aegis.expected_peer.spiffe_id", want.String()))
	defer span.End()
	req = req.WithContext(pctx)
	resp, err := client.Do(req)
	if err != nil {
		mtlsTotal.WithLabelValues("outbound", "refused").Inc()
		outcomeSpan(span, "refused")
		log.Warn("probe_refused", "self_spiffe_id", svid.ID.String(), "expected_server_spiffe_id", want.String(), "reason", sanitize(err))
		return 3
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	outcomeSpan(span, "accepted")
	mtlsTotal.WithLabelValues("outbound", "accepted").Inc()
	log.Info("probe_accepted", "self_spiffe_id", svid.ID.String(), "server_spiffe_id", want.String(), "status", resp.StatusCode, "body", strings.TrimSpace(string(body)))
	return 0
}

// sanitize keeps only the error class, so no certificate or key text reaches logs.
func sanitize(err error) string {
	msg := err.Error()
	if i := strings.Index(msg, ": "); i > 0 && len(msg) > 200 {
		msg = msg[:i]
	}
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

// identityWait bounds how long a probe waits for the Workload API to issue it an SVID (AEGIS_PROBE_IDENTITY_WAIT, default 15 s).
func identityWait() time.Duration {
	if d, err := time.ParseDuration(os.Getenv("AEGIS_PROBE_IDENTITY_WAIT")); err == nil && d > 0 {
		return d
	}
	return 15 * time.Second
}

func serviceName() string {
	return envOr("AEGIS_SERVICE_NAME", "aegis-workload")
}

// flush exports pending spans with a bounded wait so a stopped workload does not hang on its telemetry backend.
func flush(shutdown func(context.Context) error) {
	c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = shutdown(c)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
