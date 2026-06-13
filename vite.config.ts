import { resolve } from "node:path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

// Library build (geo-* recipe): a single `.` entry (the only `exports`
// subpath). `preserveModules: true` keeps the source module layout in `dist/`
// (per-module, tree-shakeable output) and `vite-plugin-dts` emits a `.d.ts`
// per module. `ssr: true` targets the runtime and externalises bare imports
// (`@hwcharlton/geo-model`, `@hwcharlton/geo-client`) rather than bundling
// them. deck.gl is never imported here — its layer ctors are injected — so it
// is not part of the dependency graph at all (ADR-017).
export default defineConfig({
  build: {
    ssr: true,
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      output: {
        preserveModules: true,
        entryFileNames: "[name].js",
      },
    },
  },
  plugins: [dts()],
});
