package host

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Identity struct {
	Certificate string `json:"certificate"`
	PrivateKey  string `json:"privateKey"`
	Token       string `json:"token"`
}
type RelayInvite struct {
	URL      string `json:"url"`
	DeviceID string `json:"deviceId"`
	Token    string `json:"token"`
}
type Invitation struct {
	Version     int          `json:"version"`
	Name        string       `json:"name"`
	Endpoint    string       `json:"endpoint"`
	Certificate string       `json:"certificate"`
	Token       string       `json:"token"`
	Relay       *RelayInvite `json:"relay,omitempty"`
}

func (i Identity) TLSConfig() (*tls.Config, error) {
	c, err := tls.X509KeyPair([]byte(i.Certificate), []byte(i.PrivateKey))
	if err != nil {
		return nil, err
	}
	return &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{c}}, nil
}
func (i Identity) Invite(name, endpoint string, relay *RelayInvite) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("advertise must be an https://host:port URL without credentials, path or query")
	}
	b, err := json.Marshal(Invitation{1, name, strings.TrimRight(endpoint, "/"), i.Certificate, i.Token, relay})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func LoadIdentity(dir string, rotate bool) (Identity, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return Identity{}, err
	}
	if err := restrictPath(dir, true); err != nil {
		return Identity{}, fmt.Errorf("protect state directory: %w", err)
	}
	p := filepath.Join(dir, "identity.json")
	b, err := os.ReadFile(p)
	if err == nil {
		if err := restrictPath(p, false); err != nil {
			return Identity{}, err
		}
		var i Identity
		if err := json.Unmarshal(b, &i); err != nil {
			return i, fmt.Errorf("invalid host identity: %w", err)
		}
		if _, err := i.TLSConfig(); err != nil {
			return i, fmt.Errorf("invalid host certificate: %w", err)
		}
		token, err := base64.RawURLEncoding.DecodeString(i.Token)
		if err != nil || len(token) != 32 {
			return i, errors.New("invalid host token")
		}
		if rotate {
			i.Token, err = randomToken()
			if err != nil {
				return i, err
			}
			err = saveIdentity(p, i)
		}
		return i, err
	}
	if !os.IsNotExist(err) {
		return Identity{}, err
	}
	i, err := newIdentity()
	if err != nil {
		return i, err
	}
	return i, saveIdentity(p, i)
}
func randomToken() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b), err
}
func newIdentity() (Identity, error) {
	// P-256 certificates interoperate with Electron's BoringSSL as well as Go
	// and Node/OpenSSL. BoringSSL does not negotiate Ed25519 TLS certificates.
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return Identity{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return Identity{}, err
	}
	now := time.Now()
	// The self-signed identity is a private trust anchor, supplied only to the
	// paired TLS connection. It is never installed into the operating system.
	// Clients additionally pin this exact certificate, rejecting other leaves.
	tmpl := x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Remoter host"}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(10, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return Identity{}, err
	}
	key, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return Identity{}, err
	}
	token, err := randomToken()
	if err != nil {
		return Identity{}, err
	}
	return Identity{string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key})), token}, nil
}
func saveIdentity(path string, i Identity) error {
	b, err := json.MarshalIndent(i, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".identity-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = restrictPath(tmp, false); err != nil {
		f.Close()
		return err
	}
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	return restrictPath(path, false)
}
