import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The player UI is built once into dist/client and served by the CLI's server.
export default defineConfig({
  root: "client",
  plugins: [react()],
  build: { outDir: "../dist/client", emptyOutDir: true },
});
