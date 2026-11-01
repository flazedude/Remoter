// Package updatefeed serves and mirrors publisher-signed Remoter installers.
package updatefeed

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var versionRE = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-alpha\.(0|[1-9][0-9]{0,8}))?$`)
var hashRE = regexp.MustCompile(`^[a-f0-9]{64}$`)
var commitRE = regexp.MustCompile(`^[a-f0-9]{40}$`)

type Manifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Application   string `json:"application"`
	Channel       string `json:"channel"`
	Version       string `json:"version"`
	SourceCommit  string `json:"sourceCommit"`
	PublishedAt   string `json:"publishedAt"`
	Notes         string `json:"notes"`
	Installer     struct {
		Name   string `json:"name"`
		Size   int64  `json:"size"`
		SHA256 string `json:"sha256"`
	} `json:"installer"`
}

type Config struct {
	Repository string `json:"repository"`
	Channel    string `json:"channel"`
	PublicKey  string `json:"publicKey"`
}

func Verify(data []byte, cfg Config) (Manifest, error) {
	var m Manifest
	if len(data) > 128*1024 {
		return m, errors.New("feed too large")
	}
	var envelope struct {
		Payload   string `json:"payload"`
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return m, err
	}
	payload, err := base64.StdEncoding.DecodeString(envelope.Payload)
	if err != nil {
		return m, err
	}
	signature, err := base64.StdEncoding.DecodeString(envelope.Signature)
	if err != nil {
		return m, err
	}
	der, err := base64.StdEncoding.DecodeString(cfg.PublicKey)
	if err != nil {
		return m, err
	}
	key, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return m, err
	}
	pub, ok := key.(ed25519.PublicKey)
	if !ok || !ed25519.Verify(pub, payload, signature) {
		return m, errors.New("invalid update signature")
	}
	if err = json.Unmarshal(payload, &m); err != nil {
		return m, err
	}
	_, dateErr := time.Parse(time.RFC3339Nano, m.PublishedAt)
	if m.SchemaVersion != 1 || m.Application != "Remoter" || m.Channel != "alpha" || m.Channel != cfg.Channel || !versionRE.MatchString(m.Version) || !commitRE.MatchString(m.SourceCommit) || dateErr != nil || len(m.Notes) > 64000 || m.Installer.Name != "Remoter-Setup-"+m.Version+"-x64.exe" || m.Installer.Size <= 0 || m.Installer.Size > 1024*1024*1024 || !hashRE.MatchString(m.Installer.SHA256) {
		return m, errors.New("invalid release manifest")
	}
	return m, nil
}

func Compare(a, b string) int {
	parse := func(s string) []int64 {
		m := versionRE.FindStringSubmatch(s)
		if m == nil {
			return nil
		}
		parts := make([]int64, 4)
		for i := 0; i < 4; i++ {
			if i == 3 && m[i+1] == "" {
				parts[i] = math.MaxInt64
			} else {
				parts[i], _ = strconv.ParseInt(m[i+1], 10, 64)
			}
		}
		return parts
	}
	aa, bb := parse(a), parse(b)
	if aa == nil || bb == nil {
		return 0
	}
	for i := range aa {
		if aa[i] > bb[i] {
			return 1
		}
		if aa[i] < bb[i] {
			return -1
		}
	}
	return 0
}

func CheckInstaller(filename string, m Manifest) error {
	f, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() != m.Installer.Size {
		return errors.New("installer size mismatch")
	}
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != m.Installer.SHA256 {
		return errors.New("installer hash mismatch")
	}
	return nil
}

// Reject links at every component rather than exposing anything outside root.
func regularPath(p string) bool {
	for current := p; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return false
		}
		parent := filepath.Dir(current)
		if parent == current {
			return true
		}
	}
}

func Handler(root string, cfg Config) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		ip := net.ParseIP(host)
		if err != nil || ip == nil || (!ip.IsPrivate() && !ip.IsLoopback()) {
			http.Error(w, "LAN clients only", http.StatusForbidden)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.URL.Path == "/health" {
			fmt.Fprint(w, "Remoter LAN update server")
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/remoter/")
		if name == r.URL.Path || strings.ContainsAny(name, `/\`) {
			http.NotFound(w, r)
			return
		}
		alias := name == "Remoter-Setup.exe"
		if alias {
			data, err := os.ReadFile(filepath.Join(root, "latest.json"))
			if err != nil {
				http.NotFound(w, r)
				return
			}
			m, err := Verify(data, cfg)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			name = m.Installer.Name
		}
		allowed := name == "latest.json"
		if strings.HasPrefix(name, "Remoter-Setup-") && strings.HasSuffix(name, "-x64.exe") {
			allowed = versionRE.MatchString(strings.TrimSuffix(strings.TrimPrefix(name, "Remoter-Setup-"), "-x64.exe"))
		}
		p := filepath.Join(root, name)
		if !allowed || !regularPath(p) {
			http.NotFound(w, r)
			return
		}
		f, err := os.Open(p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		if name == "latest.json" {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-cache, max-age=0, must-revalidate")
		} else {
			w.Header().Set("Content-Type", "application/octet-stream")
			if alias {
				w.Header().Set("Cache-Control", "no-cache, max-age=0, must-revalidate")
			} else {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		}
		http.ServeContent(w, r, name, info.ModTime(), f)
	})
}

func githubClient() *http.Client {
	return &http.Client{Timeout: 15 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 || req.URL.Scheme != "https" || (req.URL.Hostname() != "github.com" && req.URL.Hostname() != "release-assets.githubusercontent.com" && req.URL.Hostname() != "objects.githubusercontent.com") {
			return errors.New("untrusted mirror redirect")
		}
		return nil
	}}
}

func get(client *http.Client, address string, max int64) ([]byte, error) {
	resp, err := client.Get(address)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GitHub HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, errors.New("mirror metadata too large")
	}
	return data, nil
}

// Sync leaves the previous feed available unless the complete new installer verifies.
func Sync(root string, cfg Config) error {
	if cfg.Repository != "flazedude/Remoter" {
		return errors.New("unexpected update repository")
	}
	client := githubClient()
	data, err := get(client, "https://api.github.com/repos/"+cfg.Repository+"/releases?per_page=30", 2*1024*1024)
	if err != nil {
		return err
	}
	var releases []struct {
		Tag    string `json:"tag_name"`
		Draft  bool   `json:"draft"`
		Assets []struct {
			Name string `json:"name"`
		} `json:"assets"`
	}
	if err = json.Unmarshal(data, &releases); err != nil {
		return err
	}
	tags := []string{}
	for _, r := range releases {
		if r.Draft || !strings.HasPrefix(r.Tag, "v") || !versionRE.MatchString(r.Tag[1:]) {
			continue
		}
		for _, a := range r.Assets {
			if a.Name == "latest.json" {
				tags = append(tags, r.Tag)
				break
			}
		}
	}
	if len(tags) == 0 {
		return errors.New("no signed GitHub release available")
	}
	sort.Slice(tags, func(i, j int) bool { return Compare(tags[i][1:], tags[j][1:]) > 0 })
	base := "https://github.com/" + cfg.Repository + "/releases/download/" + url.PathEscape(tags[0]) + "/"
	feed, err := get(client, base+"latest.json", 128*1024)
	if err != nil {
		return err
	}
	m, err := Verify(feed, cfg)
	if err != nil {
		return err
	}
	if "v"+m.Version != tags[0] {
		return errors.New("tag and signature differ")
	}
	if old, readErr := os.ReadFile(filepath.Join(root, "latest.json")); readErr == nil {
		prior, verifyErr := Verify(old, cfg)
		if verifyErr != nil {
			return fmt.Errorf("existing feed needs attention: %w", verifyErr)
		}
		if Compare(m.Version, prior.Version) < 0 {
			return errors.New("mirror downgrade refused")
		}
		if m.Version == prior.Version && (m.Installer.SHA256 != prior.Installer.SHA256 || m.Installer.Size != prior.Installer.Size || m.SourceCommit != prior.SourceCommit) {
			return errors.New("conflicting immutable release")
		}
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return err
	}
	installer := filepath.Join(root, m.Installer.Name)
	if err = CheckInstaller(installer, m); err != nil {
		if _, statErr := os.Stat(installer); statErr == nil {
			return errors.New("immutable installer differs; preserved for inspection")
		}
		response, downloadErr := client.Get(base + m.Installer.Name)
		if downloadErr != nil {
			return downloadErr
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return fmt.Errorf("installer HTTP %d", response.StatusCode)
		}
		temporary := installer + ".partial"
		defer os.Remove(temporary)
		f, openErr := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
		if openErr != nil {
			return openErr
		}
		_, copyErr := io.Copy(f, io.LimitReader(response.Body, m.Installer.Size+1))
		closeErr := f.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if err = CheckInstaller(temporary, m); err != nil {
			return err
		}
		if err = os.Rename(temporary, installer); err != nil {
			return err
		}
	}
	temporary := filepath.Join(root, "latest.json.tmp")
	if err = os.WriteFile(temporary, feed, 0600); err != nil {
		return err
	}
	return os.Rename(temporary, filepath.Join(root, "latest.json"))
}
