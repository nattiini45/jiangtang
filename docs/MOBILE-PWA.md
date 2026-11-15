# Mobile installation and updates

The mobile web app starts at `/m`, with a standalone manifest and service-worker scope `/m`.
The start shows the same five operational blocks and saved personal arrangement as the desktop
home. Quick capture is one tap away at `/m/quick-entry`; captures queued by earlier versions at
`/m?index` still replay through the original action contract.
The worker precaches the quick-entry document and loader response. Once the worker controls the
home, the shell also preloads the capture route modules, so the first offline visit can queue an
entry without needing an earlier online visit to the form. The Capture installation shortcut
opens the capture form rather than the home.
The explicit manifest identity remains `/m/`, preserving the previous start-URL-derived identity.
The scope includes the exact entry URL as well as `/m/…`. Web platform scopes use URL prefixes,
not route boundaries; the worker explicitly passes through lookalikes such as `/mobile` and
desktop navigations. Registration removes the old `/m/` registration only after the new one
succeeds. Existing controlled pages continue running; registration never reloads them.

## Install and launch

Use HTTPS (or loopback for local testing). Chromium offers a small inline install hint only after
`beforeinstallprompt`; the browser dialog opens only when the person taps **Install app**. iOS
shows localized **Share → Add to Home Screen** instructions instead. The hint is recorded as soon
as it is shown, and dismissal and installation are also remembered in local storage on that
browser/device. It never appears in standalone mode. Clearing site data resets that record;
when storage is unavailable, suppression lasts for the current page session only.

The regular 192/512px icons are separate from the opaque maskable 192/512px icons. The latter
keep the entire existing J mark inside the central 80%-diameter safe circle. iOS uses a dedicated
180px apple touch icon, standalone metadata and light/dark portrait startup images for the
declared iPhone screen sizes in `app/lib/pwa/startup-images.ts`. Other screen sizes and landscape
use the platform's normal launch fallback. Startup images follow the OS color scheme, since iOS
chooses them before the application can read its theme cookie. Chromium's static manifest launch
background uses the light floor; document/browser chrome follows the chosen light/dark theme.

Actual installation UI and OS launch screens need a physical Android/iOS check; browser event
tests verify our hint and persistence behavior, not a native installation. iOS versions and browser
menus differ, so the instructions include Safari as a fallback. No native wrapper or push service
is involved.

## Updates without interrupting captures

The worker checks for updates on registration and when the app returns to the foreground.
`updateViaCache: "none"` bypasses the HTTP cache for worker scripts. Navigations, loader data,
API reads and install-time precaches use `cache: "no-cache"` to revalidate with the server;
immutable hashed assets remain cache-first. Cached signed-in pages are an offline fallback only,
not an online stale-while-revalidate strategy. Server errors are returned as errors, not replaced
with old HTML. Existing cache names, sign-in purging, and account-owned offline captures remain
unchanged.

A worker update waits naturally. It does not call `skipWaiting`, send an activation command, or
reload a tab on `controllerchange`. Normal activation claims matching pages without reloading,
so even a first visit to the exact `/m` launch URL becomes controlled. A localized, dismissible update
notice asks the person to save current entries, finish photo uploads, close **all** Jiangtang tabs
and app windows, then reopen. Only closing the old worker's clients lets the browser activate the
replacement. This deliberately trades one-tap updating for safety across several open tabs,
in-flight capture requests, queue replay and photos held only in memory. Closing a tab before
saving its draft or finishing its uploads can still lose that unsaved work, as with any browser
page. Already saved IndexedDB captures survive the worker update and replay as before.

## Verification

The PWA Vitest suite checks manifest assets and mask-safe artwork, launch metadata, scope
migration, no-cache requests, the waiting lifecycle, offline fallback and sign-in purging. The
`e2e/pwa-install.spec.ts` browser tests synthesize Android/iOS install conditions and a waiting
update during a capture; the existing offline/photo/session/cache specs remain the end-to-end
regression gates. Lighthouse 12 and newer no longer include the PWA category. A historical
Lighthouse 11 report is only a legacy audit; current browser installability diagnostics and real
device checks are still needed.
