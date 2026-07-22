#!/usr/bin/env node
// Ties embeddings indexer — self-contained, без зависимостей (Node 18+).
// Считает эмбеддинги заметок вульта через Ollama и пишет ties-embeddings.bin
// в формате, байт-совместимом с плагином Ties. Единственный писатель кэша.
//
// Запуск на сервере (рядом с синхронизированным вультом):
//   node ties-indexer.mjs            # один проход
//   node ties-indexer.mjs --watch    # периодический инкрементальный проход
//
// Конфиг через env (все опциональны):
//   TIES_VAULT     корень вульта            (по умолчанию: родитель папки скрипта)
//   TIES_CACHE     папка для .bin           (по умолчанию: папка скрипта)
//   TIES_OLLAMA    адрес Ollama             (по умолчанию: http://127.0.0.1:11434)
//   TIES_MODEL     модель эмбеддингов       (по умолчанию: bge-m3)
//   TIES_INTERVAL  период watch, сек        (по умолчанию: 30)
//   TIES_MAXCHARS  срез тела заметки        (по умолчанию: 4000)

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.resolve(process.env.TIES_VAULT || path.resolve(HERE, ".."));
const CACHE_DIR = path.resolve(process.env.TIES_CACHE || HERE);
const CACHE_FILE = path.join(CACHE_DIR, "ties-embeddings.bin");
const OLLAMA = (process.env.TIES_OLLAMA || "http://127.0.0.1:11434")
  .replace(/\/+$/, "")
  .replace("://localhost", "://127.0.0.1");
const MODEL = process.env.TIES_MODEL || "bge-m3";
const MAXCHARS = Number(process.env.TIES_MAXCHARS || 4000);
const INTERVAL = Number(process.env.TIES_INTERVAL || 30) * 1000;
const WATCH = process.argv.includes("--watch") || process.env.TIES_WATCH === "1";

// --- те же примитивы, что в плагине (должны совпадать 1-в-1) ---

function stripFrontmatter(text) {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const nl = text.indexOf("\n", end + 1);
      return nl !== -1 ? text.slice(nl + 1) : "";
    }
  }
  return text;
}

function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// --- бинарный формат кэша (little-endian), идентичный embIndex.ts ---
// "TIES" | ver:u8 | count:u32 | { pathLen:u16, path | hashLen:u8, hash | modelLen:u8, model | dim:u16 | dim*f32 }

function encode(map) {
  const keys = [...map.keys()].sort();
  const chunks = [];
  const header = Buffer.alloc(9);
  header.write("TIES", 0, "ascii");
  header.writeUInt8(1, 4);
  header.writeUInt32LE(keys.length, 5);
  chunks.push(header);
  for (const p of keys) {
    const e = map.get(p);
    const pathB = Buffer.from(p, "utf8");
    const hashB = Buffer.from(e.hash, "utf8");
    const modelB = Buffer.from(e.model, "utf8");
    const dim = e.vector.length;
    const b = Buffer.alloc(2 + pathB.length + 1 + hashB.length + 1 + modelB.length + 2 + dim * 4);
    let o = 0;
    b.writeUInt16LE(pathB.length, o); o += 2; pathB.copy(b, o); o += pathB.length;
    b.writeUInt8(hashB.length, o); o += 1; hashB.copy(b, o); o += hashB.length;
    b.writeUInt8(modelB.length, o); o += 1; modelB.copy(b, o); o += modelB.length;
    b.writeUInt16LE(dim, o); o += 2;
    for (let i = 0; i < dim; i++) { b.writeFloatLE(e.vector[i], o); o += 4; }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function decode(buf) {
  if (buf.length < 9 || buf.toString("ascii", 0, 4) !== "TIES") throw new Error("bad magic");
  let o = 4;
  o += 1; // version
  const count = buf.readUInt32LE(o); o += 4;
  const map = new Map();
  for (let n = 0; n < count; n++) {
    const pl = buf.readUInt16LE(o); o += 2;
    const p = buf.toString("utf8", o, o + pl); o += pl;
    const hl = buf.readUInt8(o); o += 1;
    const hash = buf.toString("utf8", o, o + hl); o += hl;
    const ml = buf.readUInt8(o); o += 1;
    const model = buf.toString("utf8", o, o + ml); o += ml;
    const dim = buf.readUInt16LE(o); o += 2;
    const vector = new Float32Array(dim);
    for (let i = 0; i < dim; i++) { vector[i] = buf.readFloatLE(o); o += 4; }
    map.set(p, { hash, model, vector });
  }
  return map;
}

// --- обход вульта ---

async function walk(dir, rel = "") {
  const out = [];
  let ents;
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(abs, r)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(r);
  }
  return out;
}

async function buildInput(rel) {
  const text = await fs.readFile(path.join(VAULT, rel), "utf8");
  const body = stripFrontmatter(text).slice(0, MAXCHARS);
  const base = path.basename(rel, path.extname(rel));
  return `${base}\n\n${body}`;
}

async function embed(text) {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const j = await res.json();
  const emb = j?.embedding;
  if (!Array.isArray(emb) || emb.length === 0) throw new Error("empty embedding");
  return emb;
}

async function atomicWrite(map) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  await fs.writeFile(tmp, encode(map));
  await fs.rename(tmp, CACHE_FILE);
}

async function runOnce() {
  let map = new Map();
  if (fssync.existsSync(CACHE_FILE)) {
    try {
      map = decode(await fs.readFile(CACHE_FILE));
    } catch (e) {
      console.warn("[ties-indexer] cache unreadable, rebuilding:", e.message);
      map = new Map();
    }
  }
  const files = await walk(VAULT);
  const present = new Set(files);
  let computed = 0, cached = 0, failed = 0;
  for (const rel of files) {
    let input;
    try {
      input = await buildInput(rel);
    } catch {
      continue;
    }
    const hash = hashStr(input);
    const e = map.get(rel);
    if (e && e.hash === hash && e.model === MODEL) {
      cached++;
      continue;
    }
    try {
      const vector = await embed(input);
      map.set(rel, { hash, model: MODEL, vector });
      computed++;
      if (computed % 20 === 0) await atomicWrite(map);
    } catch (err) {
      failed++;
      console.warn("[ties-indexer] embed failed:", rel, "-", err.message);
    }
  }
  for (const k of [...map.keys()]) if (!present.has(k)) map.delete(k);
  await atomicWrite(map);
  console.log(
    `[ties-indexer] files=${files.length} computed=${computed} cached=${cached} failed=${failed} total=${map.size} -> ${CACHE_FILE}`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`[ties-indexer] vault=${VAULT}`);
console.log(`[ties-indexer] cache=${CACHE_FILE}`);
console.log(`[ties-indexer] ollama=${OLLAMA} model=${MODEL}`);

if (WATCH) {
  console.log(`[ties-indexer] watch: каждые ${INTERVAL / 1000}s`);
  for (;;) {
    try {
      await runOnce();
    } catch (e) {
      console.error("[ties-indexer] run error:", e.message);
    }
    await sleep(INTERVAL);
  }
} else {
  await runOnce();
}
