import { App, TFile } from "obsidian";
import { embed, stripFrontmatter, cosine, EmbedConfig } from "./embeddings";

interface Entry {
  hash: string;
  model: string;
  vector: Float32Array;
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

// Бинарный формат кэша (little-endian):
//   "TIES" | ver:u8 | count:u32
//   для каждой записи: pathLen:u16, path | hashLen:u8, hash | modelLen:u8, model | dim:u16 | dim*f32
const MAGIC = [0x54, 0x49, 0x45, 0x53]; // "TIES"

function encode(map: Map<string, Entry>): ArrayBuffer {
  const enc = new TextEncoder();
  const rows: Array<{ path: Uint8Array; hash: Uint8Array; model: Uint8Array; vec: Float32Array }> = [];
  let size = 4 + 1 + 4;
  for (const [p, e] of map) {
    const path = enc.encode(p);
    const hash = enc.encode(e.hash);
    const model = enc.encode(e.model);
    size += 2 + path.length + 1 + hash.length + 1 + model.length + 2 + e.vector.length * 4;
    rows.push({ path, hash, model, vec: e.vector });
  }
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let o = 0;
  for (const b of MAGIC) u8[o++] = b;
  dv.setUint8(o, 1); o += 1;
  dv.setUint32(o, rows.length, true); o += 4;
  for (const r of rows) {
    dv.setUint16(o, r.path.length, true); o += 2; u8.set(r.path, o); o += r.path.length;
    dv.setUint8(o, r.hash.length); o += 1; u8.set(r.hash, o); o += r.hash.length;
    dv.setUint8(o, r.model.length); o += 1; u8.set(r.model, o); o += r.model.length;
    dv.setUint16(o, r.vec.length, true); o += 2;
    for (let i = 0; i < r.vec.length; i++) { dv.setFloat32(o, r.vec[i], true); o += 4; }
  }
  return buf;
}

function decode(buf: ArrayBuffer): Map<string, Entry> {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const dec = new TextDecoder();
  if (u8[0] !== MAGIC[0] || u8[1] !== MAGIC[1] || u8[2] !== MAGIC[2] || u8[3] !== MAGIC[3]) {
    throw new Error("bad magic");
  }
  let o = 4;
  o += 1; // version
  const count = dv.getUint32(o, true); o += 4;
  const map = new Map<string, Entry>();
  for (let n = 0; n < count; n++) {
    const pl = dv.getUint16(o, true); o += 2;
    const path = dec.decode(u8.subarray(o, o + pl)); o += pl;
    const hl = dv.getUint8(o); o += 1;
    const hash = dec.decode(u8.subarray(o, o + hl)); o += hl;
    const ml = dv.getUint8(o); o += 1;
    const model = dec.decode(u8.subarray(o, o + ml)); o += ml;
    const dim = dv.getUint16(o, true); o += 2;
    const vector = new Float32Array(dim);
    for (let i = 0; i < dim; i++) { vector[i] = dv.getFloat32(o, true); o += 4; }
    map.set(path, { hash, model, vector });
  }
  return map;
}

// Индекс эмбеддингов заметок с бинарным кэшем на диск.
// Инвалидация по хэшу содержимого (переносимо между устройствами) + метка модели.
export class EmbeddingIndex {
  private app: App;
  private cachePath: string;
  private cfg: () => EmbedConfig;
  private map = new Map<string, Entry>();
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
        const buf = await this.app.vault.adapter.readBinary(this.cachePath);
        this.map = decode(buf);
      }
    } catch (e) {
      console.error("[ties] emb cache load failed", e);
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await this.app.vault.adapter.writeBinary(this.cachePath, encode(this.map));
      this.dirty = false;
    } catch (e) {
      console.error("[ties] emb cache save failed", e);
    }
  }

  // Перенести кэш в другой путь (сохранить туда, старый файл удалить).
  async relocate(newPath: string): Promise<void> {
    if (!newPath || newPath === this.cachePath) return;
    const old = this.cachePath;
    this.cachePath = newPath;
    this.dirty = true;
    await this.save();
    try {
      if (await this.app.vault.adapter.exists(old)) await this.app.vault.adapter.remove(old);
    } catch {
      /* старый файл мог отсутствовать */
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
      if (e.vector.length !== query.length) continue; // другая модель/размерность
      scored.push({ path: p, score: cosine(query, e.vector) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
  }
}
