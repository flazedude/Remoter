// Run with go run generate.go. These certificates and keys are test fixtures only.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"time"
)

func main() {
	for _, name := range []string{"host", "other"} {
		pub, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil { panic(err) }
		cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Remoter TEST ONLY " + name}, DNSNames: []string{"test.invalid"}, NotBefore: time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC), NotAfter: time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		der, err := x509.CreateCertificate(rand.Reader, cert, cert, pub, key)
		if err != nil { panic(err) }
		keyDer, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil { panic(err) }
		if err := os.WriteFile(name+"-cert.fixture", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0644); err != nil { panic(err) }
		if err := os.WriteFile(name+"-key.fixture", pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDer}), 0600); err != nil { panic(err) }
	}
}
