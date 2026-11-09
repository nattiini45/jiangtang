import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteLoaderData,
} from "react-router";
import { MotionConfig } from "motion/react";
import type { Route } from "./+types/root";
import { resolveLocale } from "~/i18n/locale.server";
import { useT } from "~/i18n/use-t";
import { getDensity, getTheme } from "~/lib/theme.server";
import { viewMiddleware } from "~/lib/view.server";
import "./app.css";

export const middleware = [viewMiddleware];

export const links: Route.LinksFunction = () => [
  // PWA manifest + theme color. The manifest is scoped to /m/ so the
  // desktop surface isn't offered "install".
  { rel: "manifest", href: "/manifest.webmanifest" },
  { rel: "apple-touch-icon", href: "/icon-192.png" },
];

export function loader({ request }: Route.LoaderArgs) {
  return {
    theme: getTheme(request),
    density: getDensity(request),
    locale: resolveLocale(request),
  };
}

// Resolves the `system` theme before first paint and keeps following the OS
// setting. It owns the `.dark` class: a revalidated root loader re-rendering
// <html> cannot know the OS preference, so the class is re-applied whenever it or
// `data-theme` changes.
const THEME_SCRIPT = `(function(){var d=document.documentElement,m=window.matchMedia("(prefers-color-scheme: dark)");function a(){var t=d.dataset.theme,k=t==="dark"||(t!=="light"&&m.matches);if(d.classList.contains("dark")!==k)d.classList.toggle("dark",k)}a();m.addEventListener("change",a);new MutationObserver(a).observe(d,{attributes:true,attributeFilter:["class","data-theme"]})})()`;

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  const theme = data?.theme ?? "system";
  const density = data?.density ?? "comfortable";
  const locale = data?.locale ?? "en";
  return (
    <html
      lang={locale}
      className={theme === "dark" ? "dark" : ""}
      data-theme={theme}
      data-density={density}
      suppressHydrationWarning
    >
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {theme === "system" ? (
          <>
            <meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)" />
            <meta name="theme-color" content="#171717" media="(prefers-color-scheme: dark)" />
          </>
        ) : (
          <meta name="theme-color" content={theme === "dark" ? "#171717" : "#fafafa"} />
        )}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  // Reduced motion means fewer and gentler: transforms and layout animation drop,
  // opacity and color fades stay.
  return (
    <MotionConfig reducedMotion="user">
      <Outlet />
    </MotionConfig>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const t = useT();
  let message = t("common.error.title");
  let detail = t("common.error.unexpected");
  let title = message;
  if (isRouteErrorResponse(error)) {
    message = `${error.status}`;
    detail = error.statusText || detail;
    title = message;
    if (error.status === 404) {
      title = t("common.error.notFound.title");
      detail = t("common.error.notFound.detail");
    }
  } else if (import.meta.env.DEV && error instanceof Error) {
    detail = error.message;
  }
  return (
    <main className="text-muted-foreground mx-auto flex min-h-screen max-w-md flex-col justify-center gap-2 p-8 [&>h1]:text-xl [&>h1]:font-bold [&>h1]:text-foreground">
      <title>{`${title} · Jiangtang`}</title>
      <h1>{message}</h1>
      <p>{detail}</p>
    </main>
  );
}
