package main

// Build metadata. These are overridden at build time via -ldflags, e.g.:
//
//	wails build -tags webkit2_41 -ldflags "\
//	  -X main.Version=$(git describe --tags --always) \
//	  -X main.GitCommit=$(git rev-parse --short HEAD) \
//	  -X main.BuildDate=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
//
// Left as sensible defaults for `go run` / untagged dev builds.
var (
	// Version is the semantic version of this GUI (e.g. "v1.0.0").
	Version = "dev"
	// GitCommit is the short commit hash the binary was built from.
	GitCommit = "unknown"
	// BuildDate is the UTC build timestamp (RFC3339).
	BuildDate = "unknown"
)

// BuildInfo is returned to the frontend for display in the About/title bar.
type BuildInfo struct {
	Version   string `json:"version"`
	GitCommit string `json:"gitCommit"`
	BuildDate string `json:"buildDate"`
}

// AppVersion exposes build metadata to the frontend (bound as
// window.go.main.App.AppVersion).
func (a *App) AppVersion() BuildInfo {
	return BuildInfo{Version: Version, GitCommit: GitCommit, BuildDate: BuildDate}
}
