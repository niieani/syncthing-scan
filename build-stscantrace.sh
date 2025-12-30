#!/bin/sh
set -eu

# Build stscantrace for Apple Silicon (darwin/arm64).
# For Linux (example): GOOS=linux GOARCH=amd64 go build -o stscantrace-linux-amd64 ./cmd/dev/stscantrace

go build -o stscantrace-darwin-arm64 ./cmd/dev/stscantrace
