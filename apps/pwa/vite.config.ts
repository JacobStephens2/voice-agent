import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import { originSecurityHeaders } from "@voice-agent/contracts";

export default defineConfig({
  preview: {
    headers: originSecurityHeaders,
    proxy: {
      "/api": "http://127.0.0.1:4184",
    },
  },
  server: {
    headers: originSecurityHeaders,
  },
  plugins: [
    react(),
    VitePWA({
      manifest: {
        background_color: "#f4f0e8",
        description: "Private voice-led operations and Evidence Records",
        display: "standalone",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
        name: "Voice Agent",
        short_name: "Voice Agent",
        start_url: "/",
        theme_color: "#15271f",
      },
      registerType: "autoUpdate",
      workbox: {
        cleanupOutdatedCaches: true,
        globPatterns: ["**/*.{css,html,js,png,svg,webmanifest}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//u],
        runtimeCaching: [],
      },
    }),
  ],
});
