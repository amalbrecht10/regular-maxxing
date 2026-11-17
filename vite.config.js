import { defineConfig } from "vite";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

// Writes dist/sw.js with the exact list of built files, so the app opens offline
// on the very first launch after install. The version is a hash of the file list
// and contents, so any change produces a new service worker and a fresh cache.
function serviceWorker() {
  return {
    name: "regular-maxing-service-worker",
    apply: "build",
    // Run after Vite has emitted index.html, so it lands in the precache list.
    enforce: "post",
    generateBundle(_options, bundle) {
      const publicFiles = listFiles("public").map((f) =>
        relative("public", f).split("\\").join("/"),
      );
      const bundleFiles = Object.keys(bundle).filter(
        (f) => !f.endsWith(".map"),
      );
      const files = [...new Set([...bundleFiles, ...publicFiles])].sort();
      const hash = createHash("sha256");
      for (const f of bundleFiles) {
        const chunk = bundle[f];
        hash
          .update(f)
          .update(chunk.type === "chunk" ? chunk.code : chunk.source);
      }
      for (const f of publicFiles)
        hash.update(f).update(readFileSync(join("public", f)));
      const version = hash.digest("hex").slice(0, 12);
      const precache = ["./", ...files.map((f) => "./" + f)];
      const source = readFileSync("src/sw-template.js", "utf8")
        .replace("__VERSION__", version)
        .replace("__PRECACHE__", JSON.stringify(precache, null, 2));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

// The seed record names a real person, so it must never reach the public site.
// It is compiled in only for `npm run dev` or when LOCAL_SEED=1 is set (the screenshot run),
// and only if the git-ignored seed.local.json exists. The deploy workflow also fails if
// seed content shows up in dist/.
function seedFor(mode) {
  const wanted = mode === "development" || process.env.LOCAL_SEED === "1";
  if (!wanted || !existsSync("seed.local.json")) return "null";
  return JSON.stringify(JSON.parse(readFileSync("seed.local.json", "utf8")));
}

export default defineConfig(({ mode }) => ({
  // Relative base so the same build works at https://<user>.github.io/<repo>/ and locally.
  base: "./",
  plugins: [serviceWorker()],
  build: { target: "safari15", sourcemap: false },
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __LOCAL_SEED__: seedFor(mode),
  },
}));
