package main

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/bishopfox/sliver/protobuf/clientpb"
	"github.com/bishopfox/sliver/protobuf/commonpb"
	"github.com/bishopfox/sliver/protobuf/sliverpb"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"google.golang.org/protobuf/encoding/protojson"
)

// features.go wires the remaining Sliver RPCs the GUI was missing, bringing the
// operator surface close to parity with the official client: post-exploitation
// commands (grep/mount/memfiles/ssh/reg-hive), a Services panel, and several
// server-level views (certificates, compiler, builders, HTTP-C2 profiles,
// traffic/shellcode encoders).

// ─── Post-exploitation console commands ─────────────────────────────────────

// GrepFiles searches file contents on the target (Sliver `grep`).
func (a *App) GrepFiles(sessionID, pattern, path string, recursive bool) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	a.audit.log("grep", sessionID, fmt.Sprintf("%q in %s", pattern, path))
	resp, err := client.RPC.Grep(a.ctx, &sliverpb.GrepReq{
		SearchPattern: pattern,
		Path:          path,
		Recursive:     recursive,
		Request:       &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	if len(resp.Results) == 0 {
		return "(no matches)", nil
	}
	files := make([]string, 0, len(resp.Results))
	for f := range resp.Results {
		files = append(files, f)
	}
	sort.Strings(files)
	var b strings.Builder
	for _, f := range files {
		fr := resp.Results[f]
		if fr == nil {
			continue
		}
		for _, r := range fr.FileResults {
			fmt.Fprintf(&b, "%s:%d: %s\n", f, r.LineNumber, strings.TrimRight(r.Line, "\r\n"))
		}
	}
	if b.Len() == 0 {
		return "(no matches)", nil
	}
	return b.String(), nil
}

// MountView is one mounted volume/filesystem on the target.
type MountView struct {
	Volume     string `json:"volume"`
	Type       string `json:"type"`
	MountPoint string `json:"mountPoint"`
	Label      string `json:"label"`
	FileSystem string `json:"fileSystem"`
	UsedSpace  uint64 `json:"usedSpace"`
	FreeSpace  uint64 `json:"freeSpace"`
	TotalSpace uint64 `json:"totalSpace"`
}

// ListMounts enumerates mounted drives/filesystems (Sliver `mount`).
func (a *App) ListMounts(sessionID string) ([]MountView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Mount(a.ctx, &sliverpb.MountReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]MountView, 0, len(resp.Info))
	for _, m := range resp.Info {
		out = append(out, MountView{
			Volume:     m.VolumeName,
			Type:       m.VolumeType,
			MountPoint: m.MountPoint,
			Label:      m.Label,
			FileSystem: m.FileSystem,
			UsedSpace:  m.UsedSpace,
			FreeSpace:  m.FreeSpace,
			TotalSpace: m.TotalSpace,
		})
	}
	return out, nil
}

