import type { Config } from "@react-router/dev/config";

export default {
  // Server-side render the desktop surface; the mobile PWA route tree opts into
  // its own service worker / manifest.
  ssr: true,
  future: {
    v8_middleware: true,
    // Seed Vite's dependency scan with every route module. Without it the dev
    // server finds dependencies only as pages are first visited, re-bundles
    // them and force-reloads the open page, which tears down E2E tests mid-read.
    unstable_optimizeDeps: true,
  },
} satisfies Config;
