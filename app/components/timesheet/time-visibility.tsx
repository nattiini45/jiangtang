import { useT } from "~/i18n/use-t";

export function TimeVisibility({ viewers }: { viewers: { id: string; name: string }[] }) {
  const t = useT();
  return (
    <p className="text-muted-foreground text-sm">
      {viewers.length
        ? t("timesheet.visibility.people", {
            names: viewers.map((person) => person.name).join(", "),
          })
        : t("timesheet.visibility.onlyYou")}
    </p>
  );
}
