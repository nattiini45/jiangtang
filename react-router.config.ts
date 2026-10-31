import type { Config } from "@react-router/dev/config";

export default {
  // Server-side render the desktop surface; the mobile PWA route tree opts into
  // its own service worker / manifest (added in the PWA phase).
  ssr: true,
} satisfies Config;
