package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	"github.com/syncthing/syncthing/lib/build"
	"github.com/syncthing/syncthing/lib/config"
	"github.com/syncthing/syncthing/lib/events"
	"github.com/syncthing/syncthing/lib/fs"
	"github.com/syncthing/syncthing/lib/ignore"
	"github.com/syncthing/syncthing/lib/locations"
	"github.com/syncthing/syncthing/lib/protocol"
)

const (
	exitUsage              = 2
	exitMultipleFolderPath = 3
	exitConfigLoad         = 4
)

type includeMode string

const (
	includeFiles includeMode = "files"
	includeAll   includeMode = "all"
)

type traceEvent struct {
	Event         string `json:"event"`
	Path          string `json:"path,omitempty"`
	Kind          string `json:"kind,omitempty"`
	Reason        string `json:"reason,omitempty"`
	Pattern       string `json:"pattern,omitempty"`
	Decision      string `json:"decision,omitempty"`
	CanSkipDir    *bool  `json:"canSkipDir,omitempty"`
	Normalized    string `json:"normalizedPath,omitempty"`
	FolderID      string `json:"folderID,omitempty"`
	Message       string `json:"message,omitempty"`
	TempExpired   *bool  `json:"tempExpired,omitempty"`
	AutoNormalize *bool  `json:"autoNormalize,omitempty"`
}

type itemEntry struct {
	Path   string
	Kind   string
	Reason string
}

type outputter struct {
	trace   bool
	json    bool
	writer  io.Writer
	encoder *json.Encoder
}

func newOutputter(w io.Writer, trace, jsonOut bool) *outputter {
	var enc *json.Encoder
	if jsonOut {
		enc = json.NewEncoder(w)
	}
	return &outputter{
		trace:   trace,
		json:    jsonOut,
		writer:  w,
		encoder: enc,
	}
}

func (o *outputter) emit(event traceEvent) {
	if !o.trace {
		return
	}
	if o.json {
		_ = o.encoder.Encode(event)
		return
	}
	fmt.Fprintln(o.writer, formatTrace(event))
}

func (o *outputter) emitSummary(included, ignored []itemEntry) {
	if o.json {
		_ = o.encoder.Encode(map[string]interface{}{
			"event":    "summary",
			"included": included,
			"ignored":  ignored,
		})
		return
	}
	printSummary(o.writer, included, ignored)
}

func formatTrace(e traceEvent) string {
	base := "TRACE"
	switch e.Event {
	case "enter":
		if e.Normalized != "" && e.Normalized != e.Path {
			return fmt.Sprintf("%s enter %s (normalized %s)", base, e.Path, e.Normalized)
		}
		return fmt.Sprintf("%s enter %s", base, e.Path)
	case "skip":
		if e.CanSkipDir != nil {
			if e.Pattern != "" {
				return fmt.Sprintf("%s skip %s (%s, pattern=%s, canSkipDir=%v)", base, e.Path, e.Reason, e.Pattern, *e.CanSkipDir)
			}
			return fmt.Sprintf("%s skip %s (%s, canSkipDir=%v)", base, e.Path, e.Reason, *e.CanSkipDir)
		}
		if e.Pattern != "" {
			return fmt.Sprintf("%s skip %s (%s, pattern=%s)", base, e.Path, e.Reason, e.Pattern)
		}
		return fmt.Sprintf("%s skip %s (%s)", base, e.Path, e.Reason)
	case "include":
		return fmt.Sprintf("%s include %s (%s)", base, e.Path, e.Kind)
	case "ignore":
		if e.Message != "" {
			return fmt.Sprintf("%s ignore %s (%s: %s)", base, e.Path, e.Reason, e.Message)
		}
		if e.Pattern != "" {
			return fmt.Sprintf("%s ignore %s (%s, pattern=%s)", base, e.Path, e.Reason, e.Pattern)
		}
		return fmt.Sprintf("%s ignore %s (%s)", base, e.Path, e.Reason)
	case "temp":
		if e.TempExpired != nil && *e.TempExpired {
			return fmt.Sprintf("%s temp %s (would delete)", base, e.Path)
		}
		return fmt.Sprintf("%s temp %s", base, e.Path)
	case "normalize":
		if e.AutoNormalize != nil && *e.AutoNormalize {
			return fmt.Sprintf("%s normalize %s -> %s (would rename)", base, e.Path, e.Normalized)
		}
		return fmt.Sprintf("%s normalize %s -> %s (autoNormalize disabled)", base, e.Path, e.Normalized)
	case "error":
		return fmt.Sprintf("%s error %s (%s)", base, e.Path, e.Message)
	default:
		return fmt.Sprintf("%s %s %s", base, e.Event, e.Path)
	}
}

