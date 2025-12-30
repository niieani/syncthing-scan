# StScan Analysis UI

Interactive UI for exploring Syncthing scan traces (`stscantrace --json --trace`).

This tool visualizes which files/folders were included or excluded, why they were
excluded (pattern/reason), and which directories were skipped vs traversed. It
supports comparing two traces to see the impact of ignore rule changes.

---

## Pipeline Overview

1) **Generate a trace** with the CLI tool:

```
stscantrace --json --trace --include=all /path/to/folder > stscantrace.jsonl
```

Notes:
- `--json` emits JSONL events (one event per line)
- `--trace` includes traversal events (`enter`, `skip`, `ignore`, `include`)
- `--include=all` ensures directories are emitted as nodes (useful for tree views)
- If you want to match Syncthing folder settings, ensure `stscantrace` can load
  your Syncthing config (or pass `--config` explicitly)

2) **Drop the JSONL file into the UI** to explore:
- Tree view with include/ignore status
- Cost of subtree (performance impact)
- Details panel (pattern, reason, counts)

3) **Optional compare mode**:
- Generate two traces (before/after)
- Drop both into the UI and compare results

---

## About `stscantrace`

`stscantrace` is a standalone CLI that mirrors Syncthing’s ignore/scanning logic.
It emits JSONL events describing traversal decisions:
- `include` / `ignore` / `skip` for paths
- `pattern` on ignores
- temp file handling and normalization notes

This UI consumes those JSONL events.

---

## Features

- **Drag & Drop JSONL** trace files
- **Tree explorer** with expand/collapse and persistent state
- **Toggle excluded items** (dimmed for quick visual scan)
- **Cost of subtree** badge (total or ignored count)
- **Details panel** with reason/pattern + subtree stats
- **Compare mode** for before/after analysis
- **Keyboard navigation**
  - Up/Down: selection
  - Right: expand / move into children
  - Left: collapse / move to parent

---

## Developer Setup

This project uses **Bun + React + Tailwind** (no Vite).

### Install dependencies
```
bun install
```

### Run the dev server
```
bun run dev
```

Open: http://localhost:3000/

---

## Building

```
bun run build
```

---

## Project Structure

```
src/
  App.tsx                UI entry + main state
  index.tsx              Bun server entry
  index.html             HTML entry
  index.css              Tailwind + custom styling
  types/trace.ts          Trace event types (discriminated union)
  workers/traceParser.ts  JSONL parser + index builder (Web Worker)
  lib/traceIndex.ts       Tree building, ordering, subtree stats
  hooks/useLocalStorageState.ts
docs/
  IMPLEMENTATION_PLAN.md
```

---

## Data Model Notes

The JSONL is a discriminated union on `event`. Each event contains a different
shape, for example:

```
{"event":"include","path":"src/main.go","kind":"file"}
{"event":"ignore","path":"node_modules","reason":"pattern","pattern":"**/node_modules"}
{"event":"skip","path":"node_modules","reason":"pattern","pattern":"**/node_modules","canSkipDir":true}
```

Parsed events are indexed into a tree. Ordering supports:
- **Scanning order** (folders first)
- **Cost of subtree**
- **Alphabetical**

Subtree cost metrics:
- **Total** items
- **Ignored** items (useful for performance)

---

## Compare Mode

Enable **Compare** and load two traces. The tree will merge both snapshots:
- Displays status for A and B
- Details panel shows A/B reasons and patterns

---

## Tips

- Use `--trace` and `--json` when generating traces.
- Use `--include=all` to capture directory nodes.
- Large traces: parsing happens in a Web Worker to keep UI responsive.

---

## License

Same license as the surrounding Syncthing workspace.
