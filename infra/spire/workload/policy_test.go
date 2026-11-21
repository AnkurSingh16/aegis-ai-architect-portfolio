package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
)

func writePolicy(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadPolicyAcceptsTrustDomainEntries(t *testing.T) {
	p, err := loadPolicy(writePolicy(t, `{"trustDomain":"aegis.local","services":{"spiffe://aegis.local/workload/triage":{"allowClients":["spiffe://aegis.local/workload/orchestrator"]}}}`))
	if err != nil {
		t.Fatalf("valid policy refused: %v", err)
	}
	allowed, ok := p.allowedClients(spiffeid.RequireFromString("spiffe://aegis.local/workload/triage"))
	if !ok || !allowed["spiffe://aegis.local/workload/orchestrator"] {
		t.Fatalf("expected orchestrator to be allowed to call triage")
	}
}

func TestLoadPolicyRefusesForeignTrustDomainService(t *testing.T) {
	if _, err := loadPolicy(writePolicy(t, `{"trustDomain":"aegis.local","services":{"spiffe://evil.example/workload/triage":{"allowClients":[]}}}`)); err == nil {
		t.Fatal("policy with a foreign trust-domain service must be refused")
	}
}

func TestLoadPolicyRefusesForeignTrustDomainClient(t *testing.T) {
	if _, err := loadPolicy(writePolicy(t, `{"trustDomain":"aegis.local","services":{"spiffe://aegis.local/workload/triage":{"allowClients":["spiffe://evil.example/workload/x"]}}}`)); err == nil {
		t.Fatal("policy with a foreign trust-domain client must be refused")
	}
}

func TestLoadPolicyRefusesMalformedDocument(t *testing.T) {
	if _, err := loadPolicy(writePolicy(t, `{"trustDomain":`)); err == nil {
		t.Fatal("malformed policy must be refused")
	}
}

func TestUnknownIdentityFailsClosed(t *testing.T) {
	p, err := loadPolicy(writePolicy(t, `{"trustDomain":"aegis.local","services":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := p.allowedClients(spiffeid.RequireFromString("spiffe://aegis.local/workload/unregistered")); ok {
		t.Fatal("an identity without a policy entry must not serve")
	}
}
