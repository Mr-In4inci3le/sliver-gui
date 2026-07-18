# Security Policy

## Scope

Sliver GUI is the **client/operator interface** only. It does not implement any
command-and-control logic — all C2 capability, cryptography, and network
handling belong to the upstream [Sliver](https://github.com/BishopFox/sliver)
framework by BishopFox. Vulnerabilities in Sliver itself should be reported to
that project.

This policy covers the GUI layer: the Wails Go backend (`app.go`,
`internal/sliverclient`, `extensions.go`, `audit.go`) and the frontend.

## Reporting a vulnerability

Please report suspected security issues **privately** — do not open a public
issue for anything exploitable.

- Email: in4inci3le001@gmail.com
- Use GitHub's **private vulnerability reporting** ("Report a vulnerability" on
  the Security tab) if enabled.

Include reproduction steps, affected version (see the version string on the
connect screen), and impact. Expect an initial acknowledgement within a few
days.

## Trust model & known design decisions

These are deliberate, not bugs:

- **`InsecureSkipVerify: true` on the gRPC TLS config.** The teamserver presents
  a certificate whose CN does not match the dial address, so Go's default
  hostname verification cannot be used. The GUI compensates with a manual
  `VerifyPeerCertificate` callback that pins the operator config's CA — the same
  approach the official `sliver-client` uses. TLS is **not** actually disabled.
- **Operator `.cfg` files contain live mTLS keys and an auth token.** They are
  never committed (`.gitignore` blocks `*.cfg`/`*.pem`/`*.key`) and never copied
  by the GUI. Treat them as secrets.
- **Local operator state** (notes, integrity results, graph layout) is stored in
  the browser `localStorage` of the embedded WebView, scoped per teamserver.
- **Audit log** (`~/.sliver-gui/audit.log`) records operator actions (connect,
  generate, commands) in JSONL with `0600` permissions. It is local-only and
  never transmitted.

## Responsible use

This is an offensive-security tool. Use it only against systems you own or have
explicit written authorization to test. You are responsible for compliance with
all applicable laws.
