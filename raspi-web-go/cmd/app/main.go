package main

import (
	"fmt"
	"log"
	"net/http"
)

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "hello from raspi zero")
	})

	addr := "127.0.0.1:8080"
	log.Println("listening on", addr)

	log.Fatal(http.ListenAndServe(addr, nil))
}
