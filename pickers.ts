import { App, SuggestModal, TFile, prepareFuzzySearch, setIcon } from "obsidian";
import { RelType } from "./types";
import { NotePreviewModal } from "./notePreviewModal";

export interface ScoredFile {
  file: TFile;
  score: number | null; // косинус 0..1, null если нет эмбеддинга
  rel?: string | null; // бейдж существующей связи (напр. "развивает" или "←moc")
}

// Пикер заметки: похожие сверху (со score и путём), печать -> fuzzy-поиск.
export function pickSimilar(
  app: App,
  items: ScoredFile[],
  placeholder: string
): Promise<TFile | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: TFile | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    class Modal extends SuggestModal<ScoredFile> {
      getSuggestions(query: string): ScoredFile[] {
        const q = query.trim();
        if (!q) return items.slice(0, 50);
        const fuzzy = prepareFuzzySearch(q);
        const matched: Array<{ it: ScoredFile; s: number }> = [];
        for (const it of items) {
          const r = fuzzy(it.file.basename);
          if (r) matched.push({ it, s: r.score });
        }
        matched.sort((a, b) => b.s - a.s);
        return matched.slice(0, 50).map((m) => m.it);
      }
      renderSuggestion(item: ScoredFile, el: HTMLElement): void {
        el.addClass("zk-sugg");
        if (item.rel) el.addClass("zk-sugg-linked");
        const main = el.createDiv({ cls: "zk-sugg-main" });
        main.createSpan({ text: item.file.basename, cls: "zk-sugg-title" });
        if (item.rel) main.createSpan({ text: item.rel, cls: "zk-sugg-rel" });
        if (item.score !== null) {
          main.createSpan({
            text: `${Math.round(item.score * 100)}%`,
            cls: "zk-sugg-score",
          });
        }
        const eye = main.createSpan({ cls: "zk-sugg-eye clickable-icon" });
        eye.setAttribute("aria-label", "Предпросмотр");
        setIcon(eye, "eye");
        // не давать клику по глазу выбрать элемент (mousedown SuggestModal выбирает)
        eye.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        eye.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          new NotePreviewModal(this.app, item.file).open();
        });

        const dir = item.file.parent?.path ?? "";
        if (dir && dir !== "/") el.createDiv({ text: dir, cls: "zk-sugg-path" });
      }
      onChooseSuggestion(item: ScoredFile): void {
        done(item.file);
      }
      onClose(): void {
        super.onClose();
        setTimeout(() => done(null), 0);
      }
    }

    const m = new Modal(app);
    m.setPlaceholder(placeholder);
    m.open();
  });
}

// Пикер типа связи: last-used сверху (Enter), нумерация + хоткеи 1..9, с описанием.
export function pickType(
  app: App,
  types: RelType[],
  placeholder: string
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    class Modal extends SuggestModal<RelType> {
      constructor(a: App) {
        super(a);
        for (let i = 1; i <= Math.min(9, types.length); i++) {
          this.scope.register([], String(i), (e) => {
            e.preventDefault();
            done(types[i - 1].name);
            this.close();
          });
        }
      }
      getSuggestions(query: string): RelType[] {
        const q = query.toLowerCase();
        return types.filter(
          (t) => t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q)
        );
      }
      renderSuggestion(t: RelType, el: HTMLElement): void {
        const idx = types.indexOf(t);
        el.addClass("zk-sugg");
        el.createSpan({ text: idx < 9 ? `${idx + 1}` : "•", cls: "zk-sugg-num" });
        el.createSpan({ text: t.name, cls: "zk-sugg-title" });
        if (t.desc) el.createDiv({ text: t.desc, cls: "zk-sugg-path" });
      }
      onChooseSuggestion(t: RelType): void {
        done(t.name);
      }
      onClose(): void {
        super.onClose();
        setTimeout(() => done(null), 0);
      }
    }

    const m = new Modal(app);
    m.setPlaceholder(placeholder);
    m.open();
  });
}
