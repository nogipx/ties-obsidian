import { App, TFile } from "obsidian";
import { embed, stripFrontmatter, cosine, EmbedConfig } from "./embeddings";

interface StoredEntry {
  hash: string; // хэш входного текста (basename + тело)
  model: string; // модель, которой посчитан вектор
  vector: number[];
}

// Быстрый строковый хэш (FNV-1a, 32 бита) — для ключа кэша, не крипто.
function hashStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// Индекс эмбеддингов заметок с кэшем на диск.
// Инвалидация по хэшу содержимого (переносимо между устройствами) + метка модели.
export class EmbeddingIndex {
  private app: App;
  private cachePath: string;
  private cfg: () => EmbedConfig;
  private map = new Map<string, { hash: string; model: string; vector: Float32Array }>();
  private dirty = false;

  constructor(app: App, cachePath: string, cfg: () => EmbedConfig) {
    this.app = app;
    this.cachePath = cachePath;
    this.cfg = cfg;
  }

  size(): number {
    return this.map.size;
  }

  async load(): Promise<void> {
    try {
      if (await this.app.vault.adapter.exists(this.cachePath)) {
        const raw = await this.app.vault.adapter.read(this.cachePath);
        const obj = JSON.parse(raw) as Record<string, StoredEntry>;
        for (const [p, e] of Object.entries(obj)) {
          this.map.set(p, {
            hash: e.hash ?? "",
            model: e.model ?? "",
            vector: Float32Array.from(e.vector),
          });
        }
      }
    } catch (e) {
      console.error("[ties] emb cache load failed", e);
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const obj: Record<string, StoredEntry> = {};
    for (const [p, e] of this.map) {
      obj[p] = { hash: e.hash, model: e.model, vector: Array.from(e.vector) };
    }
    try {
      await this.app.vault.adapter.write(this.cachePath, JSON.stringify(obj));
      this.dirty = false;
    } catch (e) {
      console.error("[ties] emb cache save failed", e);
    }
  }

  private async buildInput(file: TFile): Promise<string> {
    const body = stripFrontmatter(await this.app.vault.cachedRead(file)).slice(0, 4000);
    return `${file.basename}\n\n${body}`;
  }

  async ensure(file: TFile): Promise<Float32Array> {
    const input = await this.buildInput(file);
    const hash = hashStr(input);
    const model = this.cfg().model;
    const e = this.map.get(file.path);
    if (e && e.hash === hash && e.model === model) return e.vector;
    const vector = await embed(input, this.cfg());
    this.map.set(file.path, { hash, model, vector });
    this.dirty = true;
    return vector;
  }

  async build(
    files: TFile[],
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    let done = 0;
    const model = this.cfg().model;
    for (const f of files) {
      try {
        const input = await this.buildInput(f);
        const hash = hashStr(input);
        const e = this.map.get(f.path);
        if (!e || e.hash !== hash || e.model !== model) {
          const vector = await embed(input, this.cfg());
          this.map.set(f.path, { hash, model, vector });
          this.dirty = true;
        }
      } catch (e) {
        console.error("[ties] embed failed", f.path, e);
      }
      done++;
      onProgress?.(done, files.length);
      if (done % 10 === 0) await this.save();
    }
    await this.save();
  }

  remove(path: string): void {
    if (this.map.delete(path)) this.dirty = true;
  }

  similar(
    query: Float32Array,
    excludePath: string,
    topN: number
  ): Array<{ path: string; score: number }> {
    const scored: Array<{ path: string; score: number }> = [];
    for (const [p, e] of this.map) {
      if (p === excludePath) continue;
      if (e.vector.length !== query.length) continue; // другая модель/размерность — пропускаем
      scored.push({ path: p, score: cosine(query, e.vector) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
  }
}
