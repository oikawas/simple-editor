import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Each production build takes the next build number (scripts/next-build-number.sh).
function buildNumber(command: string): string {
  if (command !== "build") return "dev";
  const script = new URL("../scripts/next-build-number.sh", import.meta.url).pathname;
  return execFileSync("sh", [script], { encoding: "utf8" }).trim();
}

export default defineConfig(({ command }) => ({
  define: { __BUILD_NUMBER__: JSON.stringify(buildNumber(command)) },
  server: {
    // During development, forward API and sync traffic to the local server.
    proxy: {
      "/api": "http://localhost:8080",
      "/sync": { target: "ws://localhost:8080", ws: true },
    },
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Simple Editor",
        short_name: "Notes",
        description: "Self-hosted plain-text notes",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        display: "standalone",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//, /^\/sync/],
      },
    }),
  ],
}));
