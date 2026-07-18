# Sliver GUI build helpers.
# Requires: Go 1.22+, the Wails v2 CLI, and (on Linux) WebKit dev headers.

VERSION   ?= $(shell git describe --tags --always 2>/dev/null || echo dev)
COMMIT    ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
DATE      ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS    = -X main.Version=$(VERSION) -X main.GitCommit=$(COMMIT) -X main.BuildDate=$(DATE)

# WebKit 4.1 tag for modern Linux (Ubuntu 24.04, Kali). Override on WebKit 4.0:
#   make build TAGS=
TAGS ?= webkit2_41
TAGARG = $(if $(TAGS),-tags $(TAGS),)

.PHONY: build dev test lint vet icons clean

## build: compile the GUI with version metadata baked in
build: icons
	wails build $(TAGARG) -ldflags "$(LDFLAGS)"

## dev: run with hot reload
dev: icons
	wails dev $(TAGARG) -ldflags "$(LDFLAGS)"

## icons: copy source icons into the embedded frontend (first build only)
icons:
	@cp -r frontend/icons frontend/dist/icons 2>/dev/null || true

## test: run unit tests
test:
	go test $(TAGARG) -race -count=1 ./...

## vet: run go vet
vet:
	go vet $(TAGARG) ./...

## lint: run golangci-lint (must be installed)
lint:
	golangci-lint run --build-tags "$(TAGS)"

## clean: remove build output
clean:
	rm -rf build/bin dist
