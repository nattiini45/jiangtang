import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { useT } from "~/i18n/use-t";
import { maybeRegisterServiceWorker } from "~/lib/pwa/register-sw";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const INSTALL_KEY = "jiangtang-pwa-install-v1";
let seenInSession = false;

function hasSeenInstallHint() {
  try {
    return seenInSession || localStorage.getItem(INSTALL_KEY) !== null;
  } catch {
    return seenInSession;
  }
}

function rememberInstallHint(state: "shown" | "dismissed" | "installed") {
  seenInSession = true;
  try {
    localStorage.setItem(INSTALL_KEY, state);
  } catch {
    return;
  }
}

export function PwaNotices() {
  const t = useT();
  const [updateReady, setUpdateReady] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [installHint, setInstallHint] = useState<"android" | "ios" | null>(null);
  const [prompting, setPrompting] = useState(false);
  const installPrompt = useRef<InstallPromptEvent | null>(null);

  useEffect(() => maybeRegisterServiceWorker(() => setUpdateReady(true)), []);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)");
    const isStandalone = () =>
      standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone;
    const show = (kind: "android" | "ios") => {
      if (hasSeenInstallHint() || isStandalone()) return;
      rememberInstallHint("shown");
      setInstallHint(kind);
    };
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      if (hasSeenInstallHint() || isStandalone()) return;
      installPrompt.current = event as InstallPromptEvent;
      show("android");
    };
    const installed = () => {
      rememberInstallHint("installed");
      installPrompt.current = null;
      setInstallHint(null);
    };
    const displayChanged = () => {
      if (isStandalone()) installed();
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== INSTALL_KEY || !event.newValue) return;
      installPrompt.current = null;
      setInstallHint(null);
    };
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", installed);
    window.addEventListener("storage", storageChanged);
    standalone.addEventListener("change", displayChanged);
    const ios =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (isStandalone()) installed();
    else if (ios) show("ios");
    return () => {
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", installed);
      window.removeEventListener("storage", storageChanged);
      standalone.removeEventListener("change", displayChanged);
    };
  }, []);

  const finishInstallHint = (state: "dismissed" | "installed") => {
    rememberInstallHint(state);
    installPrompt.current = null;
    setInstallHint(null);
  };
  const install = async () => {
    const prompt = installPrompt.current;
    if (!prompt) return;
    setPrompting(true);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      finishInstallHint(choice.outcome === "accepted" ? "installed" : "dismissed");
    } catch {
      finishInstallHint("dismissed");
    } finally {
      setPrompting(false);
    }
  };

  if (updateReady && !updateDismissed) {
    return (
      <aside aria-label={t("pwa.update.title")} className="border-b px-4 py-3">
        <p role="status" className="font-semibold">
          {t("pwa.update.title")}
        </p>
        <p className="text-muted-foreground mt-1">{t("pwa.update.body")}</p>
        <Button
          type="button"
          variant="ghost"
          className="mt-2 min-h-11"
          onClick={() => setUpdateDismissed(true)}
        >
          {t("pwa.update.dismiss")}
        </Button>
      </aside>
    );
  }
  if (!installHint) return null;
  return (
    <aside aria-label={t("pwa.install.title")} className="border-b px-4 py-3">
      <p className="font-semibold">{t("pwa.install.title")}</p>
      <p className="text-muted-foreground mt-1">
        {t(installHint === "ios" ? "pwa.install.ios" : "pwa.install.android")}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {installHint === "android" ? (
          <Button
            type="button"
            variant="secondary"
            className="min-h-11"
            disabled={prompting}
            onClick={() => void install()}
          >
            {t("pwa.install.action")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          disabled={prompting}
          onClick={() => finishInstallHint("dismissed")}
        >
          {t("pwa.install.dismiss")}
        </Button>
      </div>
    </aside>
  );
}