func printSummary(w io.Writer, included, ignored []itemEntry) {
	fmt.Fprintf(w, "Included (%d)\n", len(included))
	for _, it := range included {
		fmt.Fprintf(w, "- %s\n", it.Path)
	}
	fmt.Fprintln(w)
	fmt.Fprintf(w, "Ignored (%d)\n", len(ignored))
	for _, it := range ignored {
		if it.Reason == "" {
			fmt.Fprintf(w, "- %s\n", it.Path)
			continue
		}
		fmt.Fprintf(w, "- %s (%s)\n", it.Path, it.Reason)
	}
}

type runConfig struct {
	folderID         string
	folderPath       string
	includeMode      includeMode
	trace            bool
	jsonOutput       bool
	autoNormalize    bool
	tempLifetime     time.Duration
	ignoreCache      bool
	ignorePerms      bool
	modTimeWindow    time.Duration
	scanOwnership    bool
	scanXattrs       bool
	xattrFilter      config.XattrFilter
	caseSensitiveFS  bool
	junctionsAsDirs  bool
	filesystemType   config.FilesystemType
	configWasLoaded  bool
	configFilePath   string
	adHocConfig      bool
	normalizedLookup map[string]string
}

func main() {
	var (
		cfgPath       string
		folderID      string
		include       string
		trace         bool
		jsonOut       bool
		noIgnoreCache bool
	)

	flag.StringVar(&cfgPath, "config", "", "path to config.xml (optional)")
	flag.StringVar(&folderID, "folder-id", "", "folder ID to use when multiple folders match the same path")
	flag.StringVar(&include, "include", string(includeFiles), "include list mode: files|all")
	flag.BoolVar(&trace, "trace", false, "emit traversal trace")
	flag.BoolVar(&jsonOut, "json", false, "emit JSON lines")
	flag.BoolVar(&noIgnoreCache, "no-ignore-cache", false, "disable ignore matcher cache")
	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "Usage: %s [flags] <path>\n", os.Args[0])
		flag.PrintDefaults()
	}
	flag.Parse()

	if flag.NArg() != 1 {
		flag.Usage()
		os.Exit(exitUsage)
	}

	inputPath := flag.Arg(0)
	mode := includeMode(include)
	if mode != includeFiles && mode != includeAll {
		fmt.Fprintf(os.Stderr, "invalid --include mode: %s\n", include)
		os.Exit(exitUsage)
	}

	cfgWrapper, cfg, cfgLoaded, err := loadConfig(cfgPath)
	if err != nil {
		if cfgPath != "" {
			fmt.Fprintf(os.Stderr, "failed to load config: %v\n", err)
			os.Exit(exitConfigLoad)
		}
		fmt.Fprintf(os.Stderr, "warning: failed to auto-load config: %v\n", err)
		cfgLoaded = false
	}

	folderCfg, usingConfig, err := selectFolderConfig(cfgLoaded, cfg, inputPath, folderID)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(exitMultipleFolderPath)
	}

	var runCfg runConfig
	if usingConfig {
		runCfg = buildRunConfigFromFolder(cfg, folderCfg, inputPath, mode, trace, jsonOut, noIgnoreCache)
	} else {
		runCfg = buildRunConfigAdHoc(inputPath, mode, trace, jsonOut, noIgnoreCache)
	}

	if usingConfig {
		runCfg.folderID = folderCfg.ID
		runCfg.filesystemType = folderCfg.FilesystemType
		runCfg.caseSensitiveFS = folderCfg.CaseSensitiveFS
		runCfg.junctionsAsDirs = folderCfg.JunctionsAsDirs
		runCfg.configWasLoaded = cfgLoaded
		runCfg.configFilePath = cfgWrapper.ConfigPath()
	} else {
		runCfg.adHocConfig = true
	}

	if runCfg.adHocConfig {
		fmt.Fprintln(os.Stderr, "warning: no matching config folder; using defaults (results may differ from Syncthing)")
	}

	ffs := runCfgFilesystem(folderCfg, runCfg)
	matcher := newIgnoreMatcher(ffs, runCfg.ignoreCache)
	if err := matcher.Load(".stignore"); err != nil && !fs.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "warning: failed to load .stignore: %v\n", err)
	}

	ctx := context.Background()
	out := newOutputter(os.Stdout, runCfg.trace, runCfg.jsonOutput)

	included, ignored, err := walkTrace(ctx, ffs, matcher, runCfg, out)
	if err != nil {
		fmt.Fprintf(os.Stderr, "scan failed: %v\n", err)
		os.Exit(1)
	}

	out.emitSummary(included, ignored)
}

