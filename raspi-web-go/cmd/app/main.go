package main

import (
	"fmt"
	"log"
	"net/http"
)

func main() {
	http.HandleFunc("/", handler)

	addr := "127.0.0.1:8080"
	log.Println("listening on", addr)

	log.Fatal(http.ListenAndServe(addr, nil))
}

func handler(w http.ResponseWriter, r *http.Request) {
	email := r.Header.Get("Cf-Access-Authenticated-User-Email")
	fmt.Fprintf(w, "hello %s\n", email)
}
