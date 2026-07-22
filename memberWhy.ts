import { App, TFile, getLinkpath } from "obsidian";
import { linkpathFromValue } from "./linkStore";

// Пояснение «почему участник в карте» = алиас его moc-ссылки на этот MOC.
// moc: ["[[МОС Личность|почему тут]]"]  ->  "почему тут"

export function getMemberWhy(app: App, moc: TFile, member: TFile): string {
  const cache = app.metadataCache.getFileCache(member);
  for (const l of cache?.frontmatterLinks ?? []) {
    if (l.key.split(".")[0] !== "moc") continue;
    const dest = app.metadataCache.getFirstLinkpathDest(getLinkpath(l.link), member.path);
    if (dest?.path !== moc.path) continue;
    const dt = (l as { displayText?: string }).displayText;
    // displayText без алиаса == тексту ссылки/имени файла — это не пояснение
    if (dt && dt !== l.link && dt !== dest.basename) return dt;
    return "";
  }
  return "";
}

function sanitize(s: string): string {
  return s.replace(/[[\]|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export async function setMemberWhy(
  app: App,
  moc: TFile,
  member: TFile,
  whyRaw: string
): Promise<void> {
  const why = sanitize(whyRaw);
  const linktext = app.metadataCache.fileToLinktext(moc, member.path, true);
  await app.fileManager.processFrontMatter(member, (fm) => {
    const raw = fm.moc;
    const arr: unknown[] = Array.isArray(raw) ? raw.slice() : raw != null ? [raw] : [];
    let changed = false;
    const next = arr.map((item) => {
      if (typeof item !== "string") return item;
      const lp = linkpathFromValue(item);
      if (!lp) return item;
      const dest = app.metadataCache.getFirstLinkpathDest(lp, member.path);
      if (dest?.path === moc.path) {
        changed = true;
        return why ? `[[${linktext}|${why}]]` : `[[${linktext}]]`;
      }
      return item;
    });
    if (changed) fm.moc = Array.isArray(raw) ? next : next[0];
  });
}