func loadConfig(cfgPath string) (config.Wrapper, config.Configuration, bool, error) {
	if cfgPath != "" {
		wrapper, _, err := config.Load(cfgPath, protocol.EmptyDeviceID, events.NoopLogger)
		if err != nil {
			return nil, config.Configuration{}, false, err
		}
		return wrapper, wrapper.RawCopy(), true, nil
	}

	autoPath := locations.Get(locations.ConfigFile)
	if autoPath == "" {
		return nil, config.Configuration{}, false, nil
	}
	if _, err := os.Stat(autoPath); err != nil {
		return nil, config.Configuration{}, false, nil
	}
	wrapper, _, err := config.Load(autoPath, protocol.EmptyDeviceID, events.NoopLogger)
	if err != nil {
		return nil, config.Configuration{}, false, err
	}
	return wrapper, wrapper.RawCopy(), true, nil
}

func selectFolderConfig(cfgLoaded bool, cfg config.Configuration, inputPath, folderID string) (config.FolderConfiguration, bool, error) {
	if !cfgLoaded {
		return config.FolderConfiguration{}, false, nil
	}

	inPath, err := normalizeComparePath(inputPath)
	if err != nil {
		return config.FolderConfiguration{}, false, err
	}

	var matches []config.FolderConfiguration
	for _, folder := range cfg.Folders {
		folderPath, err := normalizeComparePath(folder.Path)
		if err != nil {
			continue
		}
		if folderPath == inPath {
			matches = append(matches, folder)
		}
	}

	if folderID != "" {
		for _, folder := range matches {
			if folder.ID == folderID {
				return folder, true, nil
			}
		}
		return config.FolderConfiguration{}, false, fmt.Errorf("folder ID %q not found for path %q", folderID, inputPath)
	}

	if len(matches) == 0 {
		return config.FolderConfiguration{}, false, nil
	}
	if len(matches) > 1 {
		return config.FolderConfiguration{}, false, fmt.Errorf("multiple folders match path %q; use --folder-id", inputPath)
	}
	return matches[0], true, nil
}

