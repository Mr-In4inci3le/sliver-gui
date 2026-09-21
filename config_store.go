package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"sliver-gui/internal/sliverclient"
)

// ─── Operator config store (issue #4) ────────────────────────────────────────
//
// The connect screen used to force the operator to re-select a .cfg on every
// launch because the selected path lived only in a JS variable. This store lets
// the GUI remember configs: it discovers configs from the official sliver-client
// directory (~/.sliver-client/configs) AND from an app-managed store
// (~/.sliver-gui/configs) that "Add config" copies into, so several teamservers
// can be kept and picked from a list.

// SavedConfig is a discovered operator .cfg the connect screen can list.
type SavedConfig struct {
	Name       string `json:"name"`       // operator name (fallback: file basename)
	Path       string `json:"path"`       // absolute path on disk
	Operator   string `json:"operator"`   // operator from the cfg
	Teamserver string `json:"teamserver"` // lhost:lport
	Managed    bool   `json:"managed"`    // true if in the app store (removable)
}

// guiConfigDir is the app-managed config store (~/.sliver-gui/configs).
func guiConfigDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".sliver-gui", "configs"), nil
}

// sliverClientConfigDir is where the official sliver-client stores operator
// configs (~/.sliver-client/configs).
func sliverClientConfigDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".sliver-client", "configs"), nil
}

// ListSavedConfigs returns every operator .cfg discovered in the app's own store
// and in the official sliver-client config dir, so the operator can pick a
// teamserver without re-selecting a file every launch (issue #4).
func (a *App) ListSavedConfigs() []SavedConfig {
	seen := map[string]bool{}
	out := []SavedConfig{}

	scan := func(dir string, managed bool) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return // dir may not exist; that's fine
		}
		for _, e := range entries {
			if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".cfg") {
				continue
			}
			path := filepath.Join(dir, e.Name())
			if seen[path] {
				continue
			}
			seen[path] = true
			sc := SavedConfig{
				Path:    path,
				Managed: managed,
				Name:    strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())),
			}
			if cfg, err := sliverclient.LoadConfig(path); err == nil {
				sc.Operator = cfg.Operator
				sc.Teamserver = fmt.Sprintf("%s:%d", cfg.LHost, cfg.LPort)
				if cfg.Operator != "" {
					sc.Name = cfg.Operator
				}
			}
			out = append(out, sc)
		}
	}

	if dir, err := guiConfigDir(); err == nil {
		scan(dir, true)
	}
	if dir, err := sliverClientConfigDir(); err == nil {
		scan(dir, false)
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

// ImportConfig validates a .cfg and copies it into the app-managed store so it
// persists and shows up in ListSavedConfigs. Returns the stored entry.
func (a *App) ImportConfig(srcPath string) (SavedConfig, error) {
	cfg, err := sliverclient.LoadConfig(srcPath)
	if err != nil {
		return SavedConfig{}, fmt.Errorf("invalid operator config: %w", err)
	}
	dir, err := guiConfigDir()
	if err != nil {
		return SavedConfig{}, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return SavedConfig{}, err
	}
	raw, err := os.ReadFile(srcPath)
	if err != nil {
		return SavedConfig{}, err
	}
	base := filepath.Base(srcPath)
	if !strings.EqualFold(filepath.Ext(base), ".cfg") {
		base += ".cfg"
	}
	dst := filepath.Join(dir, base)
	// Operator configs hold private keys + tokens — write 0600.
	if err := os.WriteFile(dst, raw, 0o600); err != nil {
		return SavedConfig{}, err
	}
	name := cfg.Operator
	if name == "" {
		name = strings.TrimSuffix(base, filepath.Ext(base))
	}
	return SavedConfig{
		Name:       name,
		Path:       dst,
		Operator:   cfg.Operator,
		Teamserver: fmt.Sprintf("%s:%d", cfg.LHost, cfg.LPort),
		Managed:    true,
	}, nil
}

// RemoveSavedConfig deletes a config from the app-managed store only. It refuses
// to touch anything outside ~/.sliver-gui/configs (never the official client's
// dir or arbitrary paths).
func (a *App) RemoveSavedConfig(path string) error {
	dir, err := guiConfigDir()
	if err != nil {
		return err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(dir, abs)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") || strings.ContainsRune(rel, filepath.Separator) {
		return fmt.Errorf("refusing to remove a config outside the app store")
	}
	return os.Remove(abs)
}
