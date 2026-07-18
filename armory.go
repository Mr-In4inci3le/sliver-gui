package main

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ─── Armory — Extension Package Manager ──────────────────────────────────────
//
// The Sliver "Armory" is a client-side package manager for extensions and
// aliases. It fetches a JSON index from a GitHub-hosted repository listing
// available packages with their release download URLs, then extracts .tar.gz
// archives into ~/.sliver-client/extensions/ or ~/.sliver-client/aliases/.
//
// This implementation replicates the official sliver-client armory flow:
//   1. Fetch armory index (JSON array of packages from GitHub API)
//   2. Present available packages to the operator
//   3. Download the matching release asset (.tar.gz)
//   4. Extract to the correct local directory
//
// TODO: Add minisign signature verification for package integrity.
//       Currently skipped — packages are fetched over HTTPS from GitHub.

const (
	// Default armory index URL — the sliverarmory GitHub org's repos API
	defaultArmoryIndexURL = "https://api.github.com/orgs/sliverarmory/repos?per_page=100"
	// HTTP timeout for armory operations
	armoryHTTPTimeout = 30 * time.Second
)

// ArmoryPackage represents an installable extension/alias from the armory.
type ArmoryPackage struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	URL         string `json:"url"`
	Stars       int    `json:"stars"`
	Type        string `json:"type"` // "extension" or "alias"
	Installed   bool   `json:"installed"`
}

// armoryGitHubRepo is the subset of GitHub API repo response we need.
type armoryGitHubRepo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	HTMLURL     string `json:"html_url"`
	Stars       int    `json:"stargazers_count"`
	Archived    bool   `json:"archived"`
}

// armoryGitHubRelease is a GitHub release.
type armoryGitHubRelease struct {
	TagName string               `json:"tag_name"`
	Assets  []armoryGitHubAsset  `json:"assets"`
}

// armoryGitHubAsset is a release asset.
type armoryGitHubAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// ArmoryList fetches the armory index and returns available packages.
func (a *App) ArmoryList() ([]ArmoryPackage, error) {
	client := &http.Client{Timeout: armoryHTTPTimeout}

	// Fetch repos from the sliverarmory GitHub org
	req, err := http.NewRequest("GET", defaultArmoryIndexURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	req.Header.Set("User-Agent", "sliver-gui/1.0")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch armory index: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("armory index returned HTTP %d", resp.StatusCode)
	}

	var repos []armoryGitHubRepo
	if err := json.NewDecoder(resp.Body).Decode(&repos); err != nil {
		return nil, fmt.Errorf("parse armory index: %w", err)
	}

	// Get list of already-installed extensions
	installed := installedExtensionNames()

	packages := make([]ArmoryPackage, 0, len(repos))
	for _, r := range repos {
		if r.Archived {
			continue
		}
		// Skip non-extension repos (docs, templates, etc.)
		if r.Name == ".github" || r.Name == "armory" || strings.HasPrefix(r.Name, "template") {
			continue
		}
		pkg := ArmoryPackage{
			Name:        r.Name,
			Description: r.Description,
			URL:         r.HTMLURL,
			Stars:       r.Stars,
			Type:        "extension",
			Installed:   installed[r.Name],
		}
		// Heuristic: if name contains "alias" it's an alias package
		if strings.Contains(strings.ToLower(r.Name), "alias") {
			pkg.Type = "alias"
		}
		packages = append(packages, pkg)
	}
	return packages, nil
}

// ArmoryInstall downloads and installs a package by name from the armory.
func (a *App) ArmoryInstall(packageName string) error {
	if packageName == "" {
		return fmt.Errorf("package name is required")
	}

	client := &http.Client{Timeout: 120 * time.Second}

	// Step 1: Get the latest release for this package
	releaseURL := fmt.Sprintf("https://api.github.com/repos/sliverarmory/%s/releases/latest", packageName)
	req, err := http.NewRequest("GET", releaseURL, nil)
	if err != nil {
		return fmt.Errorf("create release request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	req.Header.Set("User-Agent", "sliver-gui/1.0")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("fetch release: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		return fmt.Errorf("package '%s' not found in armory (no releases)", packageName)
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("GitHub API returned HTTP %d for %s", resp.StatusCode, packageName)
	}

	var release armoryGitHubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return fmt.Errorf("parse release: %w", err)
	}

	// Step 2: Find the matching asset for current OS/arch
	assetURL := findMatchingAsset(release.Assets, runtime.GOOS, runtime.GOARCH)
	if assetURL == "" {
		// Fallback: try to find any .tar.gz asset
		for _, asset := range release.Assets {
			if strings.HasSuffix(asset.Name, ".tar.gz") {
				assetURL = asset.BrowserDownloadURL
				break
			}
		}
	}
	if assetURL == "" {
		return fmt.Errorf("no compatible asset found for %s/%s in %s release %s",
			runtime.GOOS, runtime.GOARCH, packageName, release.TagName)
	}

	// Step 3: Download the asset
	dlReq, err := http.NewRequest("GET", assetURL, nil)
	if err != nil {
		return fmt.Errorf("create download request: %w", err)
	}
	dlReq.Header.Set("User-Agent", "sliver-gui/1.0")

	dlResp, err := client.Do(dlReq)
	if err != nil {
		return fmt.Errorf("download asset: %w", err)
	}
	defer dlResp.Body.Close()

	if dlResp.StatusCode != 200 {
		return fmt.Errorf("asset download returned HTTP %d", dlResp.StatusCode)
	}

	// Step 4: Extract to the extensions directory
	extDir := armoryExtDir()
	installDir := filepath.Join(extDir, packageName)
	if err := os.MkdirAll(installDir, 0755); err != nil {
		return fmt.Errorf("create install dir: %w", err)
	}

	if err := extractTarGz(dlResp.Body, installDir); err != nil {
		// Clean up on failure
		os.RemoveAll(installDir)
		return fmt.Errorf("extract package: %w", err)
	}

	return nil
}

