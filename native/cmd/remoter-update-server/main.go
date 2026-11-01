package main

import (
	"encoding/json"
	"flag"
	"github.com/flazedude/Remoter/native/internal/updatefeed"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:17846", "Private LAN listen address")
	root := flag.String("root", "", "Public installer directory")
	configPath := flag.String("config", "", "Public update configuration")
	once := flag.Bool("sync-only", false, "Verify and mirror GitHub once, then exit")
	flag.Parse()
	if *root == "" || *configPath == "" {
		log.Fatal("Supply --root and --config")
	}
	host, _, err := net.SplitHostPort(*listen)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || ip.To4() == nil || (!ip.IsPrivate() && !ip.IsLoopback()) {
		log.Fatal("Choose a private LAN IPv4 listen address")
	}
	var cfg updatefeed.Config
	data, err := os.ReadFile(*configPath)
	if err != nil {
		log.Fatal(err)
	}
	if err = json.Unmarshal(data, &cfg); err != nil {
		log.Fatal(err)
	}
	*root, err = filepath.Abs(*root)
	if err != nil {
		log.Fatal(err)
	}
	if err = os.MkdirAll(*root, 0700); err != nil {
		log.Fatal(err)
	}
	if *once {
		if err = updatefeed.Sync(*root, cfg); err != nil {
			log.Fatal(err)
		}
		log.Print("Signed installer mirror verified")
		return
	}
	go func() {
		for {
			if syncErr := updatefeed.Sync(*root, cfg); syncErr != nil {
				log.Printf("Mirror refresh: %v", syncErr)
			} else {
				log.Print("Mirror verified and current")
			}
			time.Sleep(5 * time.Minute)
		}
	}()
	server := &http.Server{Addr: *listen, Handler: updatefeed.Handler(*root, cfg), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	log.Printf("Remoter LAN updates listening on %s", *listen)
	log.Fatal(server.ListenAndServe())
}
