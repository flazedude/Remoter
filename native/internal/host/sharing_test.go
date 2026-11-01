package host

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/flazedude/Remoter/native/internal/platform"
)

func TestSharingPermissionsAndTextRoundTrip(t *testing.T) {
	h, err := NewHandler(Config{Token: testToken, Synthetic: true, AllowClipboard: true, AllowAudio: true})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	text := "Unicode: 你好 👋\nsecond line"
	body, _ := json.Marshal(map[string]string{"text": text})
	if w := request(h, "POST", "/v1/clipboard", string(body), testToken); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w := request(h, "GET", "/v1/clipboard", "", testToken)
	var value map[string]string
	if json.Unmarshal(w.Body.Bytes(), &value) != nil || value["text"] != text {
		t.Fatal("clipboard did not round-trip")
	}
	for _, body := range []string{`{}`, `{"text":1}`, `{"text":"bad\u0000text"}`, `{"text":"ok","extra":1}`, `{"text":"ok"}{}`} {
		if w := request(h, "POST", "/v1/clipboard", body, testToken); w.Code != 400 {
			t.Fatalf("invalid clipboard accepted: %s", body)
		}
	}
	oversized, _ := json.Marshal(map[string]string{"text": strings.Repeat("a", platform.MaxClipboardBytes+1)})
	if w := request(h, "POST", "/v1/clipboard", string(oversized), testToken); w.Code != 400 {
		t.Fatal("oversized clipboard accepted")
	}
	packet := request(h, "GET", "/v1/audio?after=0", "", testToken)
	var audio audioPacket
	if packet.Code != 200 || json.Unmarshal(packet.Body.Bytes(), &audio) != nil || audio.Sequence < 1 || len(audio.Data) != 9600 || audio.SampleRate != 48000 || audio.Channels != 2 {
		t.Fatalf("invalid audio packet: status %d", packet.Code)
	}
	denied, _ := testHandler(t, true)
	for _, path := range []string{"/v1/clipboard", "/v1/audio?after=0"} {
		if w := request(denied, "GET", path, "", testToken); w.Code != 403 {
			t.Fatalf("sharing permission bypass: %s", path)
		}
		if w := request(h, "GET", path, "", ""); w.Code != 401 {
			t.Fatalf("unauthenticated sharing: %s", path)
		}
	}
	if w := request(h, "GET", "/v1/audio?after=-1", "", testToken); w.Code != 400 {
		t.Fatal("invalid sequence accepted")
	}
}

func TestEasyLANRequiresOptInLocalPeerAndNativeOrigin(t *testing.T) {
	const lanToken = "test_ephemeral_lan_token_01234567890123456789"
	h, err := NewHandler(Config{Token: testToken, Synthetic: true, LANToken: lanToken, LANInvitation: "test-invitation"})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	for _, test := range []struct {
		peer, origin, path, token string
		relay                     bool
		status                    int
	}{
		{"127.0.0.1:1234", "", "/v1/lan-pair", "", false, 200},
		{"127.0.0.1:1234", "", "/v1/info", lanToken, false, 200},
		{"203.0.113.1:1234", "", "/v1/lan-pair", "", false, 401},
		{"203.0.113.1:1234", "", "/v1/info", lanToken, false, 401},
		{"127.0.0.1:1234", "https://example.com", "/v1/lan-pair", "", false, 401},
		{"127.0.0.1:1234", "", "/v1/lan-pair", "", true, 401},
		{"127.0.0.1:1234", "", "/v1/info", lanToken, true, 401},
		{"127.0.0.1:1234", "", "/v1/info", testToken, true, 200},
	} {
		r := httptest.NewRequest("GET", test.path, nil)
		r.RemoteAddr = test.peer
		if test.token != "" {
			r.Header.Set("Authorization", "Bearer "+test.token)
		}
		r.Header.Set("Origin", test.origin)
		w := httptest.NewRecorder()
		if test.relay {
			h.ServeRelayHTTP(w, r)
		} else {
			h.ServeHTTP(w, r)
		}
		if w.Code != test.status {
			t.Fatalf("%+v: status %d", test, w.Code)
		}
	}
	disabled, _ := testHandler(t, false)
	r := httptest.NewRequest("GET", "/v1/lan-pair", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	w := httptest.NewRecorder()
	disabled.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatal("LAN bootstrap available without opt-in")
	}
}

func TestLANTokenExpiresWhenHostRestarts(t *testing.T) {
	first, _ := NewLANToken()
	second, _ := NewLANToken()
	if first == second || len(first) < 32 {
		t.Fatal("invalid ephemeral token")
	}
	h, err := NewHandler(Config{Token: testToken, Synthetic: true, LANToken: second})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	r := httptest.NewRequest("GET", "/v1/info", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("Authorization", "Bearer "+first)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("previous LAN session token accepted")
	}
}
