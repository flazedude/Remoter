package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/flazedude/Remoter/native/internal/relay"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8788", "listen address (loopback behind a WSS reverse proxy by default)")
	cert := flag.String("tls-cert", "", "public TLS certificate PEM for standalone WSS")
	key := flag.String("tls-key", "", "public TLS key PEM for standalone WSS")
	flag.Parse()
	if (*cert == "") != (*key == "") {
		log.Fatal("both -tls-cert and -tls-key are required")
	}
	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		log.Fatal("invalid listen address")
	}
	ip := net.ParseIP(host)
	if *cert == "" && host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		log.Fatal("plain HTTP relay must listen on loopback; use TLS or a local WSS reverse proxy")
	}
	var devices map[string]relay.DeviceCredentials
	if err := json.Unmarshal([]byte(os.Getenv("REMOTER_RELAY_DEVICES")), &devices); err != nil {
		log.Fatal("set REMOTER_RELAY_DEVICES to a JSON object with per-device hostToken and viewerToken")
	}
	service, err := relay.NewServer(relay.Config{Devices: devices})
	if err != nil {
		log.Fatal(err)
	}
	defer service.Close()
	server := &http.Server{
		Addr: *listen, Handler: service,
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second,
		MaxHeaderBytes: 8192,
		TLSConfig:      &tls.Config{MinVersion: tls.VersionTLS12},
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		service.Close()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("Remoter relay listening on %s; %d configured devices", *listen, len(devices))
	if *cert != "" {
		err = server.ListenAndServeTLS(*cert, *key)
	} else {
		err = server.ListenAndServe()
	}
	if err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
