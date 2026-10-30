package host

import (
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIdentityIsBoringSSLCompatiblePinnedTrustAnchor(t *testing.T) {
	i, err := newIdentity()
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(i.Certificate))
	if block == nil {
		t.Fatal("missing certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	key, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok || key.Curve.Params().Name != "P-256" || !cert.IsCA || cert.KeyUsage&x509.KeyUsageCertSign == 0 {
		t.Fatal("identity must be a P-256 self-signed trust anchor for Electron TLS compatibility")
	}
	if err := cert.CheckSignatureFrom(cert); err != nil {
		t.Fatal(err)
	}
}

func TestIdentityPersistsAndRevokesToken(t *testing.T) {
	dir := t.TempDir()
	a, err := LoadIdentity(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	b, err := LoadIdentity(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatal("identity changed on restart")
	}
	c, err := LoadIdentity(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	if c.Token == a.Token || c.Certificate != a.Certificate || c.PrivateKey != a.PrivateKey {
		t.Fatal("rotation must replace token only")
	}
	d, err := LoadIdentity(dir, false)
	if err != nil || d != c {
		t.Fatal("rotated identity did not persist", err)
	}
}
func TestInvitationNeverContainsPrivateKey(t *testing.T) {
	i, err := newIdentity()
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := i.Invite("Mac mini", "https://100.64.0.5:48200", nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "PRIVATE KEY") || strings.Contains(string(raw), "privateKey") {
		t.Fatal("private key leaked in invitation")
	}
	var inv Invitation
	if err = json.Unmarshal(raw, &inv); err != nil {
		t.Fatal(err)
	}
	if inv.Token != i.Token || inv.Certificate != i.Certificate || inv.Version != 1 {
		t.Fatalf("wrong invitation: %+v", inv)
	}
}
func TestInvitationRejectsUnsafeEndpoints(t *testing.T) {
	i, err := newIdentity()
	if err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{"http://host:1", "https://u:p@host", "https://host/path", "https://host?token=x", "https://host#fragment", "https://"} {
		if _, err := i.Invite("host", endpoint, nil); err == nil {
			t.Fatalf("accepted %q", endpoint)
		}
	}
}
func TestCorruptIdentityNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "identity.json")
	if err := os.WriteFile(path, []byte(`{"token":"broken"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadIdentity(dir, false); err == nil {
		t.Fatal("accepted corrupt identity")
	}
	b, _ := os.ReadFile(path)
	if string(b) != `{"token":"broken"}` {
		t.Fatal("overwrote existing identity")
	}
}
