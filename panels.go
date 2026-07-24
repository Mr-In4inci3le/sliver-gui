package main

import (
	"fmt"
	"net"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/bishopfox/sliver/protobuf/clientpb"
	"github.com/bishopfox/sliver/protobuf/commonpb"
	"github.com/bishopfox/sliver/protobuf/sliverpb"
)

// panels.go implements: File Browser, Process Browser, Credential Auto-Populate,
// Kill Chain Tracker, Engagement Timer, Internal/External IP resolution,
// and Builder Streaming.

// ─── File Browser ─────────────────────────────────────────────────────────────

type FileEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
	Mode  string `json:"mode"`
}

type FileBrowserResult struct {
	Path  string      `json:"path"`
	Files []FileEntry `json:"files"`
	Error string      `json:"error,omitempty"`
}

// FileBrowserList lists files at a path for the visual file browser.
func (a *App) FileBrowserList(sessionID, path string) FileBrowserResult {
	client, err := a.requireClient()
	if err != nil {
		return FileBrowserResult{Error: err.Error()}
	}
	if path == "" {
		path = "."
	}
	a.audit.log("file-browse", sessionID, path)

	resp, err := client.RPC.Ls(a.ctx, &sliverpb.LsReq{
		Path:    path,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return FileBrowserResult{Error: err.Error()}
	}

	files := make([]FileEntry, 0, len(resp.Files))
	for _, f := range resp.Files {
		files = append(files, FileEntry{
			Name:  f.Name,
			IsDir: f.IsDir,
			Size:  f.Size,
			Mode:  f.Mode,
		})
	}
	return FileBrowserResult{Path: resp.Path, Files: files}
}

// FileBrowserDelete removes a file/directory.
func (a *App) FileBrowserDelete(sessionID, path string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("file-delete", sessionID, path)
	_, err = client.RPC.Rm(a.ctx, &sliverpb.RmReq{
		Path:      path,
		Recursive: true,
		Request:   &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Process Browser ──────────────────────────────────────────────────────────

type ProcessEntry struct {
	PID        int32  `json:"pid"`
	PPID       int32  `json:"ppid"`
	Executable string `json:"executable"`
	Owner      string `json:"owner"`
	Arch       string `json:"arch"`
	SessionID  string `json:"sessionID"`
}

type ProcessBrowserResult struct {
	Processes []ProcessEntry `json:"processes"`
	Error     string         `json:"error,omitempty"`
}

// ProcessBrowserList lists all processes for the visual process browser.
func (a *App) ProcessBrowserList(sessionID string) ProcessBrowserResult {
	client, err := a.requireClient()
	if err != nil {
		return ProcessBrowserResult{Error: err.Error()}
	}
	a.audit.log("process-browse", sessionID, "")

	resp, err := client.RPC.Ps(a.ctx, &sliverpb.PsReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ProcessBrowserResult{Error: err.Error()}
	}

	procs := make([]ProcessEntry, 0, len(resp.Processes))
	for _, p := range resp.Processes {
		procs = append(procs, ProcessEntry{
			PID:        p.Pid,
			PPID:       p.Ppid,
			Executable: p.Executable,
			Owner:      p.Owner,
			Arch:       p.Architecture,
			SessionID:  sessionID,
		})
	}
	return ProcessBrowserResult{Processes: procs}
}

// ProcessBrowserKill kills a remote process.
func (a *App) ProcessBrowserKill(sessionID string, pid int32) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("process-kill", sessionID, fmt.Sprintf("PID %d", pid))
	_, err = client.RPC.Terminate(a.ctx, &sliverpb.TerminateReq{
		Pid:     pid,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Internal/External IP Resolution ──────────────────────────────────────────

type AgentIPs struct {
	InternalIP string `json:"internalIP"`
	ExternalIP string `json:"externalIP"`
	Error      string `json:"error,omitempty"`
}

// GetAgentIPs returns the internal (private) and external (public/remote) IPs
// for an agent. Internal is pulled from ifconfig; external is the peer address.
func (a *App) GetAgentIPs(sessionID string) AgentIPs {
	client, err := a.requireClient()
	if err != nil {
		return AgentIPs{Error: err.Error()}
	}

	// Get internal IPs from ifconfig
	resp, err := client.RPC.Ifconfig(a.ctx, &sliverpb.IfconfigReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})

	internalIP := ""
	if err == nil && resp != nil {
		for _, iface := range resp.NetInterfaces {
			for _, addr := range iface.IPAddresses {
				ip := strings.Split(addr, "/")[0]
				if isPrivateIP(ip) && internalIP == "" {
					internalIP = ip
				}
			}
		}
	}

	// Get external IP from the session's remote address (handles IPv4 and IPv6)
	externalIP := ""
	sessions, _ := client.ListSessions(a.ctx)
	for _, s := range sessions {
		if s.ID == sessionID {
			host, _, err := net.SplitHostPort(s.RemoteAddress)
			if err != nil {
				// Fallback: might be bare IP without port
				host = s.RemoteAddress
			}
			externalIP = host
			break
		}
	}

	return AgentIPs{InternalIP: internalIP, ExternalIP: externalIP}
}

func isPrivateIP(ip string) bool {
	privates := []string{"10.", "172.16.", "172.17.", "172.18.", "172.19.",
		"172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
		"172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
		"192.168.", "169.254."}
	for _, prefix := range privates {
		if strings.HasPrefix(ip, prefix) {
			return true
		}
	}
	return false
}

// ─── Credential Auto-Populate ─────────────────────────────────────────────────

type ParsedCredential struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Hash     string `json:"hash"`
	Source   string `json:"source"`
}

// ParseAndStoreCredentials parses script output for well-known credential formats.
// It does NOT auto-store into Sliver's cred DB — call ConfirmAndStoreCredentials
// with the returned slice after the operator reviews them.
func (a *App) ParseAndStoreCredentials(output, source string) []ParsedCredential {
	creds := parseCredentials(output)
	for i := range creds {
		creds[i].Source = source
	}
	if len(creds) > 0 {
		a.audit.log("creds-parsed", "", fmt.Sprintf("%d candidates from %s", len(creds), source))
	}
	return creds
}

// ConfirmAndStoreCredentials stores operator-confirmed credentials in Sliver's DB.
func (a *App) ConfirmAndStoreCredentials(creds []ParsedCredential) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	for _, c := range creds {
		hashType := int32(0) // plaintext
		if c.Hash != "" {
			hashType = 1
		}
		_, _ = client.RPC.CredsAdd(a.ctx, &clientpb.Credentials{
			Credentials: []*clientpb.Credential{{
				Username:   c.Username,
				Plaintext:  c.Password,
				Hash:       c.Hash,
				HashType:   clientpb.HashType(hashType),
				Collection: c.Source,
			}},
		})
	}
	a.audit.log("creds-stored", "", fmt.Sprintf("%d credentials confirmed+stored", len(creds)))
	return nil
}

// Compiled credential regexes — only match well-known output formats.
var (
	// SAM dump: user:RID:LM_hash:NTLM_hash:::
	reSAMHash = regexp.MustCompile(`(?m)^([\w$\.\-]+):\d+:[a-fA-F0-9]{32}:([a-fA-F0-9]{32})`)
	// impacket secretsdump: DOMAIN\user:plaintext or DOMAIN/user:plaintext (after ":::")
	reSecretsDump = regexp.MustCompile(`(?m)^([\w\.\-]+(?:[/\\][\w\.\-]+)?):[^:]+:[a-fA-F0-9]{32}:([a-fA-F0-9]{32})`)
	// mimikatz: "Username : value" / "* Password : value" / "* NTLM     : hex"
	reMimikatzUser = regexp.MustCompile(`(?i)Username\s*:\s*(\S+)`)
	reMimikatzPass = regexp.MustCompile(`(?i)\*\s*Password\s*:\s*(.+)$`)
	reMimikatzNTLM = regexp.MustCompile(`(?i)\*\s*NTLM\s*:\s*([a-fA-F0-9]{32})`)
)

func parseCredentials(output string) []ParsedCredential {
	var creds []ParsedCredential
	seen := map[string]bool{}
	add := func(user, pass, hash string) {
		user = strings.TrimSpace(user)
		pass = strings.TrimSpace(pass)
		hash = strings.TrimSpace(hash)
		if user == "" || (pass == "" && hash == "") {
			return
		}
		// Skip obvious noise
		if user == "(null)" || pass == "(null)" || pass == "(null" {
			return
		}
		key := user + ":" + pass + ":" + hash
		if seen[key] {
			return
		}
		seen[key] = true
		creds = append(creds, ParsedCredential{Username: user, Password: pass, Hash: hash})
	}

	// 1. SAM hash lines: user:RID:LM:NTLM
	for _, m := range reSAMHash.FindAllStringSubmatch(output, -1) {
		add(m[1], "", m[2])
	}
	// 2. secretsdump NTLM lines
	for _, m := range reSecretsDump.FindAllStringSubmatch(output, -1) {
		add(m[1], "", m[2])
	}

	// 3. mimikatz block parsing: Username line followed by Password/NTLM lines
	lines := strings.Split(output, "\n")
	var curUser string
	for _, line := range lines {
		if m := reMimikatzUser.FindStringSubmatch(line); m != nil {
			curUser = m[1]
		} else if curUser != "" {
			if m := reMimikatzPass.FindStringSubmatch(line); m != nil {
				p := strings.TrimSpace(m[1])
				if p != "" && p != "(null)" {
					add(curUser, p, "")
				}
			}
			if m := reMimikatzNTLM.FindStringSubmatch(line); m != nil {
				add(curUser, "", m[1])
			}
		}
		// Reset on blank lines (new logon block)
		if strings.TrimSpace(line) == "" {
			curUser = ""
		}
	}
	return creds
}

// ─── Kill Chain Tracker ───────────────────────────────────────────────────────

// KillChainStage represents the progress of an engagement.
type KillChainState struct {
	Recon       bool   `json:"recon"`
	Access      bool   `json:"access"`
	PrivEsc     bool   `json:"privesc"`
	Lateral     bool   `json:"lateral"`
	DomainAdmin bool   `json:"domainAdmin"`
	Persistence bool   `json:"persistence"`
	LastUpdate  string `json:"lastUpdate"`
}

var (
	stateMu        sync.Mutex
	killChain      = KillChainState{}
	iocList        []IOCEntry
	iocCounter     int
	engagementStart *time.Time
)

// GetKillChain returns current kill chain progress.
func (a *App) GetKillChain() KillChainState {
	stateMu.Lock()
	defer stateMu.Unlock()
	return killChain
}

// UpdateKillChain advances a kill chain stage.
func (a *App) UpdateKillChain(stage string) KillChainState {
	stateMu.Lock()
	defer stateMu.Unlock()
	switch strings.ToLower(stage) {
	case "recon":
		killChain.Recon = true
	case "access":
		killChain.Access = true
	case "privesc":
		killChain.PrivEsc = true
	case "lateral":
		killChain.Lateral = true
	case "domainadmin", "da":
		killChain.DomainAdmin = true
	case "persistence", "persist":
		killChain.Persistence = true
	}
	killChain.LastUpdate = time.Now().Format(time.RFC3339)
	a.audit.log("killchain", stage, "")
	return killChain
}

// ResetKillChain resets all stages.
func (a *App) ResetKillChain() KillChainState {
	stateMu.Lock()
	defer stateMu.Unlock()
	killChain = KillChainState{}
	return killChain
}

// ResetEngagementState clears all per-engagement state (call on disconnect).
func (a *App) ResetEngagementState() {
	stateMu.Lock()
	defer stateMu.Unlock()
	killChain = KillChainState{}
	iocList = nil
	iocCounter = 0
	engagementStart = nil
	a.audit.log("engagement", "reset", "")
}

// ─── Engagement Timer ─────────────────────────────────────────────────────────

// StartEngagementTimer marks the beginning of the engagement.
func (a *App) StartEngagementTimer() string {
	stateMu.Lock()
	defer stateMu.Unlock()
	now := time.Now()
	engagementStart = &now
	a.audit.log("engagement", "start", now.Format(time.RFC3339))
	return now.Format(time.RFC3339)
}

// GetEngagementElapsed returns seconds since engagement started.
func (a *App) GetEngagementElapsed() int64 {
	stateMu.Lock()
	defer stateMu.Unlock()
	if engagementStart == nil {
		return 0
	}
	return int64(time.Since(*engagementStart).Seconds())
}

// ─── Builder Streaming (placeholder — streams are complex in Wails) ───────────

// GetBuilders lists external builders connected to the teamserver.
func (a *App) GetBuilders() ([]map[string]interface{}, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Builders(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	var result []map[string]interface{}
	for _, b := range resp.Builders {
		result = append(result, map[string]interface{}{
			"name":     b.Name,
			"operator": b.OperatorName,
			"goos":     b.GOOS,
			"goarch":   b.GOARCH,
			"targets":  b.CrossCompilers,
		})
	}
	return result, nil
}

// ─── IOC Tracker ──────────────────────────────────────────────────────────────

// IOCEntry represents an Indicator of Compromise left on a target.
type IOCEntry struct {
	ID        int    `json:"id"`
	Timestamp string `json:"timestamp"`
	Host      string `json:"host"`
	Type      string `json:"type"` // file, service, regkey, schtask, user, cron
	Path      string `json:"path"`
	Detail    string `json:"detail"`
}

// AddIOC records a new IOC. Thread-safe.
func (a *App) AddIOC(host, iocType, path, detail string) IOCEntry {
	stateMu.Lock()
	defer stateMu.Unlock()
	iocCounter++
	entry := IOCEntry{
		ID:        iocCounter,
		Timestamp: time.Now().Format("15:04:05"),
		Host:      host,
		Type:      iocType,
		Path:      path,
		Detail:    detail,
	}
	iocList = append(iocList, entry)
	a.audit.log("ioc-added", host, fmt.Sprintf("%s: %s", iocType, path))
	return entry
}

// GetIOCs returns all tracked IOCs.
func (a *App) GetIOCs() []IOCEntry {
	stateMu.Lock()
	defer stateMu.Unlock()
	out := make([]IOCEntry, len(iocList))
	copy(out, iocList)
	return out
}

// ClearIOCs resets the IOC list.
func (a *App) ClearIOCs() {
	stateMu.Lock()
	defer stateMu.Unlock()
	iocList = nil
	iocCounter = 0
}

// GenerateCleanupScript produces a script to remove all IOCs.
func (a *App) GenerateCleanupScript() string {
	if len(iocList) == 0 {
		return "# No IOCs tracked"
	}

	var winCmds, linCmds []string

	for _, ioc := range iocList {
		switch ioc.Type {
		case "file":
			winCmds = append(winCmds, fmt.Sprintf(`del /f "%s"`, ioc.Path))
			linCmds = append(linCmds, fmt.Sprintf(`rm -f "%s"`, ioc.Path))
		case "service":
			winCmds = append(winCmds, fmt.Sprintf(`sc stop %s & sc delete %s`, ioc.Path, ioc.Path))
			linCmds = append(linCmds, fmt.Sprintf(`systemctl stop %s && systemctl disable %s && rm /etc/systemd/system/%s.service`, ioc.Path, ioc.Path, ioc.Path))
		case "regkey":
			winCmds = append(winCmds, fmt.Sprintf(`reg delete "%s" /f`, ioc.Path))
		case "schtask":
			winCmds = append(winCmds, fmt.Sprintf(`schtasks /delete /tn "%s" /f`, ioc.Path))
		case "cron":
			linCmds = append(linCmds, fmt.Sprintf(`sed -i '/%s/d' /etc/crontab`, strings.ReplaceAll(ioc.Path, "/", `\/`)))
		case "user":
			winCmds = append(winCmds, fmt.Sprintf(`net user %s /delete`, ioc.Path))
			linCmds = append(linCmds, fmt.Sprintf(`userdel -r %s`, ioc.Path))
		}
	}

	script := "# ═══ VulnNetRed IOC Cleanup Script ═══\n"
	script += fmt.Sprintf("# Generated: %s\n", time.Now().Format(time.RFC3339))
	script += fmt.Sprintf("# IOCs tracked: %d\n\n", len(iocList))

	if len(winCmds) > 0 {
		script += "# ── Windows Cleanup ──\n"
		for _, c := range winCmds {
			script += c + "\n"
		}
		script += "\n"
	}
	if len(linCmds) > 0 {
		script += "# ── Linux Cleanup ──\n"
		for _, c := range linCmds {
			script += c + "\n"
		}
	}
	return script
}

// ─── Engagement Report ────────────────────────────────────────────────────────

// GenerateReport creates a Markdown engagement report from audit log + IOCs + kill chain.
func (a *App) GenerateReport() string {
	elapsed := a.GetEngagementElapsed()
	h := elapsed / 3600
	m := (elapsed % 3600) / 60
	s := elapsed % 60

	report := "# Engagement Report\n\n"
	report += fmt.Sprintf("**Duration:** %02d:%02d:%02d\n\n", h, m, s)
	report += fmt.Sprintf("**Generated:** %s\n\n", time.Now().Format(time.RFC3339))

	// Kill Chain
	report += "## Kill Chain Progress\n\n"
	report += "| Stage | Status |\n|-------|--------|\n"
	stages := []struct {
		name string
		done bool
	}{
		{"Reconnaissance", killChain.Recon},
		{"Initial Access", killChain.Access},
		{"Privilege Escalation", killChain.PrivEsc},
		{"Lateral Movement", killChain.Lateral},
		{"Domain Admin", killChain.DomainAdmin},
		{"Persistence", killChain.Persistence},
	}
	for _, st := range stages {
		status := "[----]"
		if st.done {
			status = "[DONE]"
		}
		report += fmt.Sprintf("| %s | %s |\n", st.name, status)
	}

	// IOCs
	report += "\n## Indicators of Compromise\n\n"
	if len(iocList) == 0 {
		report += "No IOCs tracked.\n"
	} else {
		report += "| Time | Host | Type | Path | Detail |\n|------|------|------|------|--------|\n"
		for _, ioc := range iocList {
			report += fmt.Sprintf("| %s | %s | %s | `%s` | %s |\n",
				ioc.Timestamp, ioc.Host, ioc.Type, ioc.Path, ioc.Detail)
		}
	}

	// Audit trail (last 50 entries)
	report += "\n## Operator Actions (Last 50)\n\n"
	entries, _ := a.RecentAudit(50)
	if len(entries) > 0 {
		report += "| Time | Action | Target | Detail |\n|------|--------|--------|--------|\n"
		for _, e := range entries {
			report += fmt.Sprintf("| %s | %s | %s | %s |\n",
				e.Time, e.Action, e.Target, e.Detail)
		}
	} else {
		report += "No audit entries.\n"
	}

	// Cleanup script
	report += "\n## Cleanup Script\n\n```bash\n"
	report += a.GenerateCleanupScript()
	report += "\n```\n"

	return report
}