// MemfilesList lists anonymous in-memory files held open by the implant.
func (a *App) MemfilesList(sessionID string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.MemfilesList(a.ctx, &sliverpb.MemfilesListReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	if len(resp.Files) == 0 {
		return "(no memfiles)", nil
	}
	var b strings.Builder
	for _, f := range resp.Files {
		fmt.Fprintf(&b, "%-8s %10d  %s\n", f.Mode, f.Size, f.Name)
	}
	return b.String(), nil
}

// MemfilesAdd creates a new anonymous in-memory file and returns its fd.
func (a *App) MemfilesAdd(sessionID string) (int64, error) {
	client, err := a.requireClient()
	if err != nil {
		return 0, err
	}
	a.audit.log("memfiles-add", sessionID, "")
	resp, err := client.RPC.MemfilesAdd(a.ctx, &sliverpb.MemfilesAddReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return 0, err
	}
	return resp.Fd, nil
}

// MemfilesRm removes an in-memory file by fd.
func (a *App) MemfilesRm(sessionID string, fd int64) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("memfiles-rm", sessionID, fmt.Sprintf("fd=%d", fd))
	_, err = client.RPC.MemfilesRm(a.ctx, &sliverpb.MemfilesRmReq{
		Fd:      fd,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// SSHResult is the output of a pivot SSH command.
type SSHResult struct {
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
	Error  string `json:"error,omitempty"`
}

// SSHExec runs a command on a remote host over SSH from the implant (Sliver
// `ssh`). Password auth path; key/kerberos are left to the CLI for now.
func (a *App) SSHExec(sessionID, host string, port int, user, pass, command string) SSHResult {
	client, err := a.requireClient()
	if err != nil {
		return SSHResult{Error: err.Error()}
	}
	if port == 0 {
		port = 22
	}
	a.audit.log("ssh", sessionID, fmt.Sprintf("%s@%s:%d %s", user, host, port, command))
	resp, err := client.RPC.RunSSHCommand(a.ctx, &sliverpb.SSHCommandReq{
		Username: user,
		Hostname: host,
		Port:     uint32(port),
		Password: pass,
		Command:  command,
		Request:  &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return SSHResult{Error: err.Error()}
	}
	return SSHResult{Stdout: resp.StdOut, Stderr: resp.StdErr}
}

// RegistryReadHiveExport reads an entire registry hive off the target and saves
// the raw bytes locally via a save dialog (Sliver `reg read-hive`). Windows only.
func (a *App) RegistryReadHiveExport(sessionID, rootHive, requestedHive string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.RegistryReadHive(a.ctx, &sliverpb.RegistryReadHiveReq{
		RootHive:      rootHive,
		RequestedHive: requestedHive,
		Request:       &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	data := resp.Data
	if resp.Encoder == "gzip" {
		if dec, derr := decodeDownload(&sliverpb.Download{Encoder: "gzip", Data: data}); derr == nil {
			data = dec
		}
	}
	savePath, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: strings.ToLower(rootHive) + ".hive",
		Title:           "Save registry hive",
	})
	if err != nil || savePath == "" {
		return "", fmt.Errorf("save cancelled")
	}
	if werr := os.WriteFile(savePath, data, 0600); werr != nil {
		return "", werr
	}
	a.audit.log("reg-read-hive", sessionID, rootHive+" -> "+savePath)
	return savePath, nil
}

// ─── Services (Windows) — native RPC detail/start ───────────────────────────
// (ServiceView, serviceView, and ListServices live in app.go.)

// ServiceDetail returns full detail for a single named service.
func (a *App) ServiceDetail(sessionID, hostname, name string) (ServiceView, error) {
	client, err := a.requireClient()
	if err != nil {
		return ServiceView{}, err
	}
	resp, err := client.RPC.ServiceDetail(a.ctx, &sliverpb.ServiceDetailReq{
		ServiceInfo: &sliverpb.ServiceInfoReq{ServiceName: name, Hostname: hostname},
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ServiceView{}, err
	}
	return serviceView(resp.Detail), nil
}

// StartServiceByName starts an existing service by name (Sliver `services start`).
func (a *App) StartServiceByName(sessionID, hostname, name string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("service-start", sessionID, name)
	_, err = client.RPC.StartServiceByName(a.ctx, &sliverpb.StartServiceByNameReq{
		ServiceInfo: &sliverpb.ServiceInfoReq{ServiceName: name, Hostname: hostname},
		Request:     &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Server-level views ─────────────────────────────────────────────────────

// CertView is a certificate row from the teamserver's CA store.
type CertView struct {
	CN           string `json:"cn"`
	Type         string `json:"type"`
	KeyAlgorithm string `json:"keyAlgorithm"`
	ValidStart   string `json:"validStart"`
	ValidExpiry  string `json:"validExpiry"`
	Created      string `json:"created"`
	ID           string `json:"id"`
}

// ListCertificates returns the teamserver's issued certificates.
func (a *App) ListCertificates() ([]CertView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetCertificateInfo(a.ctx, &clientpb.CertificatesReq{})
	if err != nil {
		return nil, err
	}
	out := make([]CertView, 0, len(resp.Info))
	for _, c := range resp.Info {
		out = append(out, CertView{
			CN:           c.CN,
			Type:         c.Type,
			KeyAlgorithm: c.KeyAlgorithm,
			ValidStart:   c.ValidityStart,
			ValidExpiry:  c.ValidityExpiry,
			Created:      c.CreationTime,
			ID:           c.ID,
		})
	}
	return out, nil
}

// CompilerTargetView is one supported (goos, goarch, format) build target.
type CompilerTargetView struct {
	GOOS   string `json:"goos"`
	GOARCH string `json:"goarch"`
	Format string `json:"format"`
}

// CompilerView describes the teamserver's build capabilities.
type CompilerView struct {
	GOOS           string               `json:"goos"`
	GOARCH         string               `json:"goarch"`
	Targets        []CompilerTargetView `json:"targets"`
	CrossCompilers []string             `json:"crossCompilers"`
}

// GetCompilerInfo reports the teamserver OS/arch and which targets it can build.
func (a *App) GetCompilerInfo() (CompilerView, error) {
	client, err := a.requireClient()
	if err != nil {
		return CompilerView{}, err
	}
	resp, err := client.RPC.GetCompiler(a.ctx, &commonpb.Empty{})
	if err != nil {
		return CompilerView{}, err
	}
	cv := CompilerView{GOOS: resp.GOOS, GOARCH: resp.GOARCH}
	for _, t := range resp.Targets {
		cv.Targets = append(cv.Targets, CompilerTargetView{
			GOOS: t.GOOS, GOARCH: t.GOARCH, Format: t.Format.String(),
		})
	}
	for _, cc := range resp.CrossCompilers {
		cv.CrossCompilers = append(cv.CrossCompilers, cc.TargetGOOS+"/"+cc.TargetGOARCH)
	}
	return cv, nil
}

// BuilderView is a registered external builder.
type BuilderView struct {
	Name         string `json:"name"`
	OperatorName string `json:"operatorName"`
	GOOS         string `json:"goos"`
	GOARCH       string `json:"goarch"`
	Templates    string `json:"templates"`
}

// ListBuilders returns external build servers registered with the teamserver.
func (a *App) ListBuilders() ([]BuilderView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.Builders(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]BuilderView, 0, len(resp.Builders))
	for _, b := range resp.Builders {
		out = append(out, BuilderView{
			Name:         b.Name,
			OperatorName: b.OperatorName,
			GOOS:         b.GOOS,
			GOARCH:       b.GOARCH,
			Templates:    strings.Join(b.Templates, ", "),
		})
	}
	return out, nil
}

// HTTPC2View summarises an HTTP C2 profile.
type HTTPC2View struct {
	Name    string `json:"name"`
	ID      string `json:"id"`
	Created int64  `json:"created"`
}

// ListHTTPC2Profiles returns the teamserver's HTTP C2 profiles.
func (a *App) ListHTTPC2Profiles() ([]HTTPC2View, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetHTTPC2Profiles(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]HTTPC2View, 0, len(resp.Configs))
	for _, c := range resp.Configs {
		out = append(out, HTTPC2View{Name: c.Name, ID: c.ID, Created: c.Created})
	}
	return out, nil
}

// ListTrafficEncoders returns the names of installed traffic (WASM) encoders.
func (a *App) ListTrafficEncoders() ([]string, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.TrafficEncoderMap(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(resp.Encoders))
	for name := range resp.Encoders {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

// ListShellcodeEncoders returns the names of available shellcode encoders.
func (a *App) ListShellcodeEncoders() ([]string, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.ShellcodeEncoderMap(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(resp.Encoders))
	for name := range resp.Encoders {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

// RestartJobs restarts the given listener jobs by ID (Sliver `jobs -k` + restart).
func (a *App) RestartJobs(ids []int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	jobIDs := make([]uint32, 0, len(ids))
	for _, id := range ids {
		jobIDs = append(jobIDs, uint32(id))
	}
	a.audit.log("restart-jobs", "", fmt.Sprintf("%v", ids))
	_, err = client.RPC.RestartJobs(a.ctx, &clientpb.RestartJobReq{JobIDs: jobIDs})
	return err
}

// ListCAInfo returns the teamserver's certificate-authority certificates.
func (a *App) ListCAInfo() ([]CertView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.GetCertificateAuthorityInfo(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]CertView, 0, len(resp.Info))
	for _, c := range resp.Info {
		out = append(out, CertView{
			CN: c.CN, Type: c.Type, KeyAlgorithm: c.KeyAlgorithm,
			ValidStart: c.ValidityStart, ValidExpiry: c.ValidityExpiry,
			Created: c.CreationTime, ID: c.ID,
		})
	}
	return out, nil
}

// ─── Threat-monitoring (VirusTotal etc.) ────────────────────────────────────

// MonitorProviderView is one configured monitoring provider.
type MonitorProviderView struct {
	ID   string `json:"id"`
	Type string `json:"type"`
}

// StartMonitor starts the teamserver's implant/threat monitor loop.
func (a *App) StartMonitor() error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("monitor-start", "", "")
	resp, err := client.RPC.MonitorStart(a.ctx, &commonpb.Empty{})
	if err != nil {
		return err
	}
	if resp != nil && resp.Err != "" {
		return fmt.Errorf("%s", resp.Err)
	}
	return nil
}

// StopMonitor stops the monitor loop.
func (a *App) StopMonitor() error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("monitor-stop", "", "")
	_, err = client.RPC.MonitorStop(a.ctx, &commonpb.Empty{})
	return err
}

// ListMonitorConfig lists configured monitoring providers.
func (a *App) ListMonitorConfig() ([]MonitorProviderView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.MonitorListConfig(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]MonitorProviderView, 0, len(resp.Providers))
	for _, p := range resp.Providers {
		out = append(out, MonitorProviderView{ID: p.ID, Type: p.Type})
	}
	return out, nil
}

// ─── WASM extensions ────────────────────────────────────────────────────────

// ListWasmExtensions lists registered WASM extensions for a session.
func (a *App) ListWasmExtensions(sessionID string) ([]string, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.ListWasmExtensions(a.ctx, &sliverpb.ListWasmExtensionsReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	return resp.Names, nil
}

// ─── HTTP C2 profile viewer ─────────────────────────────────────────────────

// GetHTTPC2Profile returns a full HTTP C2 profile as pretty JSON (read-only).
func (a *App) GetHTTPC2Profile(name string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.GetHTTPC2ProfileByName(a.ctx, &clientpb.C2ProfileReq{Name: name})
	if err != nil {
		return "", err
	}
	b, err := protojson.MarshalOptions{Multiline: true, Indent: "  "}.Marshal(resp)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// SaveHTTPC2Profile validates an edited HTTP C2 profile (protojson) and saves it
// back to the teamserver. overwrite=true updates an existing profile; false
// creates a new one (and fails if the name already exists).
func (a *App) SaveHTTPC2Profile(profileJSON string, overwrite bool) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	var cfg clientpb.HTTPC2Config
	if uerr := protojson.Unmarshal([]byte(profileJSON), &cfg); uerr != nil {
		return fmt.Errorf("invalid profile JSON: %w", uerr)
	}
	if strings.TrimSpace(cfg.Name) == "" {
		return fmt.Errorf("profile must have a \"name\"")
	}
	a.audit.log("c2profile-save", cfg.Name, fmt.Sprintf("overwrite=%v", overwrite))
	_, err = client.RPC.SaveHTTPC2Profile(a.ctx, &clientpb.HTTPC2ConfigReq{
		Overwrite: overwrite,
		C2Config:  &cfg,
	})
	return err
}

// ─── Website content management ─────────────────────────────────────────────

// AddWebsiteContent uploads a local file to a hosted website at the given path.
func (a *App) AddWebsiteContent(website, webPath, localFile string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(localFile)
	if err != nil {
		return err
	}
	ctype := http.DetectContentType(data)
	if webPath == "" {
		webPath = "/" + filepath.Base(localFile)
	}
	a.audit.log("website-add", website, webPath+" <- "+localFile)
	_, err = client.RPC.WebsiteAddContent(a.ctx, &clientpb.WebsiteAddContent{
		Name: website,
		Contents: map[string]*clientpb.WebContent{
			webPath: {Path: webPath, ContentType: ctype, Content: data, Size: uint64(len(data))},
		},
	})
	return err
}

// RemoveWebsiteContent removes a path from a hosted website.
func (a *App) RemoveWebsiteContent(website, webPath string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("website-rm", website, webPath)
	_, err = client.RPC.WebsiteRemoveContent(a.ctx, &clientpb.WebsiteRemoveContent{
		Name:  website,
		Paths: []string{webPath},
	})
	return err
}

// ─── Session / beacon lifecycle ─────────────────────────────────────────────

// CloseSessionGraceful asks the implant to close the session cleanly (vs. Kill).
func (a *App) CloseSessionGraceful(sessionID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("close-session", sessionID, "")
	_, err = client.RPC.CloseSession(a.ctx, &sliverpb.CloseSession{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// CancelBeaconTask cancels a queued (not-yet-sent) beacon task.
func (a *App) CancelBeaconTask(taskID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("cancel-task", taskID, "")
	_, err = client.RPC.CancelBeaconTask(a.ctx, &clientpb.BeaconTask{ID: taskID})
	return err
}

// ─── Credentials enrichment ─────────────────────────────────────────────────

// UpdateCredential updates a stored credential (e.g. add a cracked plaintext).
func (a *App) UpdateCredential(id, username, plaintext, hash string, cracked bool) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("cred-update", id, username)
	_, err = client.RPC.CredsUpdate(a.ctx, &clientpb.Credentials{
		Credentials: []*clientpb.Credential{{
			ID: id, Username: username, Plaintext: plaintext, Hash: hash, IsCracked: cracked,
		}},
	})
	return err
}

// SniffCredHashType asks the teamserver to identify a hash's type (hashcat mode).
func (a *App) SniffCredHashType(hash string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.CredsSniffHashType(a.ctx, &clientpb.Credential{Hash: hash})
	if err != nil {
		return "", err
	}
	return resp.HashType.String(), nil
}

// GetCredential fetches a single credential by ID.
func (a *App) GetCredential(id string) (CredView, error) {
	client, err := a.requireClient()
	if err != nil {
		return CredView{}, err
	}
	c, err := client.RPC.GetCredByID(a.ctx, &clientpb.Credential{ID: id})
	if err != nil {
		return CredView{}, err
	}
	return CredView{ID: c.ID, Username: c.Username, Plain: c.Plaintext, Hash: c.Hash, Cracked: c.IsCracked}, nil
}

// ─── Session ping ───────────────────────────────────────────────────────────

// PingSession measures a round-trip to the implant (liveness check).
func (a *App) PingSession(sessionID string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	_, err = client.RPC.Ping(a.ctx, &sliverpb.Ping{
		Nonce:   int32(len(sessionID)),
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ─── Host database ──────────────────────────────────────────────────────────

// RemoveHostIOC removes an indicator-of-compromise entry from a host record.
func (a *App) RemoveHostIOC(iocID, path, fileHash string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("host-ioc-rm", iocID, path)
	_, err = client.RPC.HostIOCRm(a.ctx, &clientpb.IOC{ID: iocID, Path: path, FileHash: fileHash})
	return err
}

// ─── Loot ───────────────────────────────────────────────────────────────────

// RenameLoot changes a loot item's display name.
func (a *App) RenameLoot(id, name string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("loot-rename", id, name)
	_, err = client.RPC.LootUpdate(a.ctx, &clientpb.Loot{ID: id, Name: name})
	return err
}

// ─── Website content update ─────────────────────────────────────────────────

// UpdateWebsiteContent replaces the file served at a website path.
func (a *App) UpdateWebsiteContent(website, webPath, localFile string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(localFile)
	if err != nil {
		return err
	}
	if webPath == "" {
		webPath = "/" + filepath.Base(localFile)
	}
	a.audit.log("website-update", website, webPath)
	_, err = client.RPC.WebsiteUpdateContent(a.ctx, &clientpb.WebsiteAddContent{
		Name: website,
		Contents: map[string]*clientpb.WebContent{
			webPath: {Path: webPath, ContentType: http.DetectContentType(data), Content: data, Size: uint64(len(data))},
		},
	})
	return err
}

// ─── WireGuard tunnel status ────────────────────────────────────────────────

// WGForwarderView is one active WireGuard TCP forwarder.
type WGForwarderView struct {
	ID         int32  `json:"id"`
	LocalAddr  string `json:"localAddr"`
	RemoteAddr string `json:"remoteAddr"`
}

// ListWGForwarders lists active WireGuard TCP forwarders on a session.
func (a *App) ListWGForwarders(sessionID string) ([]WGForwarderView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.WGListForwarders(a.ctx, &sliverpb.WGTCPForwardersReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]WGForwarderView, 0, len(resp.Forwarders))
	for _, f := range resp.Forwarders {
		out = append(out, WGForwarderView{ID: f.ID, LocalAddr: f.LocalAddr, RemoteAddr: f.RemoteAddr})
	}
	return out, nil
}

// WGSocksView is one active WireGuard SOCKS server.
type WGSocksView struct {
	ID        int32  `json:"id"`
	LocalAddr string `json:"localAddr"`
}

// ListWGSocks lists active WireGuard SOCKS servers on a session.
func (a *App) ListWGSocks(sessionID string) ([]WGSocksView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.WGListSocksServers(a.ctx, &sliverpb.WGSocksServersReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return nil, err
	}
	out := make([]WGSocksView, 0, len(resp.Servers))
	for _, s := range resp.Servers {
		out = append(out, WGSocksView{ID: s.ID, LocalAddr: s.LocalAddr})
	}
	return out, nil
}

// ─── Monitoring provider config ─────────────────────────────────────────────

// AddMonitorConfig registers a threat-monitoring provider (e.g. VirusTotal).
func (a *App) AddMonitorConfig(providerType, apiKey, apiPassword string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("monitor-add", providerType, "")
	resp, err := client.RPC.MonitorAddConfig(a.ctx, &clientpb.MonitoringProvider{
		Type: providerType, APIKey: apiKey, APIPassword: apiPassword,
	})
	if err != nil {
		return err
	}
	if resp != nil && resp.Err != "" {
		return fmt.Errorf("%s", resp.Err)
	}
	return nil
}

// DelMonitorConfig removes a monitoring provider by ID.
func (a *App) DelMonitorConfig(id string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.audit.log("monitor-del", id, "")
	_, err = client.RPC.MonitorDelConfig(a.ctx, &clientpb.MonitoringProvider{ID: id})
	return err
}

// ─── WireGuard generation helpers ───────────────────────────────────────────

// WGClientConfigView is a generated WireGuard client config.
type WGClientConfigView struct {
	ServerPubKey     string `json:"serverPubKey"`
	ClientPrivateKey string `json:"clientPrivateKey"`
	ClientPubKey     string `json:"clientPubKey"`
	ClientIP         string `json:"clientIP"`
}

// GenerateWGClientConfig generates a new WireGuard client key/IP set.
func (a *App) GenerateWGClientConfig() (WGClientConfigView, error) {
	client, err := a.requireClient()
	if err != nil {
		return WGClientConfigView{}, err
	}
	resp, err := client.RPC.GenerateWGClientConfig(a.ctx, &commonpb.Empty{})
	if err != nil {
		return WGClientConfigView{}, err
	}
	return WGClientConfigView{
		ServerPubKey:     resp.ServerPubKey,
		ClientPrivateKey: resp.ClientPrivateKey,
		ClientPubKey:     resp.ClientPubKey,
		ClientIP:         resp.ClientIP,
	}, nil
}

// GenerateUniqueWGIP returns a fresh unique WireGuard peer IP.
func (a *App) GenerateUniqueWGIP() (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.GenerateUniqueIP(a.ctx, &commonpb.Empty{})
	if err != nil {
		return "", err
	}
	return resp.IP, nil
}

// ─── Pivot graph ────────────────────────────────────────────────────────────

// PivotNodeView is a node in the pivot graph (peer topology).
type PivotNodeView struct {
	PeerID    int64           `json:"peerId"`
	SessionID string          `json:"sessionId"`
	Name      string          `json:"name"`
	Hostname  string          `json:"hostname"`
	Children  []PivotNodeView `json:"children"`
}

func pivotNode(e *clientpb.PivotGraphEntry) PivotNodeView {
	n := PivotNodeView{PeerID: e.PeerID, Name: e.Name}
	if e.Session != nil {
		n.Hostname = e.Session.Hostname
		n.SessionID = e.Session.ID
	}
	for _, c := range e.Children {
		n.Children = append(n.Children, pivotNode(c))
	}
	return n
}

// GetPivotGraph returns the current pivot (peer-to-peer) topology.
func (a *App) GetPivotGraph() ([]PivotNodeView, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.RPC.PivotGraph(a.ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	out := make([]PivotNodeView, 0, len(resp.Children))
	for _, e := range resp.Children {
		out = append(out, pivotNode(e))
	}
	return out, nil
}

// ─── Execute (Windows, advanced) ────────────────────────────────────────────

// ExecuteWindowsAdvanced runs a program on a Windows target with token/PPID/
// hide-window options (Sliver `execute` extended flags).
func (a *App) ExecuteWindowsAdvanced(sessionID, path string, args []string, useToken, hideWindow bool, ppid int) ExecResult {
	client, err := a.requireClient()
	if err != nil {
		return ExecResult{Error: err.Error()}
	}
	a.audit.log("execute-windows", sessionID, path+" "+strings.Join(args, " "))
	resp, err := client.RPC.ExecuteWindows(a.ctx, &sliverpb.ExecuteWindowsReq{
		Path:       path,
		Args:       args,
		Output:     true,
		UseToken:   useToken,
		HideWindow: hideWindow,
		PPid:       uint32(ppid),
		Request:    &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ExecResult{Error: err.Error()}
	}
	return ExecResult{Stdout: string(resp.Stdout), Stderr: string(resp.Stderr), Status: resp.Status}
}

// ─── Shellcode utilities (server-side transforms) ───────────────────────────

// ConvertDLLToShellcode turns a local DLL into position-independent shellcode
// (sRDI) and saves the result via a dialog.
func (a *App) ConvertDLLToShellcode(dllPath, functionName, args string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(dllPath)
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.ShellcodeRDI(a.ctx, &clientpb.ShellcodeRDIReq{
		Data:         data,
		FunctionName: functionName,
		Arguments:    args,
	})
	if err != nil {
		return "", err
	}
	savePath, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: strings.TrimSuffix(filepath.Base(dllPath), filepath.Ext(dllPath)) + ".bin",
		Title:           "Save shellcode",
	})
	if err != nil || savePath == "" {
		return "", fmt.Errorf("save cancelled")
	}
	if werr := os.WriteFile(savePath, resp.Data, 0600); werr != nil {
		return "", werr
	}
	a.audit.log("shellcode-rdi", dllPath, savePath)
	return savePath, nil
}

// EncodeShellcode runs a local shellcode file through the shikata-ga-nai encoder
// and saves the encoded result.
func (a *App) EncodeShellcode(inPath, architecture string, iterations int) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(inPath)
	if err != nil {
		return "", err
	}
	if architecture == "" {
		architecture = "amd64"
	}
	if iterations <= 0 {
		iterations = 1
	}
	resp, err := client.RPC.ShellcodeEncoder(a.ctx, &clientpb.ShellcodeEncodeReq{
		Encoder:      clientpb.ShellcodeEncoder_SHIKATA_GA_NAI,
		Architecture: architecture,
		Iterations:   uint32(iterations),
		Data:         data,
	})
	if err != nil {
		return "", err
	}
	savePath, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: strings.TrimSuffix(filepath.Base(inPath), filepath.Ext(inPath)) + ".enc.bin",
		Title:           "Save encoded shellcode",
	})
	if err != nil || savePath == "" {
		return "", fmt.Errorf("save cancelled")
	}
	if werr := os.WriteFile(savePath, resp.Data, 0600); werr != nil {
		return "", werr
	}
	a.audit.log("shellcode-encode", inPath, savePath)
	return savePath, nil
}

// RegisterWasmExtension uploads and registers a local .wasm module on a session.
func (a *App) RegisterWasmExtension(sessionID, name, wasmPath string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(wasmPath)
	if err != nil {
		return err
	}
	var gzbuf bytes.Buffer
	zw := gzip.NewWriter(&gzbuf)
	if _, werr := zw.Write(raw); werr != nil {
		return werr
	}
	zw.Close()
	if name == "" {
		name = strings.TrimSuffix(filepath.Base(wasmPath), ".wasm")
	}
	a.audit.log("wasm-register", sessionID, name)
	_, err = client.RPC.RegisterWasmExtension(a.ctx, &sliverpb.RegisterWasmExtensionReq{
		Name:    name,
		WasmGz:  gzbuf.Bytes(),
		Request: &commonpb.Request{SessionID: sessionID},
	})
	return err
}

// ExecWasmExtension runs a registered WASM extension (non-interactive).
func (a *App) ExecWasmExtension(sessionID, name string, args []string) ExecResult {
	client, err := a.requireClient()
	if err != nil {
		return ExecResult{Error: err.Error()}
	}
	a.audit.log("wasm-exec", sessionID, name+" "+strings.Join(args, " "))
	resp, err := client.RPC.ExecWasmExtension(a.ctx, &sliverpb.ExecWasmExtensionReq{
		Name:    name,
		Args:    args,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ExecResult{Error: err.Error()}
	}
	return ExecResult{Stdout: string(resp.Stdout), Stderr: string(resp.Stderr), Status: resp.ExitCode}
}
