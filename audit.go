package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// auditEntry is one line in the operator audit log (JSONL).
type auditEntry struct {
	Time     string `json:"time"`     // RFC3339 UTC
	Operator string `json:"operator"` // who was connected
	Server   string `json:"server"`   // teamserver host:port
	Action   string `json:"action"`   // e.g. "connect", "generate", "command"
	Target   string `json:"target"`   // session/beacon id or host, when relevant
	Detail   string `json:"detail"`   // free-form (command line, filename, ...)
}

// auditLogger appends operator actions to ~/.sliver-gui/audit.log.
// Enterprise deployments need a durable record of who did what, when; the GUI
// previously kept nothing. Best-effort: logging failures never block an action.
type auditLogger struct {
	mu       sync.Mutex
	path     string
	operator string
	server   string
}

func newAuditLogger() *auditLogger {
	dir := configDir()
	_ = os.MkdirAll(dir, 0o700)
	return &auditLogger{path: filepath.Join(dir, "audit.log")}
}

// setIdentity records who/where subsequent entries belong to (set on connect).
func (al *auditLogger) setIdentity(operator, server string) {
	al.mu.Lock()
	al.operator, al.server = operator, server
	al.mu.Unlock()
}

// log appends one entry. Never returns an error (audit must not break ops).
func (al *auditLogger) log(action, target, detail string) {
	if al == nil {
		return
	}
	al.mu.Lock()
	defer al.mu.Unlock()
	e := auditEntry{
		Time:     time.Now().UTC().Format(time.RFC3339),
		Operator: al.operator,
		Server:   al.server,
		Action:   action,
		Target:   target,
		Detail:   detail,
	}
	f, err := os.OpenFile(al.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	b, _ := json.Marshal(e)
	f.Write(append(b, '\n'))
}

// configDir returns the per-user GUI state directory (~/.sliver-gui),
// falling back to the working dir if the home dir can't be resolved.
func configDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".sliver-gui"
	}
	return filepath.Join(home, ".sliver-gui")
}

// AuditLogPath is exposed to the frontend so operators can find their log.
func (a *App) AuditLogPath() string {
	return filepath.Join(configDir(), "audit.log")
}

// RecentAudit returns up to `limit` most-recent audit entries (newest last)
// for display in the GUI. Bound to window.go.main.App.RecentAudit.
func (a *App) RecentAudit(limit int) ([]auditEntry, error) {
	path := filepath.Join(configDir(), "audit.log")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []auditEntry{}, nil
		}
		return nil, err
	}
	var entries []auditEntry
	for _, line := range splitLines(data) {
		if len(line) == 0 {
			continue
		}
		var e auditEntry
		if json.Unmarshal(line, &e) == nil {
			entries = append(entries, e)
		}
	}
	if limit > 0 && len(entries) > limit {
		entries = entries[len(entries)-limit:]
	}
	return entries, nil
}

func splitLines(b []byte) [][]byte {
	var out [][]byte
	start := 0
	for i, c := range b {
		if c == '\n' {
			out = append(out, b[start:i])
			start = i + 1
		}
	}
	if start < len(b) {
		out = append(out, b[start:])
	}
	return out
}
