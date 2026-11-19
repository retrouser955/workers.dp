import { defineConfig } from "tsdown";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        worker: "src/worker/voice-processor.worker.ts"
    },
    outDir: "dist",
    format: ["esm", "cjs"],
    platform: "node",
    dts: true,
    clean: true,
    sourcemap: true,
    hash: false,
    outExtensions({ format }) {
        if (format === "es") {
            return { js: ".mjs", dts: ".d.mts" };
        }

        return { js: ".cjs", dts: ".d.cts" };
    },
    deps: {
        neverBundle: true,
        resolveDepSubpath: true
    }
});
