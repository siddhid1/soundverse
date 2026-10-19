import { defineConfig } from "vite";

/**
 * Dev-only static host for the operator console. Separate origin (:5174) from
 * the user console (:5173) so operator and user browsing contexts never share
 * cookies or page-memory keys. The browser talks same-origin to Vite; Vite
 * forwards API paths to the Fastify backend — no CORS, backend untouched.
 *
 * No backend changes were made for this console: it calls the existing
 * account-scoped GET /v1/monitoring once per pasted key and aggregates
 * client-side, in page memory only.
 */
const API = process.env.SOUNDVERSE_API ?? "http://localhost:3000";

export default defineConfig({
  server: {
    port: 5174,
    proxy: {
      "/auth": { target: API, changeOrigin: true },
      "/keys": { target: API, changeOrigin: true },
      "/audit-log": { target: API, changeOrigin: true },
      "/v1": { target: API, changeOrigin: true },
    },
  },
  preview: {
    port: 5174,
  },
});
