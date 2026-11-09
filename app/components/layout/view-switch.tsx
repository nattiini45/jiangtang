import { Form, useLocation } from "react-router";
import { useT } from "~/i18n/use-t";

export function ViewSwitch({
  view,
  next,
  className,
  style,
  children,
  desktopLabel = false,
}: {
  view: "desktop" | "mobile";
  next?: string;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  desktopLabel?: boolean;
}) {
  const location = useLocation();
  const t = useT();
  return (
    <Form method="post" action="/prefs/view" reloadDocument>
      <input type="hidden" name="view" value={view} />
      <input
        type="hidden"
        name="next"
        value={next ?? location.pathname + location.search + location.hash}
      />
      <button
        type="submit"
        className={className}
        style={style}
        title={t(view === "desktop" ? "shell.view.desktop" : "shell.view.mobile")}
      >
        {children ?? t(view === "desktop" ? "shell.view.desktop" : "shell.view.mobile")}
        {desktopLabel ? (
          <span className="text-muted-foreground block text-xs">
            {t("shell.view.desktopLabel")}
          </span>
        ) : null}
      </button>
    </Form>
  );
}
