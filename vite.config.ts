import { defineConfig } from "vite";
import { gzipSync, brotliCompressSync } from "node:zlib";
import react from "@vitejs/plugin-react";

// The player UI is built once into dist/client and served by the CLI's server.
export default defineConfig({
  root: "client",
  plugins: [react(), {
    name: "precompress-player-assets",
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (!/\.(js|css)$/.test(fileName)) continue;
        const source = output.type === "chunk" ? output.code : output.source;
        this.emitFile({ type: "asset", fileName: `${fileName}.gz`, source: gzipSync(source) });
        this.emitFile({ type: "asset", fileName: `${fileName}.br`, source: brotliCompressSync(source) });
      }
    },
  }],
  build: { outDir: "../dist/client", emptyOutDir: true },
});
