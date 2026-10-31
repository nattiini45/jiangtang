import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteLoaderData,
} from "react-router";
import type { Route } from "./+types/root";
import { resolveLocale } from "~/i18n/locale.server";
import { useT } from "~/i18n/use-t";
import { getDensity, getTheme } from "~/lib/theme.server";
import "./app.css";

export const links: Route.LinksFunction = () => [
  // PWA manifest + theme color. The manifest is scoped to /m/ so the
  // desktop surface isn't offered "install". theme_color matches the dark token.
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

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  const theme = data?.theme ?? "dark";
  const density = data?.density ?? "compact";
  const locale = data?.locale ?? "en";
  return (
    <html
      lang={locale}
      className={theme === "dark" ? "dark" : ""}
      data-density={density}
      suppressHydrationWarning
    >
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0a0a0a" />
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
  return <Outlet />;
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
    <main style={{ padding: "2rem", fontFamily: "monospace" }}>
      <title>{`${title} · Jiangtang`}</title>
      <h1>{message}</h1>
      <p>{detail}</p>
    </main>
  );
}
