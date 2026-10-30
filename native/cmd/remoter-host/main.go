// remoter-host is an explicitly launched desktop host. It does not install a
// service, enable login persistence, or change operating-system permissions.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"syscall"
	"time"

	"github.com/flazedude/Remoter/native/internal/host"
	"github.com/flazedude/Remoter/native/internal/relay"
)

func main() {
	if err := run(); err != nil {
		log.SetFlags(0)
		log.Fatal("Remoter host: ", err)
	}
}
func run() error {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	hostname, _ := os.Hostname()
	listen := flag.String("listen", "127.0.0.1:45780", "HTTPS listen address; LAN access requires an explicit interface address")
	advertise := flag.String("advertise", "", "HTTPS address reachable by the controller")
	stateDir := flag.String("state-dir", filepath.Join(configDir, "Remoter", "host"), "private host identity directory")
	name := flag.String("name", hostname, "device display name")
	allowInput := flag.Bool("allow-input", false, "allow remote keyboard and mouse on this desktop")
	synthetic := flag.Bool("synthetic", false, "use generated frames and simulated input; never access the real desktop")
	rotate := flag.Bool("rotate-token", false, "invalidate existing pairing tokens before starting")
	exitOnStdinClose := flag.Bool("exit-on-stdin-close", false, "stop gracefully when the launching desktop app closes stdin")
	flag.Parse()
	if len(*name) == 0 || len(*name) > 120 || regexp.MustCompile(`[\x00-\x1f\x7f]`).MatchString(*name) {
		return errors.New("device name must contain 1 to 120 characters without control characters")
	}
	identity, err := host.LoadIdentity(*stateDir, *rotate)
	if err != nil {
		return err
	}
	tlsConfig, err := identity.TLSConfig()
	if err != nil {
		return err
	}
	handler, err := host.NewHandler(host.Config{Name: *name, Token: identity.Token, AllowInput: *allowInput, Synthetic: *synthetic})
	if err != nil {
		return err
	}
	defer handler.Close()
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	defer listener.Close()
	endpoint := *advertise
	if endpoint == "" {
		addr := listener.Addr().(*net.TCPAddr)
		if addr.IP.IsUnspecified() {
			return errors.New("--advertise https://HOST:PORT is required when listening on all interfaces")
		}
		endpoint = "https://" + listener.Addr().String()
	}
	var relayInvite *host.RelayInvite
	relayURL, relayDevice, relayToken := os.Getenv("REMOTER_RELAY_URL"), os.Getenv("REMOTER_RELAY_DEVICE"), os.Getenv("REMOTER_RELAY_TOKEN")
	relayProxy := os.Getenv("REMOTER_RELAY_PROXY_URL")
	if relayProxy != "" {
		if _, err := relay.ParseProxyURL(relayProxy); err != nil {
			return err
		}
	}
	if relayURL != "" && (relayDevice == "" || relayToken == "") {
		return errors.New("relay requires REMOTER_RELAY_DEVICE and REMOTER_RELAY_TOKEN")
	}
	if relayURL != "" {
		if _, err := relay.ValidateURL(relayURL); err != nil {
			return err
		}
		if !regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`).MatchString(relayDevice) || !regexp.MustCompile(`^[A-Za-z0-9_-]{32,256}$`).MatchString(relayToken) {
			return errors.New("invalid relay device ID or host access token")
		}
	}
	if relayURL != "" && os.Getenv("REMOTER_RELAY_VIEWER_TOKEN") != "" {
		if os.Getenv("REMOTER_RELAY_VIEWER_TOKEN") == relayToken {
			return errors.New("relay host and viewer tokens must be different")
		}
		if !regexp.MustCompile(`^[A-Za-z0-9_-]{32,256}$`).MatchString(os.Getenv("REMOTER_RELAY_VIEWER_TOKEN")) {
			return errors.New("invalid relay viewer access token")
		}
		relayInvite = &host.RelayInvite{URL: relayURL, DeviceID: relayDevice, Token: os.Getenv("REMOTER_RELAY_VIEWER_TOKEN")}
	}
	invitation, err := identity.Invite(*name, endpoint, relayInvite)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if *exitOnStdinClose {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	}
	server := &http.Server{Handler: handler, TLSConfig: tlsConfig, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 20 * time.Second, MaxHeaderBytes: 8192, ErrorLog: log.New(os.Stderr, "HTTPS: ", 0)}
	errCh := make(chan error, 1)
	go func() { errCh <- server.Serve(tls.NewListener(listener, tlsConfig)) }()
	if relayURL != "" {
		go func() {
			err := relay.ServeHost(ctx, relay.HostConfig{URL: relayURL, DeviceID: relayDevice, Token: relayToken, ProxyURL: relayProxy, TLSConfig: tlsConfig, Handler: handler, PoolSize: 4, OnError: func(error) { fmt.Fprintln(os.Stderr, "Relay unavailable; retrying.") }})
			if err != nil && ctx.Err() == nil {
				fmt.Fprintln(os.Stderr, "Relay stopped; direct host is still running.")
			}
		}()
	}
	mode := "view-only"
	if *allowInput {
		mode = "remote input enabled"
	}
	if *synthetic {
		mode += "; synthetic desktop"
	}
	fmt.Fprintln(os.Stderr, "Remoter host active ("+mode+"). Stop this process to stop hosting. Pairing grants access; share invitations privately.")
	// The parent desktop app consumes this one structured secret-bearing line.
	// No request logs or diagnostics contain the invitation/token.
	if err := json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "ready", "invitation": invitation, "address": endpoint}); err != nil {
		server.Close()
		return err
	}
	select {
	case <-ctx.Done():
		handler.Close()
		shutdownCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		return server.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
