import { defineConfig } from "vite";

/**
 * Dev-only static host for the dashboard UI. The browser talks same-origin to
 * Vite; Vite forwards API paths to the Fastify backend. That keeps the session
 * cookie working and avoids CORS entirely — the backend needs zero changes
 * (no CORS headers, no static serving, no new routes).
 */
const API = process.env.SOUNDVERSE_API ?? "http://localhost:3000";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/auth": { target: API, changeOrigin: true },
      "/keys": { target: API, changeOrigin: true },
      "/audit-log": { target: API, changeOrigin: true },
      "/v1": { target: API, changeOrigin: true },
    },
  },
});
