import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";
import react from "@vitejs/plugin-react";

// The player UI is built once into dist/client and served by the CLI's server.
export default defineConfig({
  root: "client",
  plugins: [react(), {
    name: "precompress-player-assets",
    // Compress what was written, after Vite has filled in its dynamic-import preload helper
    // (compressing in generateBundle would capture placeholders in lazily loaded chunks).
    writeBundle(options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (!/\.(js|css)$/.test(fileName)) continue;
        const file = path.join(options.dir!, fileName);
        const source = fs.readFileSync(file);
        fs.writeFileSync(`${file}.gz`, gzipSync(source));
        fs.writeFileSync(`${file}.br`, brotliCompressSync(source));
      }
    },
  }],
  // axe-core (the accessibility scan) is a ~580 kB chunk, loaded only when a scan runs.
  build: { outDir: "../dist/client", emptyOutDir: true, chunkSizeWarningLimit: 700 },
});
