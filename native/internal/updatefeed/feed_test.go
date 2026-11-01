package updatefeed

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T) (Config, Manifest, []byte, []byte) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{Repository: "flazedude/Remoter", Channel: "alpha", PublicKey: base64.StdEncoding.EncodeToString(der)}
	installer := []byte("test installer, not executable")
	hash := sha256.Sum256(installer)
	m := Manifest{SchemaVersion: 1, Application: "Remoter", Channel: "alpha", Version: "0.1.0-alpha.2", SourceCommit: strings.Repeat("a", 40), PublishedAt: time.Now().UTC().Format(time.RFC3339), Notes: "Test"}
	m.Installer.Name = "Remoter-Setup-0.1.0-alpha.2-x64.exe"
	m.Installer.Size = int64(len(installer))
	m.Installer.SHA256 = hex.EncodeToString(hash[:])
	payload, _ := json.Marshal(m)
	data, _ := json.Marshal(map[string]string{"payload": base64.StdEncoding.EncodeToString(payload), "signature": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))})
	return cfg, m, data, installer
}
func TestSignedFeedAndInstaller(t *testing.T) {
	cfg, m, data, installer := fixture(t)
	if _, err := Verify(data, cfg); err != nil {
		t.Fatal(err)
	}
	other, _, _, _ := fixture(t)
	if _, err := Verify(data, other); err == nil {
		t.Fatal("accepted wrong identity")
	}
	var envelope map[string]string
	json.Unmarshal(data, &envelope)
	envelope["payload"] = base64.StdEncoding.EncodeToString([]byte(`{"application":"Other"}`))
	bad, _ := json.Marshal(envelope)
	if _, err := Verify(bad, cfg); err == nil {
		t.Fatal("accepted tampering")
	}
	p := filepath.Join(t.TempDir(), m.Installer.Name)
	os.WriteFile(p, installer, 0600)
	if err := CheckInstaller(p, m); err != nil {
		t.Fatal(err)
	}
	installer[0] ^= 1
	os.WriteFile(p, installer, 0600)
	if err := CheckInstaller(p, m); err == nil {
		t.Fatal("accepted changed bytes")
	}
	if Compare("0.1.0-alpha.10", "0.1.0-alpha.2") != 1 || Compare("0.1.0", "0.1.0-alpha.10") != 1 {
		t.Fatal("wrong alpha version ordering")
	}
}
func TestServerBoundariesAndRanges(t *testing.T) {
	cfg, m, data, installer := fixture(t)
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "latest.json"), data, 0600)
	os.WriteFile(filepath.Join(root, m.Installer.Name), installer, 0600)
	os.WriteFile(filepath.Join(root, "private.key"), []byte("secret"), 0600)
	h := Handler(root, cfg)
	for _, test := range []struct {
		path, remote, method string
		status               int
	}{{"/health", "192.168.2.59:1234", "GET", 200}, {"/remoter/latest.json", "192.168.2.59:1234", "GET", 200}, {"/remoter/Remoter-Setup.exe", "192.168.2.59:1234", "GET", 200}, {"/remoter/private.key", "192.168.2.59:1234", "GET", 404}, {"/remoter/../private.key", "192.168.2.59:1234", "GET", 404}, {"/remoter/latest.json", "8.8.8.8:1234", "GET", 403}, {"/remoter/latest.json", "192.168.2.59:1234", "POST", 405}} {
		req := httptest.NewRequest(test.method, test.path, nil)
		req.RemoteAddr = test.remote
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != test.status {
			t.Errorf("%s: got %d want %d", test.path, w.Code, test.status)
		}
	}
	req := httptest.NewRequest("GET", "/remoter/"+m.Installer.Name, nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("Range", "bytes=0-3")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 206 || w.Body.String() != string(installer[:4]) {
		t.Fatal("range download failed")
	}
}
