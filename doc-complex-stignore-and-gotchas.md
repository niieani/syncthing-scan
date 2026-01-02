Complex .stignore Allowlist Patterns and Gotchas

Purpose
This document explains how to build a robust allowlist-style .stignore setup
and highlights the gotchas that affect correctness and performance. It uses
the home folder setup as a concrete example.

Background: How Syncthing Matches Patterns
Syncthing reads .stignore files line by line (including #include files). It
expands patterns and applies the first match in order. This has two important
effects:

1) Order matters more than specificity.
   - The first matching pattern wins. Later patterns do not override.
2) “Skip directory traversal” is limited.
   - Syncthing can skip descending into ignored directories only when it can
     prove that no later pattern can unignore anything inside.
   - Once a single unignore pattern (!) is encountered, many subsequent ignore
     patterns will still ignore files but will NOT skip traversal for ignored
     directories. This is a common performance pitfall in allowlists.

Important Gotchas

1) Allowlist lines (“!”) disable skip-dir optimization
After the first “!” in the ignore file (including included files), Syncthing
assumes any ignored directory might contain an unignored child. That means:
- Ignored directories can still be traversed.
- You lose the big performance benefit of early skip.

Implication: Put all “perf-only” ignores BEFORE any allowlist entries.

2) Trailing slash patterns are not enough to skip at the directory root
Example:
  /.cursor/
This is expanded into a pattern that matches contents, not necessarily the
directory itself, so traversal might still enter the directory.

Better:
  /.cursor
  /.cursor/**

This allows the directory itself to be ignored and skipped.

3) Allowlisting a directory does not require "/**"
Syncthing expands many patterns automatically. In practice:
  !/folder
is sufficient to allow the directory and its contents for scanning, and
  !/folder/file
is sufficient to allow a single file. You do not need a matching "!/folder/**"
for allowlisting. Adding "/**" is redundant and makes ignore files noisier.

If you want partial allowlisting (e.g. only a few subfolders under .config),
do NOT allowlist the .config root. Instead, list only the subpaths you want:
  !/.config/atuin
  !/.config/git
  !/.config/zed
  !/.config/starship.toml

4) Use "/folder" vs "/folder/" intentionally
For performance-focused ignores (skip traversal), use:
  /folder
This tells Syncthing it can skip the directory entirely.

For ignores where traversal should still happen (e.g., you need to reach a
later unignore), use:
  /folder/
This ignores the directory entry but keeps traversal possible.

5) The default “exclude everything” pattern expands
An allowlist setup often ends with:
  /*
This does not just match top-level entries. Syncthing expands it so it also
matches deeper paths. That’s fine, but it means you cannot rely on trailing
“/*” to exclude subtrees after you have already allowed something.

6) Included files are processed in-place
If .stignore contains:
  #include .stperfignore
  #include .stallowlist
the contents of those files are read as if they appeared directly at that
point. The order of includes matters.

7) Pattern order affects “skip” vs “traverse”
Patterns that allow skipping are those that:
- Ignore (not “!”)
- Are rooted and do not include additional path segments after the root

Example of “skip-capable”:
  /Library
  /Music
  /Pictures
Example of “not skip-capable”:
  /Library/**

8) The pattern that causes ignore is not always what you think
When multiple patterns could match a path, the first match wins. This often
means a broad rule (e.g., “/*”) wins over a more specific rule that appears
later. Always order the most important behavior first.

9) Internal files are always ignored
.stignore, .stfolder, and .stversions are internal and ignored regardless of
your patterns. You do not need to add patterns for them.

10) Global ignores still apply inside unignored directories
Including a global ignore list (like .stglobalignore) means those patterns
apply everywhere unless a later “!” explicitly unignores them. Unignoring a
directory does not unignore files inside it by default. For example, a
.DS_Store inside an allowed directory is still ignored unless you add an
explicit “!.DS_Store” rule (not recommended).

Recommended Structure for Allowlist Setups

Use three files to keep logic clean and order explicit:

1) .stglobalignore
   Shared ignore patterns that apply to many folders. Keep this as a reusable
   template for other directories.

2) .stperfignore
   Only performance excludes (skip big trees). Must come before any “!”.

3) .stallowlist
   Allowlist (all “!” entries), plus targeted excludes after allowlist.

Example:

  # ~/.stignore
  #include .stglobalignore
  #include .stperfignore
  #include .stallowlist
  /*

Home Folder Example (Simplified)

.stperfignore
  // big trees to skip
  /Library
  /Music
  /Pictures
  /Downloads
  /Applications

  // heavy app data and tool caches
  /.docker
  /.logseq
  /.gradle
  /.m2
  /.pnpm-store

  // skip node_modules everywhere (dir entry + contents)
  /**/node_modules
  /**/node_modules/**

  // skip cursor editor data
  /.cursor

.stallowlist
  // root-level files
  !/Brewfile
  !/README.md
  !/.bashrc
  !/.gitconfig
  !/.zshrc

  // allow specific dot-directories (no /** needed)
  !/.agent-os
  !/.codegpt
  !/SwiftBar
  !/bin

  // allow partial .config content (no “!/.config”!)
  !/.config/atuin
  !/.config/git
  !/.config/zed
  !/.config/starship.toml

  // allow all SSH keys
  !/.ssh

Key Lessons From the Home Example
1) Putting “/.config” in the allowlist would have included everything in
   .config and broken the partial allowlist. Removing that fixed it.
2) “/.cursor/” was not sufficient to skip the root directory. Using both
   “/.cursor” and “/.cursor/**” enables skip at the directory root.
3) Allowlist and perf exclusions must be separated so that skip-dir ignores
   are processed before any “!” rules.

Debugging and Verification

Use stscantrace to validate:
  stscantrace --trace --include=all ~/ > ~/stscantrace-home.trace

Check that:
- Large excluded directories show “skip … canSkipDir=true”
- Allowed files show “include …”
- Only the intended .config subfolders appear in “include …”

If you need to know which pattern matched a specific ignore, stscantrace now
prints the exact pattern in both ignore and skip events.

Quick Checklist
- Put skip-dir excludes before any “!” allowlist entries.
- Don’t allowlist a directory root if you only want parts of it.
- Use both “/dir” and “/dir/**” to skip directory roots reliably.
- Keep .stglobalignore separate so it can be reused.
- Verify with stscantrace after changes.
