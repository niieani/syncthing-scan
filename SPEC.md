STScanTrace Spec

Motivation
This tool exists to debug why a file or directory is included or excluded by Syncthing,
and to analyze scan performance. Syncthing’s scanning outcome depends on ignore rules,
folder configuration, and traversal behavior (not just the final match result). A key
performance difference is whether a subtree was traversed and filtered late, or skipped
early because the parent directory was ignored. This tool surfaces both the inclusion
decisions and the traversal decisions using Syncthing’s existing logic.

Goals
- Mirror Syncthing’s scanner and ignore behavior as closely as possible.
- Provide visibility into traversal decisions (enter, skip, include, ignore).
- Be safe to run outside Syncthing: no file mutation or deletion.
- Offer machine-readable output to support later visualization tooling.

Non-Goals
- Acting as a replacement scanner for Syncthing.
- Mutating folder state or database.
- Supporting custom ignore file locations (for now).

CLI Overview
Name: stscantrace
Location: cmd/dev/stscantrace

Usage
  stscantrace [flags] <path>

Required:
  <path>               Root folder to scan (required positional argument).

Flags
  --config <path>      Optional path to Syncthing config.xml. If not provided,
                       attempt auto-discovery via lib/locations. If not found,
                       run with defaults and warn.
  --folder-id <id>     Optional. Required only when multiple folders map to <path>.
  --include <mode>     Included list mode: "files" (default) or "all".
  --trace              Emit traversal decisions (enter/skip/include/ignore).
  --json               Emit JSON lines (events + final lists).
  --no-ignore-cache    Disable ignore matcher cache (default is enabled).

Behavior
Config Resolution
- If --config is provided, load that file.
- Otherwise, attempt to locate the config using lib/locations default paths.
- If config is not found, run in ad-hoc mode using Syncthing defaults and emit a warning.

Folder Selection
- The tool selects the folder configuration whose Path matches the provided <path>.
- If multiple folders match the same path, exit with an error and require --folder-id.
- If no matching folder exists (or config not found), run in ad-hoc mode using defaults.

Scanner Behavior (Mirrors Syncthing)
- Uses lib/scanner.Walk or WalkWithoutHashing based on folder type
  (receive-encrypted uses WalkWithoutHashing).
- Uses folder configuration flags: IgnorePerms, AutoNormalize, ModTimeWindow,
  SyncOwnership/SendOwnership, SyncXattrs/SendXattrs, XattrFilter, FilesystemType,
  CaseSensitiveFS, JunctionsAsDirs.
- Uses global config Options where relevant:
  - KeepTemporariesH for temp lifetime decisions (report-only, no deletion).
  - CacheIgnoredFiles (mapped to ignore cache, default enabled per requirement).
- Internal and temporary file handling mirrors lib/ignore and lib/scanner.

Safety Guarantees
- The tool must not delete or modify any files.
- When encountering temp files older than KeepTemporariesH, it reports
  "would delete temporary file" but does not remove them.
- When encountering non-normalized UTF-8 names and AutoNormalize is enabled,
  it reports "would normalize" but does not rename on disk.

Outputs
Included List
- Mode "files": includes only files that would be hashed/synced.
- Mode "all": includes files and directories that are not ignored.

Trace Events (only when --trace)
- Enter: directory traversal begins.
- Skip: traversal is pruned for a directory (reason + canSkipDir).
- Visit: file or directory examined.
- Include: file or directory included in final list.
- Ignore: item ignored (internal, temporary, pattern, error). When ignored by
  a pattern, the pattern string is included in trace and JSON output.
- WouldDeleteTemp: temporary file older than KeepTemporariesH (report-only).

JSON Output
- One JSON object per line.
- Events emitted as they occur during traversal.
- Final summary events emitted at end with included list.
- Schema includes:
  - event: string
  - path: string
  - kind: "file" | "dir"
  - reason: "pattern" | "internal" | "temporary" | "error" | "unignore"
  - pattern: string (when applicable)
  - canSkipDir: bool (when applicable)
  - folderID: string (when available)

Text Output (default)
- Prints included list and ignored list.
- If --trace, prints trace lines before summary.
- Warnings for ad-hoc mode or config mismatches are printed to stderr.

Exit Codes
- 0: success.
- 2: invalid usage or missing required argument.
- 3: multiple matching folders without --folder-id.
- 4: config load error when --config explicitly provided.

Implementation Sketch
1) Parse CLI flags and required path.
2) Resolve config:
   - if --config set -> load; on error exit code 4.
   - else try lib/locations.Get(ConfigFile); if readable load.
3) Determine folder config by path; if multiple matches -> exit 3.
4) Create filesystem and scanner.Config using folder config or defaults.
5) Create ignore matcher with cache (unless --no-ignore-cache).
6) Run scanner.Walk/WalkWithoutHashing.
7) Wrap walk callback to emit trace events and aggregate included list.
8) Output in text or JSON format.

References (source of truth)
Ignore parsing and matching:
- lib/ignore/ignore.go (Load, Parse, Match, parseIgnoreFile)
Scanner traversal and ignore application:
- lib/scanner/walk.go (walkAndHashFiles, Match usage, skip/ignore behavior)
Internal file handling:
- lib/fs/filesystem.go (IsInternal, internals list)
Temporary file identification:
- lib/fs/tempname.go (IsTemporary, temp prefixes)
Folder config and filesystem options:
- lib/config/folderconfiguration.go (FolderConfiguration, Filesystem)
Global options:
- lib/config/optionsconfiguration.go (KeepTemporariesH, CacheIgnoredFiles)
Config loading and default locations:
- lib/config/wrapper.go (Load)
- lib/locations/locations.go (ConfigFile path resolution)
