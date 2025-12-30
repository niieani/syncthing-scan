import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import "./index.css";
import type { SerializedIndex, TraceIndex, TreeNode } from "./types/trace";
import { buildVisibleList, computeSubtreeStats, deserializeIndex, mergeIndexes, type SubtreeStats } from "./lib/traceIndex";
import { useLocalStorageState } from "./hooks/useLocalStorageState";

type WorkerMessage =
  | { type: "progress"; fileLabel: "A" | "B"; processed: number; total: number }
  | { type: "result"; index: SerializedIndex }
  | { type: "result-compare"; indexA: SerializedIndex; indexB: SerializedIndex }
  | { type: "error"; message: string };

const DEFAULT_EXPANDED_KEY = "stscan.expanded.v1";
const SHOW_EXCLUDED_KEY = "stscan.showExcluded.v1";
const COMPARE_MODE_KEY = "stscan.compareMode.v1";

export function App() {
  const [indexA, setIndexA] = useState<TraceIndex | null>(null);
  const [indexB, setIndexB] = useState<TraceIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ fileLabel: "A" | "B"; processed: number; total: number } | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [fileA, setFileA] = useState<File | null>(null);
  const [fileB, setFileB] = useState<File | null>(null);
  const [orderBy, setOrderBy] = useLocalStorageState<"scan" | "alpha" | "cost">("stscan.orderBy.v1", "scan");
  const [costMetric, setCostMetric] = useLocalStorageState<"total" | "ignored">("stscan.costMetric.v1", "total");

  const [compareMode, setCompareMode] = useLocalStorageState<boolean>(COMPARE_MODE_KEY, false);
  const [showExcluded, setShowExcluded] = useLocalStorageState<boolean>(SHOW_EXCLUDED_KEY, true);
  const [expandedIds, setExpandedIds] = useLocalStorageState<string[]>(DEFAULT_EXPANDED_KEY, []);

  const workerRef = useRef<Worker | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const expandedSet = useMemo(() => new Set(expandedIds), [expandedIds]);

  const activeIndex = useMemo(() => {
    if (compareMode && indexA && indexB) {
      return mergeIndexes(indexA, indexB);
    }
    return indexA;
  }, [compareMode, indexA, indexB]);

  useEffect(() => {
    const worker = new Worker(new URL("/workers/traceParser.js", window.location.origin), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data;
      if (msg.type === "progress") {
        setProgress({ fileLabel: msg.fileLabel, processed: msg.processed, total: msg.total });
        return;
      }
      if (msg.type === "error") {
        setError(msg.message);
        setProgress(null);
        return;
      }
      if (msg.type === "result") {
        setIndexA(deserializeIndex(msg.index));
        setIndexB(null);
        setProgress(null);
        setError(null);
        return;
      }
      if (msg.type === "result-compare") {
        setIndexA(deserializeIndex(msg.indexA));
        setIndexB(deserializeIndex(msg.indexB));
        setProgress(null);
        setError(null);
      }
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
    };
  }, []);

  useEffect(() => {
    if (!compareMode) {
      setFileB(null);
    }
  }, [compareMode]);

  useEffect(() => {
    if (!activeIndex) {
      return;
    }
    if (expandedIds.length > 0) {
      return;
    }
    const root = activeIndex.nodes.get(activeIndex.rootId);
    if (!root) {
      return;
    }
    setExpandedIds([root.id]);
  }, [activeIndex, expandedIds.length, setExpandedIds]);

  const subtreeStats = useMemo(() => {
    if (!activeIndex) {
      return new Map<string, SubtreeStats>();
    }
    return computeSubtreeStats(activeIndex);
  }, [activeIndex]);

  const subtreeStatsA = useMemo(() => {
    if (!indexA) {
      return new Map<string, SubtreeStats>();
    }
    return computeSubtreeStats(indexA);
  }, [indexA]);

  const subtreeStatsB = useMemo(() => {
    if (!indexB) {
      return new Map<string, SubtreeStats>();
    }
    return computeSubtreeStats(indexB);
  }, [indexB]);

  const visibleNodes = useMemo(() => {
    if (!activeIndex) {
      return [];
    }
    return buildVisibleList(activeIndex, expandedSet, showExcluded, search, orderBy, subtreeStats, costMetric);
  }, [activeIndex, expandedSet, showExcluded, search, orderBy, subtreeStats, costMetric]);

  const rowVirtualizer = useVirtualizer({
    count: visibleNodes.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  const handleSingleFile = (file: File) => {
    if (!workerRef.current) {
      return;
    }
    workerRef.current.postMessage({ type: "parse", file });
  };

  const handleCompareFiles = (nextA: File | null, nextB: File | null) => {
    if (!compareMode) {
      return;
    }
    if (!workerRef.current) {
      return;
    }
    if (nextA && nextB) {
      workerRef.current.postMessage({ type: "parse-compare", fileA: nextA, fileB: nextB });
    }
  };

  const toggleExpanded = (node: TreeNode) => {
    const next = new Set(expandedSet);
    if (next.has(node.id)) {
      next.delete(node.id);
    } else {
      next.add(node.id);
    }
    setExpandedIds(Array.from(next));
  };

  const selectedNode = useMemo(() => {
    if (!activeIndex || !selectedPath) {
      return null;
    }
    return activeIndex.nodes.get(selectedPath) ?? null;
  }, [activeIndex, selectedPath]);

  const selectedIndex = useMemo(() => {
    if (!selectedPath) {
      return -1;
    }
    return visibleNodes.findIndex(item => item.node.id === selectedPath);
  }, [selectedPath, visibleNodes]);

  const selectByIndex = (index: number) => {
    if (index < 0 || index >= visibleNodes.length) {
      return;
    }
    setSelectedPath(visibleNodes[index].node.id);
    rowVirtualizer.scrollToIndex(index, { align: "auto" });
  };

  const selectById = (id: string) => {
    const idx = visibleNodes.findIndex(item => item.node.id === id);
    if (idx === -1) {
      setSelectedPath(id);
      return;
    }
    selectByIndex(idx);
  };

  const getParentPath = (path: string) => {
    const idx = path.lastIndexOf("/");
    if (idx === -1) {
      return null;
    }
    const parent = path.slice(0, idx);
    return parent || null;
  };

  return (
    <div className="h-screen overflow-hidden bg-app text-ink flex flex-col">
      <header className="px-8 py-6 border-b border-ink/10 sticky top-0 z-20 backdrop-blur bg-app/90">
        <div className="flex flex-wrap items-center gap-4 justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">StScan Trace Explorer</h1>
            <p className="text-sm text-ink/70">Inspect include/ignore decisions and traversal behavior.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <FileDropZone
              label={compareMode ? "Trace A" : "Trace JSONL"}
              compact
              onFile={file => {
                setError(null);
                if (compareMode) {
                  setFileA(file);
                  handleCompareFiles(file, fileB);
                } else {
                  handleSingleFile(file);
                }
              }}
              onInputChange={e => {
                const file = e.target.files?.[0];
                if (!file) {
                  return;
                }
                if (compareMode) {
                  setFileA(file);
                  handleCompareFiles(file, fileB);
                } else {
                  handleSingleFile(file);
                }
              }}
            />
            {compareMode && (
              <FileDropZone
                label="Trace B"
                compact
                onFile={file => {
                  setError(null);
                  setFileB(file);
                  handleCompareFiles(fileA, file);
                }}
                onInputChange={e => {
                  const file = e.target.files?.[0];
                  if (!file) {
                    return;
                  }
                  setFileB(file);
                  handleCompareFiles(fileA, file);
                }}
              />
            )}
            <label className="flex items-center gap-2 text-sm">
              <span>Compare</span>
              <input
                type="checkbox"
                className="accent-accent"
                checked={compareMode}
                onChange={e => setCompareMode(e.target.checked)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span>Show Excluded</span>
              <input
                type="checkbox"
                className="accent-accent"
                checked={showExcluded}
                onChange={e => setShowExcluded(e.target.checked)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span>Cost Metric</span>
              <select
                value={costMetric}
                onChange={e => setCostMetric(e.target.value as "total" | "ignored")}
                className="px-2 py-1 rounded-lg bg-white/80 border border-ink/10 text-sm"
              >
                <option value="total">Total</option>
                <option value="ignored">Ignored</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span>Order by</span>
              <select
                value={orderBy}
                onChange={e => setOrderBy(e.target.value as "scan" | "alpha" | "cost")}
                className="px-2 py-1 rounded-lg bg-white/80 border border-ink/10 text-sm"
              >
                <option value="scan">Scanning order</option>
                <option value="cost">Cost of subtree</option>
                <option value="alpha">Alphabetical</option>
              </select>
            </label>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search path…"
              className="px-3 py-2 rounded-lg bg-white/80 border border-ink/10 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>
        </div>
        {(progress || error) && (
          <div className="mt-3 text-xs text-ink/60 flex items-center gap-4">
            {progress && (
              <span>
                Parsing {progress.fileLabel}: {progress.processed} / {progress.total} lines…
              </span>
            )}
            {error && <span className="text-red-600">{error}</span>}
          </div>
        )}
      </header>

      <main className="flex-1 min-h-0 grid grid-cols-[minmax(320px,1.2fr)_minmax(280px,0.8fr)] gap-6 px-8 py-6">
        <section className="bg-panel rounded-2xl border border-ink/10 shadow-panel p-4 flex flex-col min-h-0">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold">Trace Tree</h2>
              <p className="text-xs text-ink/60">Expand to explore included + excluded paths.</p>
            </div>
            <div className="flex items-center gap-3 text-xs text-ink/60">
              {activeIndex ? (
                <>
                  <span>{activeIndex.counts.included} included</span>
                  <span className="mx-2">•</span>
                  <span>{activeIndex.counts.ignored} ignored</span>
                  <span className="mx-2">•</span>
                  <span>{activeIndex.counts.skipped} skipped</span>
                </>
              ) : (
                "No trace loaded"
              )}
              {compareMode && (
                <div className="flex items-center gap-2 ml-2">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-sky-400" />
                    <span>Only A</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-violet-400" />
                    <span>Only B</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-amber-400" />
                    <span>Diff contents</span>
                  </span>
                </div>
              )}
              <button
                type="button"
                className="ml-2 px-2 py-1 rounded-full border border-ink/20 hover:bg-ink/5"
                onClick={() => {
                  if (!activeIndex) {
                    return;
                  }
                  setExpandedIds([activeIndex.rootId]);
                }}
              >
                Fold all
              </button>
            </div>
          </div>

          <div
            ref={listRef}
            tabIndex={0}
            className="flex-1 min-h-0 overflow-auto rounded-xl border border-ink/10 bg-white/80 focus:outline-none focus:ring-2 focus:ring-accent/40"
            onKeyDown={e => {
              if (!visibleNodes.length) {
                return;
              }
              if (selectedIndex === -1) {
                setSelectedPath(visibleNodes[0].node.id);
                return;
              }
              const current = visibleNodes[selectedIndex];
              if (!current) {
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                selectByIndex(selectedIndex + 1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                selectByIndex(selectedIndex - 1);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                if (current.hasChildren && !current.isExpanded) {
                  toggleExpanded(current.node);
                } else if (current.hasChildren && current.isExpanded) {
                  selectByIndex(selectedIndex + 1);
                }
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                if (current.hasChildren && current.isExpanded) {
                  toggleExpanded(current.node);
                } else {
                  const parent = getParentPath(current.node.id);
                  if (parent) {
                    selectById(parent);
                  }
                }
              }
            }}
            onMouseDown={() => {
              listRef.current?.focus();
            }}
          >
            <div
              style={{
                height: rowVirtualizer.getTotalSize(),
                position: "relative",
              }}
            >
              {rowVirtualizer.getVirtualItems().map(item => {
                const row = visibleNodes[item.index];
                if (!row) {
                  return null;
                }
                return (
                    <TreeRow
                      key={row.node.id}
                      row={row}
                      stats={subtreeStats.get(row.node.id)}
                      statsA={subtreeStatsA.get(row.node.id)}
                      statsB={subtreeStatsB.get(row.node.id)}
                      compareMode={compareMode}
                      costMetric={costMetric}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                      width: "100%",
                      transform: `translateY(${item.start}px)`,
                    }}
                    onToggle={() => toggleExpanded(row.node)}
                    onSelect={() => setSelectedPath(row.node.id)}
                    selected={selectedPath === row.node.id}
                  />
                );
              })}
            </div>
          </div>
        </section>

        <section className="bg-panel rounded-2xl border border-ink/10 shadow-panel p-5 flex flex-col gap-4 min-h-0">
          <h2 className="text-lg font-semibold">Details</h2>
          {selectedNode ? (
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-widest text-ink/50">Path</div>
                <div className="font-mono text-sm break-all">{selectedNode.path}</div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <DetailField label="Kind" value={selectedNode.kind} />
                <DetailField label="Status" value={selectedNode.meta.status} />
                <DetailField label="Reason" value={selectedNode.meta.reason ?? "—"} />
                <DetailField label="Pattern" value={selectedNode.meta.pattern ?? "—"} />
              </div>
              {subtreeStats.get(selectedNode.id) && (
                <div className="border-t border-ink/10 pt-3 space-y-2">
                  <h3 className="text-xs uppercase tracking-widest text-ink/50">Subtree Cost</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <DetailField label="Total items" value={`${subtreeStats.get(selectedNode.id)?.totalNodes ?? 0}`} />
                    <DetailField label="Traversed dirs" value={`${(subtreeStats.get(selectedNode.id)?.totalDirs ?? 0) - (subtreeStats.get(selectedNode.id)?.skipped ?? 0)}`} />
                    <DetailField label="Dirs" value={`${subtreeStats.get(selectedNode.id)?.totalDirs ?? 0}`} />
                    <DetailField label="Files" value={`${subtreeStats.get(selectedNode.id)?.totalFiles ?? 0}`} />
                    <DetailField label="Ignored" value={`${subtreeStats.get(selectedNode.id)?.ignored ?? 0}`} />
                    <DetailField label="Skipped dirs" value={`${subtreeStats.get(selectedNode.id)?.skipped ?? 0}`} />
                  </div>
                </div>
              )}
              {compareMode && (
                <div className="border-t border-ink/10 pt-3">
                  <h3 className="text-xs uppercase tracking-widest text-ink/50 mb-2">Compare</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <DetailField label="Status (A)" value={selectedNode.meta.status ?? "—"} />
                    <DetailField label="Status (B)" value={selectedNode.meta.statusB ?? "—"} />
                    <DetailField label="Reason (A)" value={selectedNode.meta.reason ?? "—"} />
                    <DetailField label="Reason (B)" value={selectedNode.meta.reasonB ?? "—"} />
                    <DetailField label="Pattern (A)" value={selectedNode.meta.pattern ?? "—"} />
                    <DetailField label="Pattern (B)" value={selectedNode.meta.patternB ?? "—"} />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-ink/60">Select a file or folder to see details.</p>
          )}
        </section>
      </main>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-widest text-ink/50">{label}</div>
      <div className="text-sm font-semibold break-all">{value}</div>
    </div>
  );
}

function FileDropZone({
  label,
  onFile,
  onInputChange,
  compact = false,
}: {
  label: string;
  onFile: (file: File) => void;
  onInputChange: (e: ChangeEvent<HTMLInputElement>) => void;
  compact?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <label
      className={`border-2 border-dashed rounded-xl ${compact ? "px-3 py-2 text-xs" : "px-4 py-4 text-sm"} cursor-pointer transition ${
        dragging ? "border-accent bg-accent/10" : "border-ink/15 bg-white/60"
      }`}
      onDragOver={e => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files?.[0]) {
          onFile(e.dataTransfer.files[0]);
        }
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-semibold">{label}</div>
          {!compact && <div className="text-xs text-ink/60">Drop JSONL trace here or click to select.</div>}
        </div>
        <span className="text-xs px-2 py-1 rounded-full bg-ink/10">JSONL</span>
      </div>
      <input type="file" className="hidden" onChange={onInputChange} accept=".jsonl,.txt" />
    </label>
  );
}

function TreeRow({
  row,
  stats,
  statsA,
  statsB,
  style,
  onToggle,
  onSelect,
  selected,
  costMetric = "total",
  compareMode,
}: {
  row: ReturnType<typeof buildVisibleList>[number];
  stats?: SubtreeStats;
  statsA?: SubtreeStats;
  statsB?: SubtreeStats;
  style: React.CSSProperties;
  onToggle: () => void;
  onSelect: () => void;
  selected: boolean;
  costMetric?: "total" | "ignored";
  compareMode?: boolean;
}) {
  const { node, depth, hasChildren, isExpanded, dimmed } = row;
  const statusColor =
    node.meta.status === "included"
      ? "bg-emerald-400"
      : node.meta.status === "ignored"
      ? "bg-rose-400"
      : node.meta.status === "skipped"
      ? "bg-amber-400"
      : "bg-slate-300";

  const statusA = node.meta.status;
  const statusB = node.meta.statusB;
  const onlyA = compareMode && statusA === "included" && statusB !== "included";
  const onlyB = compareMode && statusB === "included" && statusA !== "included";
  const diffContents =
    compareMode &&
    !onlyA &&
    !onlyB &&
    hasChildren &&
    statsA &&
    statsB &&
    (statsA.totalNodes !== statsB.totalNodes ||
      statsA.totalFiles !== statsB.totalFiles ||
      statsA.totalDirs !== statsB.totalDirs ||
      statsA.ignored !== statsB.ignored ||
      statsA.skipped !== statsB.skipped);

  const compareBadge = onlyA ? "A only" : onlyB ? "B only" : diffContents ? "Diff" : null;
  const compareClass = onlyA
    ? "bg-sky-100 text-sky-800 border-sky-200"
    : onlyB
    ? "bg-violet-100 text-violet-800 border-violet-200"
    : diffContents
    ? "bg-amber-100 text-amber-800 border-amber-200"
    : "";
  return (
    <button
      type="button"
      onClick={onSelect}
      style={style}
      className={`tree-row w-full h-7 text-left px-3 py-1 flex items-center gap-2 min-w-0 whitespace-nowrap transition-all duration-200 border-l-4 ${
        selected ? "bg-accent/15 border-accent" : "hover:bg-ink/5 border-transparent"
      } ${dimmed ? "opacity-50" : ""}`}
    >
      <span className="inline-block shrink-0" style={{ width: depth * 14 }} />
      {hasChildren ? (
        <span
          className="text-xs w-5 h-5 flex items-center justify-center rounded-full border border-ink/20"
          onClick={e => {
            e.stopPropagation();
            onToggle();
          }}
        >
          {isExpanded ? "–" : "+"}
        </span>
      ) : (
        <span className="w-5" />
      )}
      <span className={`w-2 h-2 rounded-full ${statusColor}`} />
      <span className="font-mono text-xs text-ink/80 truncate">{node.name}</span>
      {compareBadge && (
        <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full border ${compareClass}`}>
          {compareBadge}
        </span>
      )}
      {hasChildren && stats && (
        <span
          className={`text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full ${
            compareBadge ? "" : "ml-auto"
          } ${
            (costMetric === "ignored" ? stats.ignored : stats.totalNodes) > 1000
              ? "bg-rose-200 text-rose-800"
              : (costMetric === "ignored" ? stats.ignored : stats.totalNodes) < 20
              ? "bg-emerald-100 text-emerald-800"
              : "bg-amber-100 text-amber-800"
          }`}
        >
          {costMetric === "ignored" ? stats.ignored : stats.totalNodes}
        </span>
      )}
    </button>
  );
}

export default App;
