# Sliver GUI

**A desktop operator console for [Sliver C2](https://github.com/BishopFox/sliver) GUI developed by [Raj Kumar Mullapudi](#author--credits).**

In the spirit of Cobalt Strike / Havoc's GUIs. It does **not** reimplement any
C2 protocol logic it's a thin [Wails v2](https://wails.io) (Go + plain
HTML/CSS/JS) frontend over Sliver's existing `rpcpb.SliverRPC` gRPC service,
using the same mTLS operator config files the official `sliver-client` uses.

> This project is the **GUI layer only**. The Sliver C2 framework it drives is a
> separate project by BishopFox all C2 capability comes from Sliver; this repo
> contributes the desktop operator interface on top of it.

> ⚠️ **Authorized use only.** This is an offensive-security tool. Use it solely
> on systems you own or have **explicit written permission** to test. You are
> responsible for complying with all applicable laws.

---

## Screenshots

<img width="1912" height="837" alt="1" src="https://github.com/user-attachments/assets/34de2c40-85d6-4d5f-b985-80f9d335e93d" />
<br><br>
<img width="1912" height="842" alt="2" src="https://github.com/user-attachments/assets/11b4ffbd-5451-402d-b7b2-1c7ca40a4f37" />
<br><br>
<img width="1907" height="826" alt="3" src="https://github.com/user-attachments/assets/7d5ae20f-0d29-415a-879c-e468fc60e7a0" />
<br><br>
<img width="1907" height="832" alt="4" src="https://github.com/user-attachments/assets/1cbe4e8c-a261-49cd-8882-b5988b664928" />
<br><br>
<img width="1904" height="837" alt="5" src="https://github.com/user-attachments/assets/86f36f9e-3bbe-4f9a-a436-7d6d38ed49c4" />
<br><br>
<img width="1910" height="830" alt="6" src="https://github.com/user-attachments/assets/c15aa69d-7a46-4320-ba9f-8de90084cad5" />

> Screenshots reflect the current interactive graph, per-agent + server consoles,
> and management panels.

---

## Features

**Connection**
- Connect with a Sliver operator `.cfg` file (mTLS cert + token the same
  credential the official client uses; no username/password).
- Live event stream (session/beacon/job events) with toast notifications.
- Auto-reconnect with a countdown overlay if the teamserver drops.

**Agent overview**
- Combined **sessions + beacons** table (type, host, user, OS/arch, PID,
  transport, last check-in, status).
- Interactive **graph view** drag nodes, pan, scroll to zoom, straight edges,
  OS icons (Windows/Linux, privileged vs. user), privileged agents highlighted,
  dead agents greyed out. Double-click a node to interact.
- Right-click menu: Interact / Rename / Kill.

**Per-agent console** (double-click an agent)
- Sessions run commands in real time; beacons queue commands and poll for
  results on the next check-in.
- Native RPC-backed commands (no shell spawned unless you ask):
  `ps · ls · cd · pwd · cat · mkdir · rm · mv · cp · chmod · chown · download ·
  upload · screenshot · netstat · ifconfig · env · getenv · setenv · unsetenv ·
  reg · whoami · getprivs · getpid · procdump · kill · chtimes · execute ·
  execute-assembly · execute-shellcode · sideload · spawndll · getsystem ·
  make-token · impersonate · rev2self · runas · migrate · backdoor · dllhijack ·
  msf · msf-inject · extensions · ext · socks · portfwd · rportfwd · wg-portfwd ·
  wg-socks · pivot · services · loot · shell`
- **Extensions / BOFs:** `extensions` lists installed + loaded extensions;
  `ext <command> [args]` loads and runs an extension or BOF (e.g. `ext sa-whoami`,
  `ext nanodump ...`). Reads manifests from `~/.sliver-client/extensions`, packs
  BOF arguments via Sliver's own `core.BOFArgsBuffer`, and routes BOFs through
  their coff-loader dependency — same flow as the official client.
- Beacon-only: `tasks`, `reconfig <interval> <jitter>` (change check-in speed
  live), `interactive` (promote a beacon to a session).
- `shell <cmd>` and unrecognized input run in the target's OS shell.
- Type `help` in any console for the full list.

**Server console** (pinned tab)
- A `sliver >` prompt for teamserver commands:
  `sessions · beacons · jobs [kill <id>] · operators · loot · hosts · creds ·
  builds · regenerate <name> · profiles · c2profiles · websites · canaries ·
  stager · use <id> · rename · kill-session/kill-beacon · version ·
  mtls/http/https/dns/wg <…>`.

**Panels**
- **Listeners** start/stop mTLS, HTTP, HTTPS, DNS (and WireGuard) listeners.
- **Generate** build implants; pick an active listener to auto-fill the C2 URL;
  session or beacon mode; saves the binary via a native dialog.
- **Builds** list and delete previous implant builds.
- **Profiles** create / delete implant profiles and generate from them.
- **Loot** shared loot store: `loot add <file>` from a session, download or
  delete items from the panel.
- **Creds** shared credential store: add / list / delete captured credentials.
- **Hosts** the teamserver's host database (seen hosts, OS, first contact).
- **Operators** who's connected.
- **Event Log** full activity history (pinned in the console by default).

**Quality-of-life**
- Per-agent **operator notes** (in-memory, cleared on disconnect).
- **Command palette** `Ctrl+K` to jump to any agent or panel.
- **On-demand integrity check** right-click a session → *Check Integrity* runs
  `getprivs` and repaints the node/table by its real level (SYSTEM / High /
  Medium), instead of guessing from the username.
