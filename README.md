# Sliver GUI

A desktop operator console for [Sliver C2](https://github.com/BishopFox/sliver),
in the spirit of Cobalt Strike / Havoc's GUIs. It does **not** reimplement any
C2 protocol logic it's a thin Wails (Go + web) frontend over Sliver's
existing `rpcpb.SliverRPC` gRPC service, using the same mTLS operator config
files the official `sliver-client` uses.

## Why Wails, not Electron

Sliver itself is written in Go and ships a reusable client package
(`github.com/bishopfox/sliver/client` + `protobuf/{clientpb,rpcpb,sliverpb}`).
Wails lets the Go backend import those packages directly and call the real
generated gRPC stubs no grpc-web proxy, no reimplementing the protocol in
JS, and no drift when upstream changes their `.proto` files.

## Project layout

```
sliver-gui/
├── main.go                        # Wails entrypoint
├── app.go                         # Bound methods exposed to the frontend
├── internal/sliverclient/
│   └── client.go                  # mTLS connection + RPC helpers
├── frontend/dist/                 # Plain HTML/CSS/JS UI (no bundler required)
│   ├── index.html
│   ├── style.css
│   └── main.js
├── go.mod
└── wails.json
```

## Prerequisites

- Go 1.22+
- [Wails v2 CLI](https://wails.io/docs/gettingstarted/installation): `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- A Sliver teamserver you have an operator account on, and its `.cfg` file
  (generate one server-side: `sliver-server operator --name <you> --lhost <teamserver> --save <you>.cfg`)

## Getting the dependencies

This scaffold was built in a sandboxed environment without access to the Go
module proxy, so `go.sum` isn't included yet. On a machine with normal
internet access:

```bash
cd sliver-gui
go mod tidy   # pulls bishopfox/sliver, wails/v2, grpc, etc.
```

## Running in dev mode

```bash
wails dev
```

## Building a release binary

```bash
wails build
```
## Screenshots
<img width="1912" height="837" alt="1" src="https://github.com/user-attachments/assets/34de2c40-85d6-4d5f-b985-80f9d335e93d" />
<br>
<br />
<img width="1912" height="842" alt="2" src="https://github.com/user-attachments/assets/11b4ffbd-5451-402d-b7b2-1c7ca40a4f37" />
<br>
<br />
<img width="1907" height="826" alt="3" src="https://github.com/user-attachments/assets/7d5ae20f-0d29-415a-879c-e468fc60e7a0" />
<br>
<br />
<img width="1907" height="832" alt="4" src="https://github.com/user-attachments/assets/1cbe4e8c-a261-49cd-8882-b5988b664928" />
<br>
<br />
<img width="1904" height="837" alt="5" src="https://github.com/user-attachments/assets/86f36f9e-3bbe-4f9a-a436-7d6d38ed49c4" />
<br>
<br />
<img width="1910" height="830" alt="6" src="https://github.com/user-attachments/assets/c15aa69d-7a46-4320-ba9f-8de90084cad5" />


## Current feature scope (v1)

- Connect via operator `.cfg` (mTLS, reuses Sliver's existing auth — no
  custom auth system built here)
- Session table (host / user / OS / transport / status), auto-refreshing
- Session rename
- Implant generation (GOOS/GOARCH/format/C2 URL → build)
- Saved HTTP(S) C2 profile listing
- Connected operator presence list

## Not yet built (next steps)

- Interactive session console (shell/task streaming) needs a tabbed
  terminal view wired to session-scoped RPCs
- File browser / process list per session
- Loot browser
- C2 profile *editor* (currently read-only listing)
- Real-time event stream (new session / operator join) via Sliver's
  streaming RPCs instead of polling
- Implant build log streaming (`BuilderRegister`/`BuilderTrigger`) for
  remote/offline builders
