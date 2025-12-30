StScan Analysis UI — Implementation Plan

Motivation and Context
Syncthing’s .stignore system is order-sensitive, and performance depends on
whether directories are skipped or fully traversed. The stscantrace CLI emits
JSONL trace events that make these decisions visible. This UI turns those raw
events into an interactive, fast, local-only analysis tool:
- understand why a path was included or excluded (pattern/reason)
- see which directories were skipped vs traversed
- explore the resulting file tree
- compare two traces (before/after rule changes)

Goals
- Fast, responsive UI for large trace files (100k+ events).
- Accurate representation of included/ignored/skipped decisions.
- Tree explorer with expand/collapse and persisted expansion state.
- Toggle to show included-only vs included+excluded (excluded dimmed).
- Detail panel with per-node metadata and matching pattern.
- Compare mode (side-by-side or merged statuses).

Non-Goals
- Editing ignore rules directly in the UI.
- Executing Syncthing or modifying any files.

Data Model (JSONL Trace Events)
The JSONL format is discriminated by the "event" field. We model it as a
discriminated union so parsing is type-safe and event-specific:

```ts
export type TraceEvent =
  | EnterEvent
  | SkipEvent
  | IncludeEvent
  | IgnoreEvent
  | TempEvent
  | NormalizeEvent
  | ErrorEvent
  | SummaryEvent;

export interface EnterEvent {
  event: "enter";
  path: string;
}

export interface SkipEvent {
  event: "skip";
  path: string;
  reason: string;
  pattern?: string;
  canSkipDir?: boolean;
}

export interface IncludeEvent {
  event: "include";
  path: string;
  kind: "file" | "dir" | "symlink";
}

export interface IgnoreEvent {
  event: "ignore";
  path: string;
  reason: string;
  pattern?: string;
  message?: string;
  canSkipDir?: boolean;
}

export interface TempEvent {
  event: "temp";
  path: string;
  tempExpired?: boolean;
}

export interface NormalizeEvent {
  event: "normalize";
  path: string;
  normalizedPath: string;
  autoNormalize?: boolean;
}

export interface ErrorEvent {
  event: "error";
  path: string;
  message: string;
}

export interface SummaryEvent {
  event: "summary";
  included: Array<{ Path: string; Kind?: string; Reason?: string }>;
  ignored: Array<{ Path: string; Kind?: string; Reason?: string }>;
}
```

Derived UI Data
We derive a tree from events for fast exploration and filtering:

```ts
export type NodeStatus = "included" | "ignored" | "skipped" | "unknown";

export interface NodeMeta {
  status: NodeStatus;
  reason?: string;
  pattern?: string;
  kind?: "file" | "dir" | "symlink";
  lastEvent?: TraceEvent["event"];
  // compare mode
  statusB?: NodeStatus;
  reasonB?: string;
  patternB?: string;
}

export interface TreeNode {
  id: string;            // stable, derived from path
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink";
  meta: NodeMeta;
  children?: Map<string, TreeNode>;
}

export interface TraceIndex {
  root: TreeNode;
  byPath: Map<string, TreeNode>;
  counts: { included: number; ignored: number; skipped: number };
}
```

Dependencies (preferred)
- @tanstack/virtual for tree virtualization
- @tanstack/react-table (optional for future tabular views)
- Optional: @tanstack/react-query for caching (not required)
- Tailwind for styling (already present)

Implementation Steps

1) File Drop and Parsing Pipeline
- Drag & drop + file picker
- Parse in a Web Worker to avoid blocking the UI
- Stream read and split JSONL into lines
- Parse each line into a TraceEvent and update the index

Notes:
- Ignore empty lines
- Handle parse errors with a concise error list
- Update progress as lines are parsed

2) Index Builder (worker)
- Maintain:
  - root TreeNode
  - byPath map (path -> node)
  - counts
- For each event:
  - ensure path nodes exist (create parents as dirs)
  - update node meta:
    - include -> status=included
    - ignore -> status=ignored (+ pattern/reason)
    - skip -> status=skipped (dir)
  - update counts
- Return final TraceIndex to UI

3) Tree Rendering (virtualized)
- Build a “visible node list” from expanded nodes only
- Use @tanstack/virtual to render just visible rows
- Default expansion: first level expanded
- Persist expansions in localStorage

4) Filters and Toggles
- Show Included only / Included + Excluded
- Excluded nodes rendered dimmed when visible
- Search box filters by path substring (case-insensitive)

5) Details Panel
- On node click, show:
  - path, kind, status
  - reason, pattern
  - last event
- For compare mode, show A vs B details side-by-side

6) Compare Mode
- Allow two JSONL files
- Build two TraceIndex trees
- Merge into a combined tree:
  - union of paths
  - meta.status/statusB fields
- Tree shows two markers (A/B) or split badges

7) State Persistence
- localStorage keys:
  - stscan.expanded
  - stscan.showExcluded
  - stscan.compareMode

Performance Considerations
- Parsing in worker
- Only build tree once
- Virtualized rendering
- Path map lookup for O(1) updates
- Chunk UI updates during parse for responsiveness

UI Outline
Top Bar:
- Drop zone / open file button
- Toggle: Included / Excluded / Both
- Compare mode toggle
- Search input
- Stats: included/ignored/skipped

Main:
- Left: Virtualized tree
- Right: Details panel

Future Enhancements
- Histogram of ignore patterns
- “Most skipped” directories list
- Export filtered tree to JSON
