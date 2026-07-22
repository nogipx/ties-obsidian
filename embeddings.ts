import { requestUrl } from "obsidian";

export interface EmbedConfig {
  url: string; // http://localhost:11434
  model: string; // bge-m3
}

// Убрать YAML-frontmatter перед эмбеддингом (не встраиваем метаданные/связи)
export function stripFrontmatter(text: string): string {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const nl = text.indexOf("\n", end + 1);
      return nl !== -1 ? text.slice(nl + 1) : "";
    }
  }
  return text;
}

export async function embed(text: string, cfg: EmbedConfig): Promise<Float32Array> {
  const base = cfg.url.replace(/\/+$/, "");
  const res = await requestUrl({
    url: `${base}/api/embeddings`,
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({ model: cfg.model, prompt: text }),
  });
  const emb = (res.json as any)?.embedding;
  if (!Array.isArray(emb) || emb.length === 0) {
    throw new Error("Ollama вернул пустой embedding");
  }
  return Float32Array.from(emb);
}

// bge-m3 не нормализует — считаем полный косинус
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