// ArmoryRemove uninstalls a package by deleting its directory.
func (a *App) ArmoryRemove(packageName string) error {
	if packageName == "" {
		return fmt.Errorf("package name is required")
	}
	installDir := filepath.Join(armoryExtDir(), packageName)
	if _, err := os.Stat(installDir); os.IsNotExist(err) {
		return fmt.Errorf("package '%s' is not installed", packageName)
	}
	return os.RemoveAll(installDir)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// armoryExtDir returns the path to ~/.sliver-client/extensions/
func armoryExtDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".sliver-client", "extensions")
}

// armoryAliasDir returns the path to ~/.sliver-client/aliases/
func armoryAliasDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".sliver-client", "aliases")
}

// installedExtensionNames returns a set of already-installed extension names.
func installedExtensionNames() map[string]bool {
	installed := make(map[string]bool)
	extDir := armoryExtDir()
	entries, err := os.ReadDir(extDir)
	if err != nil {
		return installed
	}
	for _, e := range entries {
		if e.IsDir() {
			installed[e.Name()] = true
		}
	}
	// Also check aliases
	aliasDir := armoryAliasDir()
	entries, err = os.ReadDir(aliasDir)
	if err != nil {
		return installed
	}
	for _, e := range entries {
		if e.IsDir() {
			installed[e.Name()] = true
		}
	}
	return installed
}

// findMatchingAsset picks the best release asset for the given OS/arch.
func findMatchingAsset(assets []armoryGitHubAsset, goos, goarch string) string {
	// Map Go os/arch names to common asset naming conventions
	osNames := map[string][]string{
		"linux":   {"linux"},
		"windows": {"windows", "win"},
		"darwin":  {"darwin", "macos", "osx"},
	}
	archNames := map[string][]string{
		"amd64": {"amd64", "x86_64", "x64"},
		"arm64": {"arm64", "aarch64"},
		"386":   {"386", "i386", "x86"},
	}

	osVariants := osNames[goos]
	archVariants := archNames[goarch]

	for _, asset := range assets {
		name := strings.ToLower(asset.Name)
		if !strings.HasSuffix(name, ".tar.gz") && !strings.HasSuffix(name, ".tgz") {
			continue
		}
		osMatch := false
		for _, osv := range osVariants {
			if strings.Contains(name, osv) {
				osMatch = true
				break
			}
		}
		archMatch := false
		for _, archv := range archVariants {
			if strings.Contains(name, archv) {
				archMatch = true
				break
			}
		}
		if osMatch && archMatch {
			return asset.BrowserDownloadURL
		}
	}
	return ""
}

// extractTarGz extracts a .tar.gz stream into destDir with zip-slip protection.
func extractTarGz(r io.Reader, destDir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("gzip reader: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("tar read: %w", err)
		}

		// Zip-slip protection: ensure the extracted path is within destDir
		target := filepath.Join(destDir, header.Name)
		if !strings.HasPrefix(filepath.Clean(target), filepath.Clean(destDir)+string(os.PathSeparator)) {
			return fmt.Errorf("zip-slip detected: %s", header.Name)
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0755); err != nil {
				return fmt.Errorf("mkdir %s: %w", target, err)
			}
		case tar.TypeReg:
			// Ensure parent directory exists
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return fmt.Errorf("mkdir parent %s: %w", target, err)
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(header.Mode))
			if err != nil {
				return fmt.Errorf("create %s: %w", target, err)
			}
			// Limit extraction size to 100MB per file to prevent resource exhaustion
			limited := io.LimitReader(tr, 100*1024*1024)
			if _, err := io.Copy(f, limited); err != nil {
				f.Close()
				return fmt.Errorf("write %s: %w", target, err)
			}
			f.Close()
		}
	}
	return nil
}
