import type { SerializedIndex, TraceEvent, TreeNode } from "../types/trace";

type ParseRequest =
  | { type: "parse"; file: File }
  | { type: "parse-compare"; fileA: File; fileB: File };

type ParseProgress = {
  type: "progress";
  fileLabel: "A" | "B";
  processed: number;
  total: number;
};

type ParseResult =
  | { type: "result"; index: SerializedIndex }
  | { type: "result-compare"; indexA: SerializedIndex; indexB: SerializedIndex };

type ParseError = { type: "error"; message: string };

const ROOT_ID = ".";

const post = (msg: ParseProgress | ParseResult | ParseError) => {
  self.postMessage(msg);
};

const toParentPath = (path: string) => {
  if (path === ROOT_ID) {
    return "";
  }
  const idx = path.lastIndexOf("/");
  if (idx === -1) {
    return ROOT_ID;
  }
  return path.slice(0, idx) || ROOT_ID;
};

const ensureNode = (nodes: Record<string, TreeNode>, path: string, kind: TreeNode["kind"] = "dir") => {
  if (nodes[path]) {
    if (kind === "dir" && nodes[path].kind !== "dir") {
      nodes[path].kind = "dir";
    }
    return nodes[path];
  }
  const name = path === ROOT_ID ? ROOT_ID : path.split("/").pop() || path;
  nodes[path] = {
    id: path,
    name,
    path,
    kind,
    meta: { status: "unknown" },
    children: [],
  };
  return nodes[path];
};

const linkParent = (nodes: Record<string, TreeNode>, childPath: string) => {
  const parentPath = toParentPath(childPath);
  if (!parentPath) {
    return;
  }
  const parent = ensureNode(nodes, parentPath, "dir");
  if (!parent.children) {
    parent.children = [];
  }
  if (!parent.children.includes(childPath)) {
    parent.children.push(childPath);
  }
};

const normalizePath = (raw: string | undefined) => {
  if (!raw || raw === "") {
    return ROOT_ID;
  }
  if (raw === ".") {
    return ROOT_ID;
  }
  return raw.replace(/^\.\//, "");
};

const updateMeta = (node: TreeNode, event: TraceEvent) => {
  node.meta.lastEvent = event.event;
  switch (event.event) {
    case "include":
      node.meta.status = "included";
      node.meta.kind = event.kind;
      node.meta.reason = undefined;
      node.meta.pattern = undefined;
      break;
    case "ignore":
      node.meta.status = "ignored";
      node.meta.reason = event.reason;
      node.meta.pattern = event.pattern;
      break;
    case "skip":
      node.meta.status = "skipped";
      node.meta.reason = event.reason;
      node.meta.pattern = event.pattern;
      break;
    case "temp":
      if (node.meta.status === "unknown") {
        node.meta.status = "ignored";
        node.meta.reason = "temporary";
      }
      break;
    case "error":
      node.meta.status = "ignored";
      node.meta.reason = "error";
      node.meta.pattern = undefined;
      break;
    case "enter":
      if (node.kind !== "dir") {
        node.kind = "dir";
      }
      break;
    default:
      break;
  }
};

const parseJSONL = async (file: File, fileLabel: "A" | "B"): Promise<SerializedIndex> => {
  const text = await file.text();
  const lines = text.split(/\r?\n/);

  const nodes: Record<string, TreeNode> = {};
  ensureNode(nodes, ROOT_ID, "dir");
  const counts = { included: 0, ignored: 0, skipped: 0 };

  const total = lines.length;
  for (let i = 0; i < total; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    let event: TraceEvent;
    try {
      event = JSON.parse(line);
    } catch (err) {
      post({ type: "error", message: `Failed to parse JSON on line ${i + 1}: ${(err as Error).message}` });
      continue;
    }
    if (event.event === "summary") {
      continue;
    }
    const path = normalizePath(event.path);
    if (!path) {
      continue;
    }
    const kind =
      event.event === "include"
        ? event.kind
        : event.event === "enter" || event.event === "skip"
        ? "dir"
        : "file";
    const node = ensureNode(nodes, path, kind);
    linkParent(nodes, path);
    updateMeta(node, event);

    if (event.event === "include") {
      counts.included += 1;
    } else if (event.event === "ignore" || event.event === "temp" || event.event === "error") {
      counts.ignored += 1;
    } else if (event.event === "skip") {
      counts.skipped += 1;
    }

    if (i % 5000 === 0) {
      post({ type: "progress", fileLabel, processed: i, total });
    }
  }

  return { rootId: ROOT_ID, nodes, counts };
};

self.onmessage = async (msg: MessageEvent<ParseRequest>) => {
  try {
    const payload = msg.data;
    if (payload.type === "parse") {
      const index = await parseJSONL(payload.file, "A");
      post({ type: "result", index });
      return;
    }
    if (payload.type === "parse-compare") {
      const indexA = await parseJSONL(payload.fileA, "A");
      const indexB = await parseJSONL(payload.fileB, "B");
      post({ type: "result-compare", indexA, indexB });
      return;
    }
  } catch (err) {
    post({ type: "error", message: (err as Error).message });
  }
};
