import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function appShellWorker(): Plugin {
  return {
    name: "kleepee-app-shell",
    apply: "build" as const,
    generateBundle(_options, bundle) {
      const template = readFileSync(new URL("./src/pwa/service-worker.js", import.meta.url), "utf8");
      const publicAssets = [
        "manifest.webmanifest", "icon-192.png", "icon-512.png",
        "apple-touch-icon.png", "favicon.ico", "favicon-32x32.png", "favicon-16x16.png",
      ];
      const assets = [
        "/index.html",
        ...Object.keys(bundle)
          .filter((name) => name.startsWith("assets/") && !name.endsWith(".map"))
          .map((name) => `/${name}`),
        ...publicAssets.map((name) => `/${name}`),
      ];
      const hash = createHash("sha256").update(template);
      hash.update(readFileSync(new URL("./index.html", import.meta.url)));
      for (const entry of Object.values(bundle)) hash.update(entry.type === "chunk" ? entry.code : entry.source);
      for (const name of publicAssets) hash.update(readFileSync(new URL(`./public/${name}`, import.meta.url)));
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template
          .replace("__PRECACHE__", JSON.stringify(assets))
          .replace("__CACHE_NAME__", JSON.stringify(`kleepee-shell-${hash.digest("hex").slice(0, 16)}`)),
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), appShellWorker()],
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
