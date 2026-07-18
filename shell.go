package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"sync"

	"github.com/bishopfox/sliver/protobuf/commonpb"
	"github.com/bishopfox/sliver/protobuf/rpcpb"
	"github.com/bishopfox/sliver/protobuf/sliverpb"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// shell.go implements Sliver's interactive shell (`shell`) over a gRPC tunnel,
// streamed to the frontend via Wails events. This is the real-time, full-PTY
// experience (as opposed to the one-shot `shell <cmd>` exec the console also
// offers).
//
// Wiring:
//   backend -> frontend : runtime event "sliver:shell:<tunnelID>" with base64 bytes
//   backend -> frontend : runtime event "sliver:shell-closed:<tunnelID>"
//   frontend -> backend : SendShellData / ResizeShell / StopInteractiveShell

type shellHandle struct {
	tunnelID  uint64
	sessionID string
	stream    rpcpb.SliverRPC_TunnelDataClient
	cancel    context.CancelFunc
	seq       uint64
	mu        sync.Mutex
}

func (h *shellHandle) send(data []byte) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	err := h.stream.Send(&sliverpb.TunnelData{
		TunnelID: h.tunnelID,
		Data:     data,
		Sequence: h.seq,
	})
	if err == nil {
		h.seq++
	}
	return err
}

// StartInteractiveShell opens a PTY shell on the session and streams its output
// to the frontend. Returns the tunnel ID (as a string) used to route I/O.
func (a *App) StartInteractiveShell(sessionID, shellPath string, enablePTY bool) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithCancel(a.ctx)

	rpcTunnel, err := client.RPC.CreateTunnel(ctx, &sliverpb.Tunnel{SessionID: sessionID})
	if err != nil {
		cancel()
		return "", err
	}
	tunnelID := rpcTunnel.GetTunnelID()

	stream, err := client.RPC.TunnelData(ctx)
	if err != nil {
		cancel()
		return "", err
	}

	h := &shellHandle{tunnelID: tunnelID, sessionID: sessionID, stream: stream, cancel: cancel}

	// Bind the tunnel with an initial (empty) frame, then ask the implant to
	// start the shell attached to this tunnel.
	if err := h.send(nil); err != nil {
		cancel()
		return "", err
	}
	if _, err := client.RPC.Shell(ctx, &sliverpb.ShellReq{
		Path:      shellPath,
		EnablePTY: enablePTY,
		TunnelID:  tunnelID,
		Request:   &commonpb.Request{SessionID: sessionID},
	}); err != nil {
		cancel()
		return "", err
	}

	a.advMu.Lock()
	if a.shells == nil {
		a.shells = map[string]*shellHandle{}
	}
	a.shells[fmt.Sprintf("%d", tunnelID)] = h
	a.advMu.Unlock()

	a.audit.log("shell", sessionID, fmt.Sprintf("tunnel=%d pty=%v", tunnelID, enablePTY))

	// Pump implant output -> frontend.
	go func() {
		outEvent := fmt.Sprintf("sliver:shell:%d", tunnelID)
		closeEvent := fmt.Sprintf("sliver:shell-closed:%d", tunnelID)
		for {
			td, rerr := stream.Recv()
			if rerr != nil {
				runtime.EventsEmit(a.ctx, closeEvent)
				a.cleanupShell(fmt.Sprintf("%d", tunnelID))
				return
			}
			if len(td.Data) > 0 {
				runtime.EventsEmit(a.ctx, outEvent, base64.StdEncoding.EncodeToString(td.Data))
			}
			if td.Closed {
				runtime.EventsEmit(a.ctx, closeEvent)
				a.cleanupShell(fmt.Sprintf("%d", tunnelID))
				return
			}
		}
	}()

	return fmt.Sprintf("%d", tunnelID), nil
}

// SendShellData forwards operator keystrokes (base64-encoded) to the shell.
func (a *App) SendShellData(tunnelID, b64data string) error {
	a.advMu.Lock()
	h := a.shells[tunnelID]
	a.advMu.Unlock()
	if h == nil {
		return fmt.Errorf("shell %s not found", tunnelID)
	}
	data, err := base64.StdEncoding.DecodeString(b64data)
	if err != nil {
		return err
	}
	return h.send(data)
}

// ResizeShell notifies the implant of a new terminal size.
func (a *App) ResizeShell(tunnelID string, rows, cols int) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.advMu.Lock()
	h := a.shells[tunnelID]
	a.advMu.Unlock()
	if h == nil {
		return fmt.Errorf("shell %s not found", tunnelID)
	}
	_, err = client.RPC.ShellResize(a.ctx, &sliverpb.ShellResizeReq{
		TunnelID: h.tunnelID,
		Rows:     uint32(rows),
		Cols:     uint32(cols),
		Request:  &commonpb.Request{SessionID: h.sessionID},
	})
	return err
}

// StopInteractiveShell tears down a shell tunnel.
func (a *App) StopInteractiveShell(tunnelID string) error {
	a.advMu.Lock()
	h := a.shells[tunnelID]
	a.advMu.Unlock()
	if h == nil {
		return nil
	}
	if client, err := a.requireClient(); err == nil {
		_, _ = client.RPC.CloseTunnel(a.ctx, &sliverpb.Tunnel{TunnelID: h.tunnelID, SessionID: h.sessionID})
	}
	a.cleanupShell(tunnelID)
	return nil
}

func (a *App) cleanupShell(tunnelID string) {
	a.advMu.Lock()
	h := a.shells[tunnelID]
	delete(a.shells, tunnelID)
	a.advMu.Unlock()
	if h != nil {
		_ = h.stream.CloseSend()
		h.cancel()
	}
}
