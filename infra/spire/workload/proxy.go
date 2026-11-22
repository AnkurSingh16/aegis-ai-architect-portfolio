package main

// P5 agent proxy: the only component that performs mTLS for an agent's messages.
//
//   inbound   mTLS server. A client is accepted only when its verified SPIFFE ID is in allowClients. The verified ID is forwarded to
//             the agent runtime as x-aegis-peer-spiffe-id. Any such header from the client is discarded, never copied.
//   outbound  loopback HTTP for the agent runtime. Each delivery goes to one configured peer, over mTLS, and the peer's certificate must
//             carry exactly the configured SPIFFE ID (tlsconfig.AuthorizeID). The destination is a name from configuration, not a URL
//             supplied by the message.
//   identity  loopback HTTP that reports this proxy's own SPIFFE ID, as issued by the Workload API. The runtime checks it against its
//             registration before it processes anything.
//
// The runtime shares this proxy's network namespace, so its loopback listeners are reachable only from that runtime. Nothing here reads
// authority from message content. Bodies are bounded, and only trace-context headers are forwarded.

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
	"github.com/spiffe/go-spiffe/v2/svid/x509svid"
	"go.opentelemetry.io/otel/attribute"
)

const (
	maxProxyBody     = 16384
	maxProxyResponse = 8192
)

var proxyMessageID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type proxyPeer struct {
	URL      string `json:"url"`
	ServerID string `json:"serverId"`
}

type proxyConfig struct {
	Inbound struct {
		Listen       string   `json:"listen"`
		ForwardTo    string   `json:"forwardTo"`
		AllowClients []string `json:"allowClients"`
	} `json:"inbound"`
	Outbound struct {
		Listen string               `json:"listen"`
		Peers  map[string]proxyPeer `json:"peers"`
	} `json:"outbound"`
	Identity struct {
		Listen string `json:"listen"`
	} `json:"identity"`
}

