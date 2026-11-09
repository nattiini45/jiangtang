import type { pwaDe } from "../de/pwa";

export const pwaEn = {
  "pwa.install.title": "Use Jiangtang as an app",
  "pwa.install.android": "Open capture directly from your home screen.",
  "pwa.install.ios":
    "Tap Share in your browser, then Add to Home Screen. If that option is missing, open this page in Safari.",
  "pwa.install.action": "Install app",
  "pwa.install.dismiss": "Dismiss hint",
  "pwa.update.title": "Update available",
  "pwa.update.body":
    "Save your entries and wait for all photos to finish uploading. Then close every Jiangtang tab and app window and reopen the app. Saved offline entries will be kept.",
  "pwa.update.dismiss": "Later",
} satisfies Record<keyof typeof pwaDe, string>;
