import esbuild from "esbuild";
import process from "process";
import { readFileSync } from "fs";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

// Вшиваем исходник standalone-индексера, чтобы плагин мог разложить его в папку кэша.
const indexerSource = readFileSync("indexer/ties-indexer.mjs", "utf8");

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  define: { __INDEXER_SOURCE__: JSON.stringify(indexerSource) },
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
