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

export type NodeStatus = "included" | "ignored" | "skipped" | "unknown";

export interface NodeMeta {
  status: NodeStatus;
  reason?: string;
  pattern?: string;
  kind?: "file" | "dir" | "symlink";
  lastEvent?: TraceEvent["event"];
  statusB?: NodeStatus;
  reasonB?: string;
  patternB?: string;
}

export interface TreeNode {
  id: string;
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink";
  meta: NodeMeta;
  children?: string[];
}

export interface SerializedIndex {
  rootId: string;
  nodes: Record<string, TreeNode>;
  counts: { included: number; ignored: number; skipped: number };
}

export interface TraceIndex {
  rootId: string;
  nodes: Map<string, TreeNode>;
  counts: { included: number; ignored: number; skipped: number };
}