func normalizeComparePath(path string) (string, error) {
	expanded, err := fs.ExpandTilde(path)
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(expanded)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

func buildRunConfigFromFolder(cfg config.Configuration, folder config.FolderConfiguration, inputPath string, mode includeMode, trace, jsonOut, noIgnoreCache bool) runConfig {
	folderPath := folder.Path
	if folderPath == "" {
		folderPath = inputPath
	}
	return runConfig{
		folderID:         folder.ID,
		folderPath:       folderPath,
		includeMode:      mode,
		trace:            trace,
		jsonOutput:       jsonOut,
		autoNormalize:    folder.AutoNormalize,
		tempLifetime:     time.Duration(cfg.Options.KeepTemporariesH) * time.Hour,
		ignoreCache:      !noIgnoreCache,
		ignorePerms:      folder.IgnorePerms,
		modTimeWindow:    folder.ModTimeWindow(),
		scanOwnership:    folder.SendOwnership || folder.SyncOwnership,
		scanXattrs:       folder.SendXattrs || folder.SyncXattrs,
		xattrFilter:      folder.XattrFilter,
		filesystemType:   folder.FilesystemType,
		caseSensitiveFS:  folder.CaseSensitiveFS,
		junctionsAsDirs:  folder.JunctionsAsDirs,
		normalizedLookup: make(map[string]string),
	}
}

func buildRunConfigAdHoc(inputPath string, mode includeMode, trace, jsonOut, noIgnoreCache bool) runConfig {
	cfg := config.New(protocol.EmptyDeviceID)
	return runConfig{
		folderID:         "adhoc",
		folderPath:       inputPath,
		includeMode:      mode,
		trace:            trace,
		jsonOutput:       jsonOut,
		autoNormalize:    cfg.Defaults.Folder.AutoNormalize,
		tempLifetime:     time.Duration(cfg.Options.KeepTemporariesH) * time.Hour,
		ignoreCache:      !noIgnoreCache,
		ignorePerms:      cfg.Defaults.Folder.IgnorePerms,
		modTimeWindow:    cfg.Defaults.Folder.ModTimeWindow(),
		scanOwnership:    cfg.Defaults.Folder.SendOwnership || cfg.Defaults.Folder.SyncOwnership,
		scanXattrs:       cfg.Defaults.Folder.SendXattrs || cfg.Defaults.Folder.SyncXattrs,
		xattrFilter:      cfg.Defaults.Folder.XattrFilter,
		filesystemType:   cfg.Defaults.Folder.FilesystemType,
		caseSensitiveFS:  cfg.Defaults.Folder.CaseSensitiveFS,
		junctionsAsDirs:  cfg.Defaults.Folder.JunctionsAsDirs,
		normalizedLookup: make(map[string]string),
	}
}

func runCfgFilesystem(folder config.FolderConfiguration, rc runConfig) fs.Filesystem {
	if folder.Path == "" {
		folder = config.FolderConfiguration{
			Path:            rc.folderPath,
			FilesystemType:  rc.filesystemType,
			CaseSensitiveFS: rc.caseSensitiveFS,
			JunctionsAsDirs: rc.junctionsAsDirs,
		}
	}
	folder.Path = rc.folderPath
	return folder.Filesystem()
}

func newIgnoreMatcher(ffs fs.Filesystem, cache bool) *ignore.Matcher {
	if cache {
		return ignore.New(ffs, ignore.WithCache(true))
	}
	return ignore.New(ffs)
}

func walkTrace(ctx context.Context, ffs fs.Filesystem, matcher *ignore.Matcher, rc runConfig, out *outputter) ([]itemEntry, []itemEntry, error) {
	var included []itemEntry
	var ignored []itemEntry

	now := time.Now()
	ignoredParent := ""

	walkFn := func(path string, info fs.FileInfo, err error) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if path == "" {
			return nil
		}

		if info != nil && info.IsDir() {
			out.emit(traceEvent{Event: "enter", Path: path})
		}

		var skip error
		if info != nil && info.IsDir() {
			skip = fs.SkipDir
		}

		if !utf8.ValidString(path) {
			out.emit(traceEvent{Event: "error", Path: path, Message: "invalid UTF-8"})
			ignored = append(ignored, itemEntry{Path: path, Reason: "invalid-utf8"})
			return skip
		}

		if fs.IsTemporary(path) {
			expired := false
			if err == nil && info.IsRegular() && info.ModTime().Add(rc.tempLifetime).Before(now) {
				expired = true
			}
			out.emit(traceEvent{Event: "temp", Path: path, TempExpired: &expired})
			ignored = append(ignored, itemEntry{Path: path, Reason: "temporary"})
			return nil
		}

		if fs.IsInternal(path) {
			out.emit(traceEvent{Event: "ignore", Path: path, Reason: "internal"})
			ignored = append(ignored, itemEntry{Path: path, Reason: "internal"})
			return skip
		}

		nonNormPath := path
		normPath := normalizePath(path)
		if normPath != nonNormPath {
			rc.normalizedLookup[normPath] = nonNormPath
			auto := rc.autoNormalize
			out.emit(traceEvent{Event: "normalize", Path: nonNormPath, Normalized: normPath, AutoNormalize: &auto})
			if !rc.autoNormalize {
				ignored = append(ignored, itemEntry{Path: nonNormPath, Reason: "normalization-disabled"})
				return skip
			}
		}

		match, pat := matcher.MatchWithPattern(normPath)
		if match.IsIgnored() {
			canSkip := match.CanSkipDir()
			out.emit(traceEvent{
				Event:      "ignore",
				Path:       nonNormPath,
				Reason:     "pattern",
				Pattern:    pat,
				CanSkipDir: &canSkip,
			})
			ignored = append(ignored, itemEntry{Path: nonNormPath, Reason: formatPatternReason(pat)})
			if err != nil || match.CanSkipDir() || (info != nil && info.IsSymlink()) {
				if info != nil && info.IsDir() {
					out.emit(traceEvent{
						Event:      "skip",
						Path:       nonNormPath,
						Reason:     "pattern",
						Pattern:    pat,
						CanSkipDir: &canSkip,
					})
				}
				return skip
			}
			if info != nil && info.IsDir() && (ignoredParent == "" || !fs.IsParent(normPath, ignoredParent)) {
				ignoredParent = normPath
			}
			return nil
		}

		if err != nil {
			if !fs.IsNotExist(err) {
				out.emit(traceEvent{Event: "error", Path: nonNormPath, Message: err.Error()})
				ignored = append(ignored, itemEntry{Path: nonNormPath, Reason: "error"})
			}
			return skip
		}

		if path == "." {
			return nil
		}

		if ignoredParent == "" {
			handleInclude(path, info, rc, out, &included, &ignored)
			return nil
		}

		rel := strings.TrimPrefix(normPath, ignoredParent+string(fs.PathSeparator))
		if rel == normPath {
			ignoredParent = ""
			handleInclude(path, info, rc, out, &included, &ignored)
			return nil
		}

		for _, name := range append([]string{""}, fs.PathComponents(rel)...) {
			ignoredParent = filepath.Join(ignoredParent, name)
			actualPath := lookupActualPath(rc, ignoredParent)
			info, err = ffs.Lstat(actualPath)
			if err != nil {
				out.emit(traceEvent{Event: "error", Path: actualPath, Message: err.Error()})
				ignored = append(ignored, itemEntry{Path: actualPath, Reason: "error"})
				return skip
			}
			handleInclude(actualPath, info, rc, out, &included, &ignored)
		}
		ignoredParent = ""
		return nil
	}

	if err := ffs.Walk(".", walkFn); err != nil && !errors.Is(err, fs.SkipDir) {
		return included, ignored, err
	}
	return included, ignored, nil
}

