import { App, Modal, TFile, setIcon, getLinkpath } from "obsidian";
import { Graph, edgeLabel, TreeNode } from "./graph";
import { ReachableMoc } from "./moc";
import { NotePreviewModal } from "./notePreviewModal";

// Ярлык ребра между двумя заметками по метаданным (для маршрута до MOC).
function linkTypeBetween(app: App, from: TFile, to: TFile): string | null {
  const cache = app.metadataCache.getFileCache(from);
  for (const l of cache?.frontmatterLinks ?? []) {
    const d = app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), from.path);
    if (d?.path === to.path) return l.key.split(".")[0];
  }
  for (const l of cache?.links ?? []) {
    const d = app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), from.path);
    if (d?.path === to.path) return "тело";
  }
  return null;
}
function routeEdge(app: App, u: TFile, v: TFile): string {
  const f = linkTypeBetween(app, u, v);
  if (f) return `↓ ${f}`;
  const b = linkTypeBetween(app, v, u);
  if (b) return `↑ ${b}`;
  return "·";
}

function resolve(app: App, path: string): TFile | null {
  const f = app.vault.getAbstractFileByPath(path);
  return f instanceof TFile ? f : null;
}

function linkRow(app: App, parent: HTMLElement, path: string, modal: Modal): HTMLElement {
  const f = resolve(app, path);
  const a = parent.createEl("a", { text: f ? f.basename : path, cls: "zk-link" });
  a.addEventListener("click", (e) => {
    e.preventDefault();
    modal.close();
    app.workspace.openLinkText(path, "", false);
  });
  if (f) {
    const eye = parent.createSpan({ cls: "zk-route-eye clickable-icon" });
    eye.setAttribute("aria-label", "Предпросмотр");
    setIcon(eye, "eye");
    eye.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      new NotePreviewModal(app, f).open();
    });
  }
  return a;
}

function hops(n: number): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return `${n} хопов`;
  if (d === 1) return `${n} хоп`;
  if (d >= 2 && d <= 4) return `${n} хопа`;
  return `${n} хопов`;
}

export interface PathsDeps {
  compute: (from: TFile, to: TFile) => string[][];
  pick: (relativeTo: TFile, placeholder: string) => Promise<TFile | null>;
  neighborhood: (seed: TFile) => void;
}

// Пути между двумя заметками: вертикальный маршрут, топ-K. Оба конца меняются на месте.
export class PathsModal extends Modal {
  private from: TFile;
  private to: TFile;
  private paths: string[][];

  constructor(
    private appRef: App,
    from: TFile,
    private graph: Graph,
    to: TFile,
    paths: string[][],
    private deps: PathsDeps
  ) {
    super(appRef);
    this.from = from;
    this.to = to;
    this.paths = paths;
  }

  onOpen(): void {
    this.modalEl.addClass("zk-graph-modal");
    this.render();
  }

  private recompute(): void {
    this.paths = this.deps.compute(this.from, this.to);
    this.render();
  }

  private endpointChip(parent: HTMLElement, which: "from" | "to"): void {
    const file = which === "from" ? this.from : this.to;
    const chip = parent.createEl("a", { text: file.basename, cls: "zk-route-chip" });
    chip.title = which === "from" ? "сменить старт" : "сменить цель";
    chip.addEventListener("click", async (e) => {
      e.preventDefault();
      const other = which === "from" ? this.to : this.from;
      const picked = await this.deps.pick(
        other,
        which === "from" ? "Новый старт · похожие сверху" : "Новая цель · похожие сверху"
      );
      if (!picked) return;
      if (which === "from") this.from = picked;
      else this.to = picked;
      this.recompute();
    });
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("zk-modal");

    this.titleEl.setText("Пути");
    const header = contentEl.createDiv({ cls: "zk-modal-header" });

    const sub = header.createDiv({ cls: "zk-route-sub" });
    this.endpointChip(sub, "from");
    sub.createSpan({ text: " → ", cls: "zk-route-arrow" });
    this.endpointChip(sub, "to");

    const bar = header.createDiv({ cls: "zk-modal-bar" });
    const swap = bar.createEl("button", { text: "⇄ поменять местами" });
    swap.addEventListener("click", () => {
      const t = this.from;
      this.from = this.to;
      this.to = t;
      this.recompute();
    });
    bar.createSpan({ text: "нажми на заметку, чтобы сменить конец", cls: "zk-route-hint" });

    const body = contentEl.createDiv({ cls: "zk-modal-body" });
    if (!this.paths.length) {
      body.createDiv({
        text: "Прямого пути нет — заметки в разных частях графа.",
        cls: "zk-empty",
      });
      const nb = body.createEl("button", { text: "Показать окрестность старта" });
      nb.addEventListener("click", () => {
        this.close();
        this.deps.neighborhood(this.from);
      });
      return;
    }

    this.paths.forEach((path, i) => this.renderRoute(body, path, i));
  }

