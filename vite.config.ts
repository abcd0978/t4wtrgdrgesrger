import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer uses `?worker&inline` and `?url` (WASM) imports — vite supports both natively.
export default defineConfig({
  plugins: [react()],
  server: { host: true }, // expose on LAN/Tailscale for dev preview
  build: {
    rollupOptions: {
      output: {
        // Split the big, rarely-changing vendor libraries into their own chunks
        // so they download in parallel and stay cached across app deploys (the
        // app chunk changes; three/react don't). Order matters: match
        // @react-three before the bare "react"/"three" substrings.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@react-three")) return "r3f";
          if (id.includes("node_modules/three/")) return "three";
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom") || id.includes("node_modules/scheduler")) return "react";
          return "vendor";
        },
      },
    },
  },
});