func handleInclude(path string, info fs.FileInfo, rc runConfig, out *outputter, included *[]itemEntry, ignored *[]itemEntry) {
	switch {
	case info.IsSymlink():
		if build.IsWindows {
			out.emit(traceEvent{Event: "ignore", Path: path, Reason: "symlink-windows"})
			*ignored = append(*ignored, itemEntry{Path: path, Reason: "symlink-windows"})
			return
		}
		if rc.includeMode == includeAll || rc.includeMode == includeFiles {
			*included = append(*included, itemEntry{Path: path, Kind: "symlink"})
			out.emit(traceEvent{Event: "include", Path: path, Kind: "symlink"})
		}

	case info.IsDir():
		if rc.includeMode == includeAll {
			*included = append(*included, itemEntry{Path: path, Kind: "dir"})
			out.emit(traceEvent{Event: "include", Path: path, Kind: "dir"})
		}

	case info.IsRegular():
		*included = append(*included, itemEntry{Path: path, Kind: "file"})
		out.emit(traceEvent{Event: "include", Path: path, Kind: "file"})

	default:
		out.emit(traceEvent{Event: "ignore", Path: path, Reason: "unsupported"})
		*ignored = append(*ignored, itemEntry{Path: path, Reason: "unsupported"})
	}
}

func lookupActualPath(rc runConfig, normalized string) string {
	if actual, ok := rc.normalizedLookup[normalized]; ok {
		return actual
	}
	return normalized
}

func normalizePath(path string) string {
	if build.IsDarwin || build.IsIOS {
		return norm.NFD.String(path)
	}
	return norm.NFC.String(path)
}

func formatPatternReason(pattern string) string {
	if pattern == "" {
		return "pattern"
	}
	return "pattern: " + pattern
}