  private renderRoute(parent: HTMLElement, path: string[], i: number): void {
    const route = parent.createDiv({ cls: "zk-route" });
    const head = route.createDiv({ cls: "zk-route-head" });
    head.createSpan({ text: `Путь ${i + 1}`, cls: "zk-route-title" });
    head.createSpan({ text: hops(path.length - 1), cls: "zk-count" });

    path.forEach((p, idx) => {
      if (idx > 0) {
        const raw = edgeLabel(this.graph, path[idx - 1], p); // "→type" | "←type" | "—"
        const arrow = raw.startsWith("→") ? "↓" : raw.startsWith("←") ? "↑" : "·";
        const type = raw.replace(/^[→←—]/, "");
        const edge = route.createDiv({ cls: "zk-route-edge" });
        edge.createSpan({ text: `${arrow} ${type}`.trim(), cls: "zk-route-edge-label" });
      }
      const kind = idx === 0 ? "start" : idx === path.length - 1 ? "end" : "mid";
      const node = route.createDiv({ cls: "zk-route-node" });
      node.createSpan({ cls: `zk-route-dot zk-route-dot-${kind}` });
      linkRow(this.appRef, node, p, this);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// Соседские MOC с путями до них
export class MocsModal extends Modal {
  constructor(
    private appRef: App,
    private items: ReachableMoc[],
    private onNavigate: (path: string) => void
  ) {
    super(appRef);
  }

  private go(path: string): void {
    this.close();
    this.onNavigate(path);
  }

  onOpen(): void {
    this.modalEl.addClass("zk-graph-modal");
    this.titleEl.setText(`Соседские MOC (${this.items.length})`);
    const { contentEl } = this;
    contentEl.addClass("zk-modal");
    const body = contentEl.createDiv({ cls: "zk-modal-body" });
    if (this.items.length === 0) {
      body.createDiv({ text: "Соседних MOC нет.", cls: "zk-empty" });
      return;
    }
    for (const it of this.items) {
      const route = body.createDiv({ cls: "zk-route" });
      const head = route.createDiv({ cls: "zk-route-head" });
      const icon = head.createSpan({ cls: "zk-route-icon" });
      setIcon(icon, "layers");
      const title = head.createEl("a", { text: it.file.basename, cls: "zk-route-title zk-link" });
      title.addEventListener("click", (e) => {
        e.preventDefault();
        this.go(it.file.path);
      });
      head.createSpan({ text: hops(it.hops), cls: "zk-count" });

      it.path.forEach((p, idx) => {
        const isStart = idx === 0;
        const isEnd = idx === it.path.length - 1;
        if (idx > 0) {
          const edge = route.createDiv({ cls: "zk-route-edge" });
          edge.createSpan({
            text: routeEdge(this.appRef, it.path[idx - 1], p),
            cls: "zk-route-edge-label",
          });
        }
        const kind = isStart ? "start" : isEnd ? "end" : "mid";
        const node = route.createDiv({ cls: "zk-route-node" });
        node.createSpan({ cls: `zk-route-dot zk-route-dot-${kind}` });
        const a = node.createEl("a", {
          text: p.basename,
          cls: isStart ? "zk-link zk-route-start" : "zk-link",
        });
        a.addEventListener("click", (e) => {
          e.preventDefault();
          this.go(p.path);
        });
        // превью для промежуточных/конечного; у старта (текущая заметка) — не нужно
        const f = isStart ? null : resolve(this.appRef, p.path);
        if (f) {
          const eye = node.createSpan({ cls: "zk-route-eye clickable-icon" });
          eye.setAttribute("aria-label", "Предпросмотр");
          setIcon(eye, "eye");
          eye.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            new NotePreviewModal(this.appRef, f).open();
          });
        }
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface TreeDeps {
  build: (undirected: boolean) => { tree: TreeNode; count: number; truncated: boolean };
}

// Дерево обхода из заметки: все достижимые узлы (каждый один раз), сворачиваемое.
export class TreeModal extends Modal {
  private undirected = false;
  private tree!: TreeNode;
  private count = 0;
  private truncated = false;
  private expanded = new Set<string>();

  constructor(private appRef: App, private root: TFile, private deps: TreeDeps) {
    super(appRef);
  }

  onOpen(): void {
    this.modalEl.addClass("zk-graph-modal");
    this.rebuild();
  }

  private rebuild(): void {
    const r = this.deps.build(this.undirected);
    this.tree = r.tree;
    this.count = r.count;
    this.truncated = r.truncated;
    this.expanded.clear();
    this.markExpanded(this.tree, 2); // по умолчанию раскрыты 2 уровня
    this.render();
  }

  private markExpanded(node: TreeNode, maxDepth: number): void {
    if (node.depth < maxDepth) {
      this.expanded.add(node.path);
      for (const c of node.children) this.markExpanded(c, maxDepth);
    }
  }

  private allPaths(node: TreeNode, acc: Set<string>): void {
    if (node.children.length) acc.add(node.path);
    for (const c of node.children) this.allPaths(c, acc);
  }

  private sizes(node: TreeNode, map: Map<string, number>): number {
    let n = node.children.length;
    for (const c of node.children) n += this.sizes(c, map);
    map.set(node.path, n);
    return n;
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("zk-modal");

    this.titleEl.setText(`Обход: ${this.root.basename}`);
    const header = contentEl.createDiv({ cls: "zk-modal-header" });
    header.createDiv({
      cls: "zk-route-sub",
      text: `достижимо ${this.count}${this.truncated ? " (показаны первые " + this.count + ")" : ""}`,
    });

    const bar = header.createDiv({ cls: "zk-modal-bar" });
    const dir = bar.createEl("button", {
      text: this.undirected ? "Только исходящие" : "Все связи",
      cls: "mod-cta",
    });
    dir.addEventListener("click", () => {
      this.undirected = !this.undirected;
      this.rebuild();
    });
    const expand = bar.createEl("button", { text: "Развернуть всё" });
    expand.addEventListener("click", () => {
      this.allPaths(this.tree, this.expanded);
      this.render();
    });
    const collapse = bar.createEl("button", { text: "Свернуть всё" });
    collapse.addEventListener("click", () => {
      this.expanded.clear();
      this.render();
    });

    const body = contentEl.createDiv({ cls: "zk-modal-body" });
    if (!this.tree.children.length) {
      body.createDiv({
        text: this.undirected ? "Нет связей." : "Нет исходящих связей.",
        cls: "zk-empty",
      });
      return;
    }
    const sizeMap = new Map<string, number>();
    this.sizes(this.tree, sizeMap);
    for (const child of this.tree.children) this.renderNode(body, child, sizeMap);
  }

  private renderNode(parent: HTMLElement, node: TreeNode, sizeMap: Map<string, number>): void {
    const item = parent.createDiv({ cls: "zk-tree-item" });
    const row = item.createDiv({ cls: "zk-tree-row" });

    const hasKids = node.children.length > 0;
    const isOpen = this.expanded.has(node.path);
    const toggle = row.createSpan({ cls: "zk-tree-toggle" });
    if (hasKids) {
      toggle.setText(isOpen ? "▾" : "▸");
      toggle.addEventListener("click", () => {
        if (isOpen) this.expanded.delete(node.path);
        else this.expanded.add(node.path);
        this.render();
      });
    } else {
      toggle.addClass("zk-tree-leaf");
      toggle.setText("·");
    }

    if (node.edge) row.createSpan({ text: node.edge, cls: "zk-tree-edge" });
    linkRow(this.appRef, row, node.path, this);
    // размер поддерева показываем только у свёрнутых веток: «+N спрятано»
    if (hasKids && !isOpen) {
      row.createSpan({ text: `+${sizeMap.get(node.path)}`, cls: "zk-count" });
    }

    if (hasKids && isOpen) {
      const kids = item.createDiv({ cls: "zk-tree-children" });
      for (const c of node.children) this.renderNode(kids, c, sizeMap);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// Окрестность заметки (PPR)
export class NeighborhoodModal extends Modal {
  constructor(
    private appRef: App,
    private seed: TFile,
    private items: Array<{ path: string; score: number }>
  ) {
    super(appRef);
  }

  onOpen(): void {
    this.modalEl.addClass("zk-graph-modal");
    const { contentEl } = this;
    contentEl.addClass("zk-modal");
    this.titleEl.setText(`Окрестность: ${this.seed.basename}`);
    const header = contentEl.createDiv({ cls: "zk-modal-header" });

    const body = contentEl.createDiv({ cls: "zk-modal-body" });
    if (!this.items.length) {
      body.createDiv({ text: "Пусто — у заметки нет связей.", cls: "zk-empty" });
      return;
    }
    const max = this.items[0].score || 1;
    for (const it of this.items) {
      const row = body.createDiv({ cls: "zk-row" });
      linkRow(this.appRef, row, it.path, this);
      row.createSpan({ text: `${Math.round((it.score / max) * 100)}`, cls: "zk-count" });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