// loadProxyConfig fails closed: unknown fields, malformed identities, non-loopback local listeners and an empty allow-list are refused.
func loadProxyConfig(path string) (proxyConfig, error) {
	var c proxyConfig
	raw, err := os.ReadFile(path)
	if err != nil {
		return c, fmt.Errorf("read proxy config: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return c, fmt.Errorf("parse proxy config: %w", err)
	}
	if c.Inbound.Listen == "" || c.Inbound.ForwardTo == "" || c.Outbound.Listen == "" || c.Identity.Listen == "" {
		return c, errors.New("proxy config is incomplete")
	}
	if len(c.Inbound.AllowClients) == 0 {
		return c, errors.New("proxy config allows no inbound clients")
	}
	for _, id := range c.Inbound.AllowClients {
		if err := requireLocalTrustDomain(id); err != nil {
			return c, fmt.Errorf("allowClients entry: %w", err)
		}
	}
	for name, peer := range c.Outbound.Peers {
		if err := requireLocalTrustDomain(peer.ServerID); err != nil {
			return c, fmt.Errorf("peer %q serverId: %w", name, err)
		}
		if !strings.HasPrefix(peer.URL, "https://") {
			return c, fmt.Errorf("peer %q must use https", name)
		}
	}
	if !strings.HasPrefix(c.Inbound.ForwardTo, "http://127.0.0.1:") {
		return c, errors.New("forwardTo must be a loopback address")
	}
	if !strings.HasPrefix(c.Outbound.Listen, "127.0.0.1:") || !strings.HasPrefix(c.Identity.Listen, "127.0.0.1:") {
		return c, errors.New("egress and identity listeners must be loopback")
	}
	return c, nil
}

// requireLocalTrustDomain accepts only identities in the AEGIS trust domain. A foreign domain is refused even if it is well formed.
func requireLocalTrustDomain(value string) error {
	id, err := spiffeid.FromString(value)
	if err != nil {
		return fmt.Errorf("not a SPIFFE ID: %w", err)
	}
	if id.TrustDomain().Name() != "aegis.local" {
		return errors.New("outside the aegis.local trust domain")
	}
	return nil
}

// isIdentityFailure separates a peer that presented the wrong identity (permanent) from a network failure (retryable).
func isIdentityFailure(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "unexpected ID") || strings.Contains(msg, "not authorised") || strings.Contains(msg, "bad certificate")
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func proxy(ctx context.Context) error {
	log := logger()
	shutdownTracing, err := initTracing(ctx, serviceName())
	if err != nil {
		return err
	}
	defer flush(shutdownTracing)
	cfg, err := loadProxyConfig(envOr("AEGIS_P5_CONFIG", "/etc/aegis/p5-proxy.json"))
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
	log.Info("proxy_started", "spiffe_id", self.String(), "peers", len(cfg.Outbound.Peers), "allowed_clients", len(cfg.Inbound.AllowClients))

	// One client per peer, pinned to that peer's exact SPIFFE ID. A message can name a destination, never a different identity.
	type peerClient struct {
		url    string
		client *http.Client
	}
	peers := map[string]peerClient{}
	for name, peer := range cfg.Outbound.Peers {
		want := spiffeid.RequireFromString(peer.ServerID)
		peers[name] = peerClient{url: strings.TrimRight(peer.URL, "/"), client: &http.Client{Timeout: 10 * time.Second,
			Transport: &http.Transport{TLSClientConfig: tlsconfig.MTLSClientConfig(src, src, tlsconfig.AuthorizeID(want))}}}
	}

	allowed := map[string]bool{}
	for _, id := range cfg.Inbound.AllowClients {
		allowed[id] = true
	}
	authorizer := tlsconfig.Authorizer(func(peer spiffeid.ID, _ [][]*x509.Certificate) error {
		if !allowed[peer.String()] {
			mtlsTotal.WithLabelValues("inbound", "refused").Inc()
			log.Warn("peer_refused", "peer_spiffe_id", peer.String(), "self_spiffe_id", self.String())
			return fmt.Errorf("peer %s is not authorised", peer)
		}
		mtlsTotal.WithLabelValues("inbound", "authorised").Inc()
		return nil
	})

	local := &http.Client{Timeout: 10 * time.Second}

	inbound := http.NewServeMux()
	inbound.HandleFunc("POST /v1/inbox/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !proxyMessageID.MatchString(id) {
			writeJSON(w, http.StatusUnprocessableEntity, `{"status":"refused","reason":"malformed"}`)
			return
		}
		peer := ""
		if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
			if pid, err := x509svid.IDFromCert(r.TLS.PeerCertificates[0]); err == nil {
				peer = pid.String()
			}
		}
		if peer == "" || !allowed[peer] {
			writeJSON(w, http.StatusForbidden, `{"status":"refused","reason":"unknown_peer"}`)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxProxyBody+1))
		if err != nil || len(body) > maxProxyBody {
			writeJSON(w, http.StatusUnprocessableEntity, `{"status":"refused","reason":"too_large"}`)
			return
		}
		req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, cfg.Inbound.ForwardTo+"/v1/inbox/"+id, bytes.NewReader(body))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, `{"status":"transient","reason":"internal"}`)
			return
		}
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-aegis-peer-spiffe-id", peer)
		if tp := r.Header.Get("traceparent"); tp != "" && len(tp) <= 128 {
			req.Header.Set("traceparent", tp)
		}
		_, span := tracer().Start(r.Context(), "aegis.message.inbound")
		span.SetAttributes(attribute.String("aegis.peer.spiffe_id", peer), attribute.String("aegis.self.spiffe_id", self.String()),
			attribute.String("aegis.message.id", id))
		defer span.End()
		resp, err := local.Do(req)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, `{"status":"transient","reason":"runtime_unavailable"}`)
			return
		}
		defer resp.Body.Close()
		out, _ := io.ReadAll(io.LimitReader(resp.Body, maxProxyResponse))
		w.Header().Set("content-type", "application/json")
		w.Header().Set("cache-control", "no-store")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(out)
	})

	egress := http.NewServeMux()
	egress.HandleFunc("POST /v1/deliver", func(w http.ResponseWriter, r *http.Request) {
		peer, ok := peers[r.Header.Get("x-aegis-destination")]
		if !ok {
			writeJSON(w, http.StatusNotFound, `{"status":"refused","reason":"unknown_destination"}`)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxProxyBody+1))
		if err != nil || len(body) > maxProxyBody {
			writeJSON(w, http.StatusUnprocessableEntity, `{"status":"refused","reason":"too_large"}`)
			return
		}
		var probe struct {
			MessageID string `json:"messageId"`
		}
		if err := json.Unmarshal(body, &probe); err != nil || !proxyMessageID.MatchString(probe.MessageID) {
			writeJSON(w, http.StatusUnprocessableEntity, `{"status":"refused","reason":"malformed"}`)
			return
		}
		req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, peer.url+"/v1/inbox/"+probe.MessageID, bytes.NewReader(body))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, `{"status":"transient","reason":"internal"}`)
			return
		}
		req.Header.Set("content-type", "application/json")
		if tp := r.Header.Get("traceparent"); tp != "" && len(tp) <= 128 {
			req.Header.Set("traceparent", tp)
		}
		_, span := tracer().Start(r.Context(), "aegis.message.outbound")
		span.SetAttributes(attribute.String("aegis.self.spiffe_id", self.String()), attribute.String("aegis.message.id", probe.MessageID),
			attribute.String("aegis.message.destination", r.Header.Get("x-aegis-destination")))
		defer span.End()
		resp, err := peer.client.Do(req)
		if err != nil {
			if isIdentityFailure(err) {
				mtlsTotal.WithLabelValues("outbound", "refused").Inc()
				outcomeSpan(span, "refused")
				writeJSON(w, http.StatusForbidden, `{"status":"refused","reason":"peer_identity_refused"}`)
				return
			}
			mtlsTotal.WithLabelValues("outbound", "unreachable").Inc()
			outcomeSpan(span, "unreachable")
			writeJSON(w, http.StatusBadGateway, `{"status":"refused","reason":"peer_unreachable"}`)
			return
		}
		defer resp.Body.Close()
		mtlsTotal.WithLabelValues("outbound", "accepted").Inc()
		outcomeSpan(span, "accepted")
		out, _ := io.ReadAll(io.LimitReader(resp.Body, maxProxyResponse))
		w.Header().Set("content-type", "application/json")
		w.Header().Set("cache-control", "no-store")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(out)
	})

	identity := http.NewServeMux()
	identity.HandleFunc("GET /v1/identity", func(w http.ResponseWriter, r *http.Request) {
		body, _ := json.Marshal(map[string]string{"spiffeId": self.String()})
		writeJSON(w, http.StatusOK, string(body))
	})

	inboundServer := &http.Server{Addr: cfg.Inbound.Listen, Handler: inbound, ReadHeaderTimeout: 5 * time.Second,
		TLSConfig: tlsconfig.MTLSServerConfig(src, src, authorizer)}
	egressServer := &http.Server{Addr: cfg.Outbound.Listen, Handler: egress, ReadHeaderTimeout: 5 * time.Second}
	identityServer := &http.Server{Addr: cfg.Identity.Listen, Handler: identity, ReadHeaderTimeout: 5 * time.Second}

	go watchRotation(ctx, src, log)
	go func() { _ = egressServer.ListenAndServe() }()
	go func() { _ = identityServer.ListenAndServe() }()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = inboundServer.Shutdown(shutdownCtx)
		_ = egressServer.Shutdown(shutdownCtx)
		_ = identityServer.Shutdown(shutdownCtx)
	}()
	err = inboundServer.ListenAndServeTLS("", "")
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
