package host

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/remoter/remoter/native/internal/platform"
)

const testToken = "this-is-a-long-test-token-never-use-in-production"

func testHandler(t *testing.T, allow bool) (*Handler, *platform.Synthetic) {
	t.Helper()
	b := platform.NewSynthetic()
	h, err := NewHandler(Config{Name: "Test host", Token: testToken, AllowInput: allow, Synthetic: true, Backend: b})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	return h, b
}
func request(h http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func TestEveryRouteRequiresAuthentication(t *testing.T) {
	h, _ := testHandler(t, true)
	for _, p := range []string{"/v1/health", "/v1/info", "/v1/frame", "/v1/input", "/missing"} {
		for _, tok := range []string{"", "wrong", testToken + "!"} {
			w := request(h, "GET", p, "", tok)
			if w.Code != 401 {
				t.Fatalf("%s unauthorized status %d", p, w.Code)
			}
		}
	}
}
func TestInfoAndViewOnly(t *testing.T) {
	h, s := testHandler(t, false)
	w := request(h, "GET", "/v1/info", "", testToken)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var result struct {
		Capabilities platform.Capabilities `json:"capabilities"`
		Displays     []platform.Display    `json:"displays"`
		Synthetic    bool                  `json:"synthetic"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Capabilities.Input || !result.Capabilities.Capture || len(result.Displays) != 1 || !result.Synthetic {
		t.Fatalf("unexpected info %+v", result)
	}
	w = request(h, "POST", "/v1/input", `{"type":"key","code":"KeyA","down":true}`, testToken)
	if w.Code != 403 || len(s.Events()) != 0 {
		t.Fatal("view-only host accepted input")
	}
}
func TestFrameIsBoundedJPEG(t *testing.T) {
	h, _ := testHandler(t, false)
	w := request(h, "GET", "/v1/frame?display=0&quality=65&width=640", "", testToken)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	im, err := jpeg.Decode(bytes.NewReader(w.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if im.Bounds().Dx() != 640 || im.Bounds().Dy() != 360 {
		t.Fatal(im.Bounds())
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("frame is cacheable")
	}
	for _, q := range []string{"width=99999999", "width=-1", "quality=101", "display=-1", "display=no"} {
		if got := request(h, "GET", "/v1/frame?"+q, "", testToken).Code; got != 400 {
			t.Fatalf("%s: %d", q, got)
		}
	}
}
func TestInputValidationAndRelease(t *testing.T) {
	h, s := testHandler(t, true)
	bad := []string{`{"type":"move","x":1280,"y":0}`, `{"type":"move","displayId":99}`, `{"type":"key","code":"NotAKey"}`, `{"type":"button","button":"extra"}`, `{"type":"scroll","deltaY":1201}`, `{"type":"run","command":"x"}`, `{"type":"key","code":"KeyA","unknown":true}`, `{"type":"key","code":"KeyA"} {}`, strings.Repeat("x", 3000)}
	for _, body := range bad {
		w := request(h, "POST", "/v1/input", body, testToken)
		if w.Code != 400 {
			t.Fatalf("bad input got %d: %s", w.Code, body)
		}
	}
	if len(s.Events()) != 0 {
		t.Fatal("invalid inputs reached platform")
	}
	for _, body := range []string{`{"type":"move","x":20,"y":30}`, `{"type":"key","code":"ShiftLeft","down":true}`, `{"type":"button","button":"left","down":true}`, `{"type":"releaseAll"}`} {
		w := request(h, "POST", "/v1/input", body, testToken)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	events := s.Events()
	if len(events) != 5 {
		t.Fatalf("want move, two downs and two releases; got %+v", events)
	}
	if events[3].Down || events[4].Down {
		t.Fatal("held inputs were not released")
	}
}
func TestCloseReleasesHeldKeys(t *testing.T) {
	h, s := testHandler(t, true)
	request(h, "POST", "/v1/input", `{"type":"key","code":"ControlLeft","down":true}`, testToken)
	h.Close()
	events := s.Events()
	if len(events) != 2 || events[1].Down {
		t.Fatalf("close failed to release input: %+v", events)
	}
}
func TestRejectBrowserOriginAndWrongMethod(t *testing.T) {
	h, _ := testHandler(t, false)
	r := httptest.NewRequest("GET", "/v1/info", nil)
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Origin", "https://unrelated.example")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	if request(h, "POST", "/v1/frame", "", testToken).Code != 405 {
		t.Fatal("wrong method allowed")
	}
}
func TestInputRateLimit(t *testing.T) {
	h, _ := testHandler(t, true)
	for i := 0; i < 240; i++ {
		w := request(h, "POST", "/v1/input", `{"type":"scroll","deltaY":1}`, testToken)
		if w.Code != 200 {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
	if got := request(h, "POST", "/v1/input", `{"type":"scroll","deltaY":1}`, testToken).Code; got != 429 {
		t.Fatalf("rate limit: %d", got)
	}
	if got := request(h, "POST", "/v1/input", `{"type":"releaseAll"}`, testToken).Code; got != 200 {
		t.Fatalf("emergency release blocked by rate limit: %d", got)
	}
}

func TestClosedHostRejectsLateInput(t *testing.T) {
	h, s := testHandler(t, true)
	h.Close()
	w := request(h, "POST", "/v1/input", `{"type":"key","code":"KeyA","down":true}`, testToken)
	if w.Code != 503 || len(s.Events()) != 0 {
		t.Fatal("closed host accepted input")
	}
}
func TestActualTLSUsesGeneratedIdentity(t *testing.T) {
	identity, err := LoadIdentity(t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(Config{Token: identity.Token, Synthetic: true})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	cfg, err := identity.TLSConfig()
	if err != nil {
		t.Fatal(err)
	}
	s := httptest.NewUnstartedServer(h)
	s.TLS = cfg
	s.StartTLS()
	defer s.Close()
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(identity.Certificate)) {
		t.Fatal("bad certificate")
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13}}}
	defer client.CloseIdleConnections()
	r, _ := http.NewRequest("GET", s.URL+"/v1/health", nil)
	r.Header.Set("Authorization", "Bearer "+identity.Token)
	res, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	io.Copy(io.Discard, res.Body)
	if res.StatusCode != 200 || res.TLS.Version != tls.VersionTLS13 {
		t.Fatalf("TLS response: %+v", res)
	}
}
