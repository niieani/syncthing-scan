import type { NodeMeta, NodeStatus, SerializedIndex, TraceIndex, TreeNode } from "../types/trace";

export type VisibleNode = {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  dimmed: boolean;
};

export const deserializeIndex = (serialized: SerializedIndex): TraceIndex => {
  const nodes = new Map<string, TreeNode>();
  for (const [key, node] of Object.entries(serialized.nodes)) {
    nodes.set(key, { ...node, children: node.children ? [...node.children] : [] });
  }
  return { rootId: serialized.rootId, nodes, counts: serialized.counts };
};

export const mergeIndexes = (a: TraceIndex, b: TraceIndex): TraceIndex => {
  const nodes = new Map<string, TreeNode>();
  const allKeys = new Set<string>([...a.nodes.keys(), ...b.nodes.keys()]);
  for (const key of allKeys) {
    const nodeA = a.nodes.get(key);
    const nodeB = b.nodes.get(key);
    const base = nodeA || nodeB;
    if (!base) {
      continue;
    }
    const meta: NodeMeta = {
      status: nodeA?.meta.status || "unknown",
      reason: nodeA?.meta.reason,
      pattern: nodeA?.meta.pattern,
      kind: base.kind,
      lastEvent: nodeA?.meta.lastEvent,
      statusB: nodeB?.meta.status || "unknown",
      reasonB: nodeB?.meta.reason,
      patternB: nodeB?.meta.pattern,
    };
    nodes.set(key, {
      ...base,
      meta,
      children: base.children ? [...base.children] : [],
    });
  }
  return {
    rootId: a.rootId,
    nodes,
    counts: {
      included: a.counts.included + b.counts.included,
      ignored: a.counts.ignored + b.counts.ignored,
      skipped: a.counts.skipped + b.counts.skipped,
    },
  };
};

const hasVisibleStatus = (status: NodeStatus) => status === "included";

export type SubtreeStats = {
  totalNodes: number;
  totalFiles: number;
  totalDirs: number;
  ignored: number;
  skipped: number;
};

export const computeSubtreeStats = (index: TraceIndex) => {
  const memo = new Map<string, SubtreeStats>();

  const isDir = (node: TreeNode) => node.kind === "dir" || (node.children?.length ?? 0) > 0;

  const walk = (node: TreeNode): SubtreeStats => {
    const cached = memo.get(node.id);
    if (cached) {
      return cached;
    }
    let totalNodes = 1;
    let totalFiles = isDir(node) ? 0 : 1;
    let totalDirs = isDir(node) ? 1 : 0;
    let ignored = node.meta.status === "ignored" ? 1 : 0;
    let skipped = node.meta.status === "skipped" ? 1 : 0;

    for (const childId of node.children ?? []) {
      const child = index.nodes.get(childId);
      if (!child) {
        continue;
      }
      const stats = walk(child);
      totalNodes += stats.totalNodes;
      totalFiles += stats.totalFiles;
      totalDirs += stats.totalDirs;
      ignored += stats.ignored;
      skipped += stats.skipped;
    }

    const result = { totalNodes, totalFiles, totalDirs, ignored, skipped };
    memo.set(node.id, result);
    return result;
  };

  for (const node of index.nodes.values()) {
    walk(node);
  }

  return memo;
};

export const buildVisibleList = (
  index: TraceIndex,
  expanded: Set<string>,
  showExcluded: boolean,
  search: string,
  orderBy: "scan" | "alpha" | "cost",
  stats: Map<string, SubtreeStats>,
  costMetric: "total" | "ignored",
): VisibleNode[] => {
  const root = index.nodes.get(index.rootId);
  if (!root) {
    return [];
  }

  const query = search.trim().toLowerCase();
  const visible: VisibleNode[] = [];

  const shouldIncludeNode = (node: TreeNode): boolean => {
    if (showExcluded) {
      return true;
    }
    return hasVisibleStatus(node.meta.status) || (node.meta.statusB ? hasVisibleStatus(node.meta.statusB) : false);
  };

  const matchesSearch = (node: TreeNode): boolean => {
    if (!query) {
      return true;
    }
    return node.path.toLowerCase().includes(query);
  };

  const visibilityCache = new Map<string, boolean>();
  const computeVisible = (node: TreeNode): boolean => {
    const cached = visibilityCache.get(node.id);
    if (cached !== undefined) {
      return cached;
    }
    const children = node.children ?? [];
    const searchMatch = matchesSearch(node);
    let childVisible = false;
    for (const childId of children) {
      const child = index.nodes.get(childId);
      if (!child) {
        continue;
      }
      if (computeVisible(child)) {
        childVisible = true;
      }
    }
    const includeSelf = shouldIncludeNode(node);
    const shouldRender = query ? searchMatch || childVisible : includeSelf || childVisible;
    visibilityCache.set(node.id, shouldRender);
    return shouldRender;
  };

  const walk = (node: TreeNode, depth: number) => {
    if (!visibilityCache.get(node.id)) {
      return;
    }

    const children = node.children ?? [];
    const isExpanded = expanded.has(node.id);
    const hasChildren = children.length > 0;
    const dimmed = showExcluded && (node.meta.status === "ignored" || node.meta.status === "skipped");

    visible.push({
      node,
      depth,
      hasChildren,
      isExpanded,
      dimmed,
    });

    if (query || isExpanded) {
      const orderedChildren = orderChildren(children, index, orderBy, stats, costMetric);
      for (const childId of orderedChildren) {
        const child = index.nodes.get(childId);
        if (!child) {
          continue;
        }
        walk(child, depth + 1);
      }
    }
  };

  computeVisible(root);
  if (root.children) {
    const orderedChildren = orderChildren(root.children, index, orderBy, stats, costMetric);
    for (const childId of orderedChildren) {
      const child = index.nodes.get(childId);
      if (child) {
        walk(child, 0);
      }
    }
  }
  return visible;
};

const orderChildren = (
  children: string[],
  index: TraceIndex,
  orderBy: "scan" | "alpha" | "cost",
  stats: Map<string, SubtreeStats>,
  costMetric: "total" | "ignored",
) => {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const childId of children) {
    const child = index.nodes.get(childId);
    const hasChildren = !!child?.children && child.children.length > 0;
    const isDir =
      !child ||
      child.kind === "dir" ||
      child.meta.status === "skipped" ||
      hasChildren;
    if (isDir) {
      dirs.push(childId);
    } else {
      files.push(childId);
    }
  }
  if (orderBy === "scan") {
    return dirs.concat(files);
  }

  const compareAlpha = (a: string, b: string) => {
    const nodeA = index.nodes.get(a);
    const nodeB = index.nodes.get(b);
    const nameA = nodeA?.name ?? a;
    const nameB = nodeB?.name ?? b;
    return nameA.localeCompare(nameB);
  };

  const compareCost = (a: string, b: string) => {
    const statsA = stats.get(a);
    const statsB = stats.get(b);
    const costA = statsA ? (costMetric === "ignored" ? statsA.ignored : statsA.totalNodes) : 0;
    const costB = statsB ? (costMetric === "ignored" ? statsB.ignored : statsB.totalNodes) : 0;
    if (costA !== costB) {
      return costB - costA;
    }
    return compareAlpha(a, b);
  };

  const sortFn = orderBy === "alpha" ? compareAlpha : compareCost;
  return dirs.sort(sortFn).concat(files.sort(sortFn));
};
