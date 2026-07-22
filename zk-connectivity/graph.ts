import { App, TFile, getLinkpath } from "obsidian";

export interface Graph {
  nodes: string[]; // пути файлов
  adj: Map<string, Set<string>>; // неориентированные соседи
  dir: Map<string, Array<{ to: string; type: string }>>; // направленные рёбра (для показа)
}

export function buildGraph(app: App, includeBody: boolean): Graph {
  const nodes: string[] = [];
  const adj = new Map<string, Set<string>>();
  const dir = new Map<string, Array<{ to: string; type: string }>>();

  const addU = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  const addD = (a: string, b: string, type: string) => {
    if (!dir.has(a)) dir.set(a, []);
    dir.get(a)!.push({ to: b, type });
  };

  const files = app.vault.getMarkdownFiles();
  for (const f of files) nodes.push(f.path);

  for (const f of files) {
    const cache = app.metadataCache.getFileCache(f);
    for (const l of cache?.frontmatterLinks ?? []) {
      const type = l.key.split(".")[0];
      const dest = app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), f.path);
      if (dest && dest.path !== f.path) {
        addU(f.path, dest.path);
        addD(f.path, dest.path, type);
      }
    }
    if (includeBody) {
      for (const l of cache?.links ?? []) {
        const dest = app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), f.path);
        if (dest && dest.path !== f.path) {
          addU(f.path, dest.path);
          addD(f.path, dest.path, "тело");
        }
      }
    }
  }
  return { nodes, adj, dir };
}

// Ярлык ребра u—v с направлением и типом (для отображения пути).
export function edgeLabel(graph: Graph, u: string, v: string): string {
  const fwd = graph.dir.get(u)?.find((e) => e.to === v);
  if (fwd) return `→${fwd.type}`;
  const bwd = graph.dir.get(v)?.find((e) => e.to === u);
  if (bwd) return `←${bwd.type}`;
  return "—";
}

// ---- Дерево обхода из заметки (BFS, каждый узел один раз) ----

export interface TreeNode {
  path: string;
  edge: string; // ярлык ребра от родителя (тип/направление)
  depth: number;
  children: TreeNode[];
}

export function buildTree(
  graph: Graph,
  root: string,
  undirected: boolean,
  maxNodes = 500
): { tree: TreeNode; count: number; truncated: boolean } {
  const visited = new Set<string>([root]);
  const rootNode: TreeNode = { path: root, edge: "", depth: 0, children: [] };
  const queue: TreeNode[] = [rootNode];
  let count = 0;
  let truncated = false;

  while (queue.length) {
    const node = queue.shift()!;
    const outs: Array<{ to: string; edge: string }> = [];
    if (undirected) {
      for (const to of graph.adj.get(node.path) ?? []) {
        outs.push({ to, edge: edgeLabel(graph, node.path, to) });
      }
    } else {
      const seen = new Set<string>();
      for (const e of graph.dir.get(node.path) ?? []) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        outs.push({ to: e.to, edge: e.type });
      }
    }
    for (const o of outs) {
      if (visited.has(o.to)) continue;
      if (count >= maxNodes) {
        truncated = true;
        break;
      }
      visited.add(o.to);
      count++;
      const child: TreeNode = { path: o.to, edge: o.edge, depth: node.depth + 1, children: [] };
      node.children.push(child);
      queue.push(child);
    }
  }
  return { tree: rootNode, count, truncated };
}

// ---- Кратчайшие пути (BFS, единичные веса) ----

function bfsPath(
  graph: Graph,
  start: string,
  goal: string,
  blockedNodes: Set<string>,
  blockedEdges: Set<string>
): string[] | null {
  if (start === goal) return [start];
  const prev = new Map<string, string>();
  const visited = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of graph.adj.get(u) ?? []) {
      if (blockedNodes.has(v) || visited.has(v)) continue;
      if (blockedEdges.has(u + "|" + v)) continue;
      visited.add(v);
      prev.set(v, u);
      if (v === goal) {
        const path = [v];
        let cur = v;
        while (cur !== start) {
          cur = prev.get(cur)!;
          path.unshift(cur);
        }
        return path;
      }
      queue.push(v);
    }
  }
  return null;
}

function samePrefix(a: string[], b: string[], len: number): boolean {
  if (a.length < len || b.length < len) return false;
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Топ-K кратчайших простых путей (алгоритм Йена).
export function kShortestPaths(
  graph: Graph,
  start: string,
  goal: string,
  K: number
): string[][] {
  if (start === goal || !graph.adj.has(start) || !graph.adj.has(goal)) return [];
  const first = bfsPath(graph, start, goal, new Set(), new Set());
  if (!first) return [];

  const A: string[][] = [first];
  const seen = new Set<string>([first.join(">")]);
  const B: Array<{ path: string[]; cost: number }> = [];

  for (let k = 1; k < K; k++) {
    const prev = A[k - 1];
    for (let i = 0; i < prev.length - 1; i++) {
      const spurNode = prev[i];
      const rootPath = prev.slice(0, i + 1);
      const blockedEdges = new Set<string>();
      const blockedNodes = new Set<string>();
      for (const p of A) {
        if (samePrefix(p, rootPath, i + 1)) {
          blockedEdges.add(p[i] + "|" + p[i + 1]);
          blockedEdges.add(p[i + 1] + "|" + p[i]);
        }
      }
      for (let j = 0; j < rootPath.length - 1; j++) blockedNodes.add(rootPath[j]);
      const spur = bfsPath(graph, spurNode, goal, blockedNodes, blockedEdges);
      if (spur) {
        const total = rootPath.slice(0, -1).concat(spur);
        const key = total.join(">");
        if (!seen.has(key) && !B.some((b) => b.path.join(">") === key)) {
          B.push({ path: total, cost: total.length });
        }
      }
    }
    if (!B.length) break;
    B.sort((a, b) => a.cost - b.cost || a.path.join(">").localeCompare(b.path.join(">")));
    const next = B.shift()!;
    seen.add(next.path.join(">"));
    A.push(next.path);
  }
  return A;
}

// ---- Personalized PageRank (random walk with restart) ----

export function personalizedPageRank(
  graph: Graph,
  seed: string,
  alpha = 0.15,
  iters = 40
): Map<string, number> {
  let rank = new Map<string, number>();
  for (const n of graph.nodes) rank.set(n, 0);
  rank.set(seed, 1);

  for (let it = 0; it < iters; it++) {
    const next = new Map<string, number>();
    for (const n of graph.nodes) next.set(n, 0);
    next.set(seed, alpha);
    for (const u of graph.nodes) {
      const ru = rank.get(u)!;
      if (ru === 0) continue;
      const nb = graph.adj.get(u);
      if (!nb || nb.size === 0) {
        next.set(seed, next.get(seed)! + (1 - alpha) * ru); // тупик — назад к seed
        continue;
      }
      const share = ((1 - alpha) * ru) / nb.size;
      for (const v of nb) next.set(v, next.get(v)! + share);
    }
    rank = next;
  }
  return rank;
}
