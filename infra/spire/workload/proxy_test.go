package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeProxyConfig(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "p5-proxy.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

const validProxyConfig = `{
  "inbound": {"listen": ":8443", "forwardTo": "http://127.0.0.1:7100", "allowClients": ["spiffe://aegis.local/workload/orchestrator"]},
  "outbound": {"listen": "127.0.0.1:7001", "peers": {"orchestrator": {"url": "https://p5-orchestrator-proxy:8443", "serverId": "spiffe://aegis.local/workload/orchestrator"}}},
  "identity": {"listen": "127.0.0.1:7002"}
}`

func TestLoadProxyConfigAcceptsValidConfig(t *testing.T) {
	cfg, err := loadProxyConfig(writeProxyConfig(t, validProxyConfig))
	if err != nil {
		t.Fatalf("valid proxy config refused: %v", err)
	}
	if len(cfg.Inbound.AllowClients) != 1 || cfg.Outbound.Peers["orchestrator"].ServerID == "" {
		t.Fatalf("config not read as written: %+v", cfg)
	}
}

// Each case is a configuration that must fail closed.
func TestLoadProxyConfigRefusesUnsafeConfig(t *testing.T) {
	cases := map[string]string{
		"unknown field":          strings.Replace(validProxyConfig, `"identity"`, `"extra": true, "identity"`, 1),
		"empty allow-list":       strings.Replace(validProxyConfig, `["spiffe://aegis.local/workload/orchestrator"]`, `[]`, 1),
		"foreign trust domain":   strings.Replace(validProxyConfig, `"allowClients": ["spiffe://aegis.local/workload/orchestrator"]`, `"allowClients": ["spiffe://evil.example/workload/x"]`, 1),
		"plain http peer":        strings.Replace(validProxyConfig, `https://p5-orchestrator-proxy`, `http://p5-orchestrator-proxy`, 1),
		"non-loopback egress":    strings.Replace(validProxyConfig, `127.0.0.1:7001`, `0.0.0.0:7001`, 1),
		"non-loopback forward":   strings.Replace(validProxyConfig, `http://127.0.0.1:7100`, `http://runtime:7100`, 1),
		"malformed peer serverId": strings.Replace(validProxyConfig, `spiffe://aegis.local/workload/orchestrator"}}`, `not-an-id"}}`, 1),
	}
	for name, body := range cases {
		if _, err := loadProxyConfig(writeProxyConfig(t, body)); err == nil {
			t.Errorf("%s: unsafe proxy config was accepted", name)
		}
	}
}

func TestIsIdentityFailureSeparatesPermanentFromNetwork(t *testing.T) {
	if !isIdentityFailure(fakeErr("tls: x509: unexpected ID spiffe://evil")) {
		t.Error("wrong peer identity must be classed as permanent")
	}
	if isIdentityFailure(fakeErr("dial tcp 10.0.0.1:8443: connect: connection refused")) {
		t.Error("a network failure must stay retryable")
	}
}

type fakeErr string

func (e fakeErr) Error() string { return string(e) }
