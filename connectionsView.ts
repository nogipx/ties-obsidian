import { App, ItemView, TFile, WorkspaceLeaf, getLinkpath } from "obsidian";

export const VIEW_TYPE_TIES = "ties-connections";

interface Conn {
  type: string;
  file: TFile;
}

function group(conns: Conn[]): Map<string, TFile[]> {
  const m = new Map<string, TFile[]>();
  for (const c of conns) {
    const arr = m.get(c.type) ?? [];
    if (!arr.some((f) => f.path === c.file.path)) arr.push(c.file);
    m.set(c.type, arr);
  }
  return m;
}

export function computeConnections(app: App, file: TFile, includeBody: boolean) {
  const cache = app.metadataCache.getFileCache(file);

  const out: Conn[] = [];
  for (const l of cache?.frontmatterLinks ?? []) {
    const type = l.key.split(".")[0];
    const dest = app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), file.path);
    if (dest && dest.path !== file.path) out.push({ type, file: dest });
  }
  if (includeBody) {
    for (const l of cache?.links ?? []) {
      const dest = app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), file.path);
      if (dest && dest.path !== file.path) out.push({ type: "тело", file: dest });
    }
  }

  const inc: Conn[] = [];
  const bl: any = (app.metadataCache as any).getBacklinksForFile?.(file);
  const data = bl?.data;
  const entries: [string, any[]][] =
    data instanceof Map ? [...data.entries()] : Object.entries(data ?? {});
  for (const [srcPath, refs] of entries) {
    const src = app.vault.getAbstractFileByPath(srcPath);
    if (!(src instanceof TFile)) continue;
    for (const r of refs ?? []) {
      const isFm = !!r?.key;
      if (!isFm && !includeBody) continue;
      const type = isFm ? String(r.key).split(".")[0] : "тело";
      inc.push({ type, file: src });
    }
  }

  return { outgoing: group(out), incoming: group(inc) };
}

export class ConnectionsView extends ItemView {
  private getIncludeBody: () => boolean;

  constructor(leaf: WorkspaceLeaf, getIncludeBody: () => boolean) {
    super(leaf);
    this.getIncludeBody = getIncludeBody;
  }

  getViewType(): string {
    return VIEW_TYPE_TIES;
  }
  getDisplayText(): string {
    return "Ties: связи";
  }
  getIcon(): string {
    return "link";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.render()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.render()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.render()));
    this.render();
  }

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("zk-connections");

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      root.createDiv({ text: "Открой заметку, чтобы увидеть её связи", cls: "zk-empty" });
      return;
    }
    root.createDiv({ text: file.basename, cls: "zk-panel-title" });

    const { outgoing, incoming } = computeConnections(this.app, file, this.getIncludeBody());
    this.section(root, "Исходящие", outgoing);
    this.section(root, "Входящие", incoming);
    if (outgoing.size === 0 && incoming.size === 0) {
      root.createDiv({
        text: "Пока нет связей. Свяжи заметку командой «Связать заметку».",
        cls: "zk-hint",
      });
    }
  }

  private section(parent: HTMLElement, title: string, groups: Map<string, TFile[]>): void {
    const wrap = parent.createDiv({ cls: "zk-section" });
    wrap.createDiv({ text: title, cls: "zk-section-title" });
    if (groups.size === 0) {
      wrap.createDiv({ text: "—", cls: "zk-empty" });
      return;
    }
    for (const [type, files] of groups) {
      const g = wrap.createDiv({ cls: "zk-group" });
      g.createDiv({ text: type, cls: "zk-type" });
      for (const f of files) {
        const a = g.createEl("a", { text: f.basename, cls: "zk-link" });
        a.addEventListener("click", (e) => {
          e.preventDefault();
          this.app.workspace.openLinkText(f.path, "", false);
        });
      }
    }
  }
}