- Privilege-aware graph: SYSTEM/admin agents get red edges + a `★ LEVEL` badge;
  beacons are dashed blue; dead agents use a distinct dead icon.

---

## Why Wails, not Electron

Sliver is written in Go and ships reusable client packages
(`github.com/bishopfox/sliver/protobuf/{clientpb,rpcpb,sliverpb}`). Wails lets
the Go backend import those directly and call the real generated gRPC stubs
no grpc-web proxy, no reimplementing the protocol in JS, and no drift when
upstream changes their `.proto` files.

## Project layout

```
sliver-gui/
├── main.go                     # Wails entrypoint
├── app.go                      # Bound methods exposed to the frontend
├── internal/sliverclient/
│   └── client.go               # mTLS connection + RPC helpers
├── frontend/
│   ├── dist/                   # Plain HTML/CSS/JS UI (no bundler)
│   │   ├── index.html
│   │   ├── style.css
│   │   ├── main.js
│   │   └── icons/              # Node icons (embedded in the build)
│   └── icons/                  # Source icons (copy into dist/ before building)
├── go.mod
└── wails.json
```

## Prerequisites

- Go 1.22+
- [Wails v2 CLI](https://wails.io/docs/gettingstarted/installation):
  `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- Linux WebKit build deps (Debian/Kali/Ubuntu):
  `sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev build-essential pkg-config`
- A Sliver teamserver you have an operator account on, and its `.cfg` file:
  ```
  sliver-server operator --name <you> --lhost <teamserver> --save <you>.cfg
  ```

## Build & run

Fetch dependencies (needs internet the first time):

```bash
go mod tidy
```

Make sure the icons are in the embedded frontend, then build (Linux uses the
WebKit 4.1 build tag):

```bash
cp -r frontend/icons frontend/dist/icons   # first build only
wails build -tags webkit2_41
./build/bin/sliver-gui
```

Dev mode (hot reload):

```bash
wails dev -tags webkit2_41
```

> On systems with WebKit 4.0 instead of 4.1, drop `-tags webkit2_41`.

## Usage

1. Launch the app, click **Select operator .cfg**, choose your `.cfg`, then
   **Connect**.
2. Start a listener (**Listeners** panel or `mtls 8443` in the Server console).
3. **Generate** an implant pick your listener from the *From Listener*
   dropdown so the C2 URL is filled correctly (point it at a **C2 listener
   port**, not the teamserver's operator port).
4. Run the implant on the target; the session/beacon appears in the table/graph.
5. Double-click it to open a console, or `use <id-prefix>` in the Server console.

## Notes & known behaviors

- **Sessions vs. beacons:** sessions are real-time; beacons only respond on
  their check-in interval (interval ± jitter), so beacon output is delayed by
  design. Use a shorter interval or a session for interactive work.
- **`getsystem <profile>`** builds a fresh implant from a saved profile, so the
  profile must be a complete, buildable config. Profiles created with older
  versions may fail delete and recreate them.
- **Symbol obfuscation** is disabled for generated implants so builds work on a
  stock teamserver (garble isn't required).
- Built and tested against **Sliver v1.7.x**. Other versions may have different
  protobuf field names.

## Architecture (for contributors)

- Every backend capability is an exported method on the `App` struct in
  `app.go`; Wails auto-binds them to `window.go.main.App.*` in JS.
- All session-scoped RPCs use `&commonpb.Request{SessionID: ...}`; beacon tasks
  use `BeaconID` + `Async` and are polled via `GetBeaconTasks` /
  `GetBeaconTaskContent`.
- SOCKS5 / port-forward open a local TCP listener and relay bytes over the
  respective streaming RPC.
- The frontend is dependency-free plain JS in `frontend/dist/` (no npm/bundler).

## Author & Credits

- **GUI (this project) designed and developed by [Raj Kumar Mullapudi](mailto:in4inci3le001@gmail.com).**
  This includes the entire Wails backend (`app.go`, `internal/sliverclient`),
  the plain-JS/HTML/CSS frontend (interactive graph, per-agent console, server
  console, panels, command palette, operator notes), and all RPC wiring.
- **Sliver C2 framework by [BishopFox](https://github.com/BishopFox/sliver).**
  All command-and-control capability comes from Sliver; this project is a client
  interface for it and does not modify or redistribute the framework itself.
- **[Wails](https://wails.io)** the Go + web desktop framework this is built on.

## Roadmap

Implemented: sessions/beacons, interactive graph, per-agent + server consoles,
full filesystem/process/network/registry/token/execution command sets,
tunneling (socks/portfwd/rportfwd/pivots/wireguard), listeners, generation,
profiles, builds, loot, creds, hosts, websites, canaries, stager listeners,
**extensions/BOFs**, operator notes, command palette, and on-demand integrity
checks.

Not yet built (contributions welcome):
- Armory package **install** (download/verify extensions from the armory repos;
  extension *loading/running* is already implemented)
- `crack` (hashcat cluster) · `cursed` (Chrome/Electron injection) · `wasm` extensions
- HTTP C2 profile **editor** (currently read-only listing)
- External/offline builder log streaming (`BuilderRegister`/`BuilderTrigger`)
- Certificate management panel

## License

This project links against [BishopFox/sliver](https://github.com/BishopFox/sliver),
which is licensed under the **GNU General Public License v3.0**. As a derivative
work, this project (the GUI) is distributed under the **same GPLv3 license**.
See the `LICENSE` file.

Copyright (C) 2026 Raj Kumar Mullapudi (GUI frontend). Sliver C2 is
Copyright (C) BishopFox.
