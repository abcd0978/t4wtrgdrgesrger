import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer uses `?worker&inline` and `?url` (WASM) imports — vite supports both natively.
export default defineConfig({
  plugins: [react()],
  server: { host: true }, // expose on LAN/Tailscale for dev preview
});
