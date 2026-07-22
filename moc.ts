import { App, TFile, getLinkpath } from "obsidian";

export function isMoc(app: App, file: TFile, pattern: string): boolean {
  const kind = app.metadataCache.getFileCache(file)?.frontmatter?.kind;
  if (kind === "moc") return true;
  const rx = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
  );
  return rx.test(file.basename);
}

function resolve(app: App, link: string, sourcePath: string): TFile | null {
  return app.metadataCache.getFirstLinkpathDest(getLinkpath(link), sourcePath);
}

function backlinkEntries(app: App, file: TFile): [string, any[]][] {
  const bl: any = (app.metadataCache as any).getBacklinksForFile?.(file);
  const data = bl?.data;
  return data instanceof Map ? [...data.entries()] : Object.entries(data ?? {});
}

// Прямые участники: у кого moc-ссылка (frontmatter) указывает на этот MOC
export function directMembers(app: App, moc: TFile): TFile[] {
  const out: TFile[] = [];
  const seen = new Set<string>();
  for (const [srcPath, refs] of backlinkEntries(app, moc)) {
    const isMember = (refs ?? []).some(
      (r: any) => r?.key && String(r.key).split(".")[0] === "moc"
    );
    if (!isMember || seen.has(srcPath)) continue;
    const f = app.vault.getAbstractFileByPath(srcPath);
    if (f instanceof TFile) {
      out.push(f);
      seen.add(srcPath);
    }
  }
  return out;
}

export function neighbors(app: App, file: TFile): Set<string> {
  const res = new Set<string>();
  const cache = app.metadataCache.getFileCache(file);
  for (const l of cache?.frontmatterLinks ?? []) {
    const d = resolve(app, l.link, file.path);
    if (d) res.add(d.path);
  }
  for (const l of cache?.links ?? []) {
    const d = resolve(app, l.link, file.path);
    if (d) res.add(d.path);
  }
  for (const [srcPath] of backlinkEntries(app, file)) res.add(srcPath);
  return res;
}

// Орбита: соседи участников на 1 хоп, не участники и не MOC, ранжированы по числу связей внутрь
export function orbit(
  app: App,
  moc: TFile,
  members: TFile[],
  pattern: string
): Array<{ file: TFile; count: number }> {
  const memberPaths = new Set(members.map((m) => m.path));
  const counts = new Map<string, number>();
  for (const m of members) {
    for (const nb of neighbors(app, m)) {
      if (nb === moc.path || memberPaths.has(nb)) continue;
      counts.set(nb, (counts.get(nb) ?? 0) + 1);
    }
  }
  const res: Array<{ file: TFile; count: number }> = [];
  for (const [p, count] of counts) {
    const f = app.vault.getAbstractFileByPath(p);
    if (!(f instanceof TFile) || isMoc(app, f, pattern)) continue;
    res.push({ file: f, count });
  }
  res.sort((a, b) => b.count - a.count);
  return res;
}

// Кратчайший путь до ближайшего MOC (BFS, ненаправленно). null = сирота.
export function pathToMoc(app: App, start: TFile, pattern: string): TFile[] | null {
  if (isMoc(app, start, pattern)) return [start];
  const visited = new Set<string>([start.path]);
  const queue: TFile[][] = [[start]];
  const MAX = 8;
  while (queue.length) {
    const path = queue.shift()!;
    if (path.length > MAX) continue;
    const last = path[path.length - 1];
    for (const nbPath of neighbors(app, last)) {
      if (visited.has(nbPath)) continue;
      visited.add(nbPath);
      const nb = app.vault.getAbstractFileByPath(nbPath);
      if (!(nb instanceof TFile)) continue;
      const newPath = [...path, nb];
      if (isMoc(app, nb, pattern)) return newPath;
      queue.push(newPath);
    }
  }
  return null;
}
