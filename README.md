<h1 align="center">Sliver GUI</h1>

<p align="center">
  A desktop operator console for the <a href="https://github.com/BishopFox/sliver">Sliver C2</a> framework
  in the spirit of Cobalt Strike and Havoc. Designed and Developed by <a href="https://rajkumarmullapudi.com/">Raj Kumar Mullapudi</a>
</p>

<p align="center">
  <img alt="Go" src="https://img.shields.io/badge/Go-1.25%2B-00ADD8?logo=go&logoColor=white">
  <img alt="Wails" src="https://img.shields.io/badge/Wails-v2-d32f2f">
  <img alt="Sliver" src="https://img.shields.io/badge/Sliver-C2-e23c4e">
  <img alt="Platform" src="https://img.shields.io/badge/Linux%20·%20Windows%20·%20macOS-555">
</p>

Sliver GUI is a thin [Wails v2](https://wails.io) (Go + plain HTML/CSS/JS) frontend over Sliver's
existing `rpcpb.SliverRPC` gRPC service. It reimplements **no** C2 logic and connects with the same
mTLS operator `.cfg` files as the official `sliver-client` every command-and-control capability
comes from Sliver itself. Because the backend is Go, it imports Sliver's real protobuf/gRPC stubs
directly: no grpc-web proxy, no protocol reimplementation, no drift when upstream changes its `.proto`.

> **Authorized use only.** This is an offensive-security tool. Use it solely on systems you own
> or have explicit written permission to test.

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
<br><br>
<img width="985" height="467" alt="image" src="https://github.com/user-attachments/assets/48c8ad5b-1aaa-4635-b32e-70fb7f59d50a" />
<br><br>
<img width="1912" height="837" alt="image" src="https://github.com/user-attachments/assets/f1206fd0-ff57-44f4-b8c0-4961fcd1f8eb" />
<br><br>
<img width="1911" height="840" alt="image" src="https://github.com/user-attachments/assets/532856c9-a76f-4559-b922-b48b5e24df43" />
<br><br>
<img width="1912" height="832" alt="image" src="https://github.com/user-attachments/assets/5db41809-17f4-40e2-bf7c-20a5a4901666" />
<br><br>
<img width="1912" height="756" alt="image" src="https://github.com/user-attachments/assets/b779ca54-7b43-4d0d-b066-66e25d7f73aa" />

---

## Features

| Area | What you get |
|------|--------------|
| **Agents** | Unified sessions + beacons table, plus an interactive **pivot graph** firewall/egress boundary on the left, agents laid out in their real pivot topology (chains joined by session id, so same-host pivots render correctly), arrows colour-coded by agent: **green** session · **red** SYSTEM/privileged · **blue** beacon. |
| **Per-agent console** | Real-time (session) or queued (beacon) consoles with **70+ RPC-backed commands**, a full **interactive PTY shell** (`shell -i` / `pty`) over a gRPC tunnel, and **extensions / BOFs** (`ext …`) run through the same flow as the official client. |
| **Server console** | A pinned `sliver >` prompt for ~45 teamserver commands. |
| **Implants** | **Generate** (mTLS · HTTP · DNS · WireGuard · `tcp-pivot`), profiles, builds, and **armory** install / remove. |
| **Data** | Loot · credentials · hosts · operators · full event log. |
| **Operator QoL** | JSONL **audit log**, per-teamserver persisted graph layout / notes / integrity, **`Ctrl+K`** command palette, live event stream with toasts, and auto-reconnect. |

<details>
<summary><b>Full command reference</b></summary>

<br>

**Per-agent:-** `ps · ls · cd · pwd · cat · mkdir · rm · mv · cp · chmod · chown · download · upload ·
screenshot · netstat · ifconfig · env · getenv · setenv · unsetenv · reg · grep · mount · memfiles ·
ssh · whoami · getprivs · getpid · procdump · kill · chtimes · execute · execute-assembly ·
execute-shellcode · sideload · spawndll · getsystem · make-token · impersonate · rev2self · runas ·
migrate · backdoor · dllhijack · msf · msf-inject · extensions · ext · socks · portfwd · rportfwd ·
wg-portfwd · wg-socks · pivot · services · loot · shell · shell -i / pty`
&nbsp;&nbsp;·&nbsp;&nbsp;beacon-only: `tasks · reconfig · interactive`

**Server:-** `sessions · beacons · jobs [kill] · restart-jobs · operators · loot · hosts · creds ·
builds · regenerate · profiles · c2profiles · certificates · compiler · builders · traffic-encoders ·
shellcode-encoders · armory [install/remove] · websites · canaries · stager · use · rename ·
kill-session · kill-beacon · version · mtls/http/https/dns/wg`

</details>

---

## Quick start

**Prerequisites**

- **Go 1.25.6+** with `GOTOOLCHAIN=auto` the right toolchain is fetched automatically
- **[Wails v2 CLI](https://wails.io/docs/gettingstarted/installation)** `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- **Linux WebKit deps** `sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev build-essential pkg-config`
- **A Sliver operator `.cfg`** `sliver-server operator --name <you> --lhost <host> --save <you>.cfg`

**Build & run**

```bash
go mod tidy
make build            # → build/bin/sliver-gui   (or: wails build -tags webkit2_41)
./build/bin/sliver-gui
```

> Hot reload: `make dev` · tests & linters: `make test` · `make lint` · `make vet`
> On WebKit 4.0 systems, use `make build TAGS=` (drop the `webkit2_41` tag).

---

## Usage

1. **Connect** :- select your operator `.cfg`.
2. **Listen** :- start a listener (Listeners panel, or `mtls 8443` in the server console).
3. **Generate** :- build an implant against that listener's C2 (or a `tcppivot://` for pivots), then **Save to disk**.
4. **Run** it on the target the session/beacon appears in the table and graph.
5. **Interact** :- double-click the agent, or `use <id>` in the server console.

---

## Notes

- **Sessions vs. beacons** sessions are real-time; beacon output is delayed by the check-in interval (± jitter).
- **`getsystem <profile>`** builds from a saved profile, so the profile must be complete and buildable.
- **Symbol obfuscation** is off by default so builds work on a stock teamserver (no garble required).
- Pinned to a `bishopfox/sliver` **master** commit to match recent / `devel` teamservers on a tagged teamserver, pin the matching Sliver release instead.

## Roadmap

`crack` (hashcat cluster) · `cursed` (Chrome/Electron injection) · WASM extension *execution* (listing is wired) · external builder log streaming.

---

## Credits

**GUI designed and developed by [Raj Kumar Mullapudi](mailto:in4inci3le001@gmail.com)** the Wails
backend, the vanilla-JS/HTML/CSS frontend (pivot graph, per-agent & server consoles, panels, command
palette, operator notes), and all RPC wiring.

Powered by the **[Sliver C2 framework](https://github.com/BishopFox/sliver)** (BishopFox) and
**[Wails](https://wails.io)**. Sliver GUI is a client interface only it does not modify or
redistribute the framework.

<sub>© 2026 Raj Kumar Mullapudi (GUI frontend) · Sliver C2 © BishopFox</sub>
