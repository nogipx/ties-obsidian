import { App, TFile } from "obsidian";
import { embed, stripFrontmatter, cosine, EmbedConfig } from "./embeddings";

interface StoredEntry {
  mtime: number;
  vector: number[];
}

// Индекс эмбеддингов заметок с кэшем на диск. Инкрементально: mtime-инвалидация.
export class EmbeddingIndex {
  private app: App;
  private cachePath: string;
  private cfg: () => EmbedConfig;
  private map = new Map<string, { mtime: number; vector: Float32Array }>();
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
          this.map.set(p, { mtime: e.mtime, vector: Float32Array.from(e.vector) });
        }
      }
    } catch (e) {
      console.error("[ties] emb cache load failed", e);
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const obj: Record<string, StoredEntry> = {};
    for (const [p, e] of this.map) obj[p] = { mtime: e.mtime, vector: Array.from(e.vector) };
    try {
      await this.app.vault.adapter.write(this.cachePath, JSON.stringify(obj));
      this.dirty = false;
    } catch (e) {
      console.error("[ties] emb cache save failed", e);
    }
  }

  private fresh(file: TFile): boolean {
    const e = this.map.get(file.path);
    return !!e && e.mtime === file.stat.mtime;
  }

  private async embedFile(file: TFile): Promise<Float32Array> {
    const body = stripFrontmatter(await this.app.vault.cachedRead(file)).slice(0, 4000);
    const vec = await embed(`${file.basename}\n\n${body}`, this.cfg());
    this.map.set(file.path, { mtime: file.stat.mtime, vector: vec });
    this.dirty = true;
    return vec;
  }

  async ensure(file: TFile): Promise<Float32Array> {
    if (this.fresh(file)) return this.map.get(file.path)!.vector;
    return this.embedFile(file);
  }

  async build(
    files: TFile[],
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    let done = 0;
    for (const f of files) {
      if (!this.fresh(f)) {
        try {
          await this.embedFile(f);
        } catch (e) {
          console.error("[ties] embed failed", f.path, e);
        }
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
      scored.push({ path: p, score: cosine(query, e.vector) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
  }
}
