// Package ui embeds the operator web UI (single-file SPA).
package ui

import "embed"

//go:embed index.html
var Files embed.FS

// Index returns the SPA entry page.
func Index() []byte {
	data, err := Files.ReadFile("index.html")
	if err != nil {
		return []byte("<!doctype html><title>TeamClaw Operator</title><p>UI asset missing")
	}
	return data
}
