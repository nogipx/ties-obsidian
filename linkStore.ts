import { App, TFile } from "obsidian";

// Разбор значения property в linkpath: "[[Заметка]]" | "[[Заметка|алиас]]" -> "Заметка"
const WIKILINK_RE = /^\s*!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]\s*$/;

export function linkpathFromValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.match(WIKILINK_RE);
  return m ? m[1].trim() : null;
}

// Ссылка в форме link-property, с учётом кратчайшего уникального имени
export function wikilinkFor(app: App, target: TFile, sourcePath: string): string {
  const text = app.metadataCache.fileToLinktext(target, sourcePath, true);
  return `[[${text}]]`;
}

function toArray(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v.slice() : [v];
}

// Резолвится ли значение property в целевой файл (сравнение по файлу, не по строке)
function resolvesTo(app: App, value: unknown, sourcePath: string, target: TFile): boolean {
  const lp = linkpathFromValue(value);
  if (!lp) return false;
  const dest = app.metadataCache.getFirstLinkpathDest(lp, sourcePath);
  return dest?.path === target.path;
}

export type AddResult = "added" | "exists" | "self";

// Идемпотентно добавить типизированную связь в frontmatter текущей заметки
export async function addLink(
  app: App,
  source: TFile,
  type: string,
  target: TFile
): Promise<AddResult> {
  if (source.path === target.path) return "self";

  let result: AddResult = "added";
  await app.fileManager.processFrontMatter(source, (fm) => {
    const arr = toArray(fm[type]);
    if (arr.some((v) => resolvesTo(app, v, source.path, target))) {
      result = "exists";
      fm[type] = arr; // нормализуем к списку
      return;
    }
    arr.push(wikilinkFor(app, target, source.path));
    fm[type] = arr;
  });
  return result;
}

// Убрать связь (для будущего тоггла/чистки)
export async function removeLink(
  app: App,
  source: TFile,
  type: string,
  target: TFile
): Promise<boolean> {
  let removed = false;
  await app.fileManager.processFrontMatter(source, (fm) => {
    const arr = toArray(fm[type]);
    const next = arr.filter((v) => !resolvesTo(app, v, source.path, target));
    removed = next.length !== arr.length;
    if (next.length) fm[type] = next;
    else delete fm[type];
  });
  return removed;
}
