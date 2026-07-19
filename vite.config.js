import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        name: "Iron Log — Adaptive Strength Tracker",
        short_name: "Iron Log",
        start_url: "/",
        display: "standalone",
        background_color: "#121419",
        theme_color: "#121419",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Precache the whole built app shell (JS/CSS/HTML/icons/manifest) so
        // the app opens instantly with no signal, and fall back to the SPA
        // shell for any deep-link navigation while offline.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        navigateFallback: "index.html",
        // Deliberately NOT runtime-caching Supabase reads/writes or the
        // /api/coach call: this app already distinguishes "no data yet" from
        // "load failed" (see loadProgramState/decideScreen in src/engine.js)
        // to avoid ever rendering onboarding over a real account whose data
        // just failed to load. Serving a stale cached API response instead of
        // that real failure would silently reintroduce that exact class of
        // bug — showing yesterday's (or someone else's session-swapped)
        // training state as if it were current. Offline means the shell
        // loads instantly from cache; a live session is still required to
        // read/write actual training data.
      },
    }),
  ],
  server: {
    port: 5173,
  },
});
