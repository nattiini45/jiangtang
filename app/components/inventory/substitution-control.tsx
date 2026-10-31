import { Form, useNavigation } from "react-router";
import { Select } from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { useT } from "~/i18n/use-t";

interface Unit {
  id: string;
  name: string | null;
  assetTag: string | null;
}

/** Set or clear this unit as the spare substituting for a faulty unit. */
export function SubstitutionControl({
  current,
  targets,
  error,
}: {
  current: Unit | null;
  targets: Unit[];
  error?: string;
}) {
  const t = useT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const label = (u: Unit) => `${u.name ?? u.id}${u.assetTag ? ` (${u.assetTag})` : ""}`;

  return (
    <div className="border-border border p-3">
      <p className="text-muted-foreground text-xs uppercase tracking-wide">
        {t("inventory.substitution.heading")}
      </p>
      {error ? (
        <p className="text-destructive mt-1 text-xs" role="alert">
          {error}
        </p>
      ) : null}
      {current ? (
        <Form method="post" className="mt-2 flex flex-wrap items-center gap-2">
          <input type="hidden" name="_action" value="clearSubstitution" />
          <span className="text-sm">
            {t("inventory.substitution.replacing")}{" "}
            <span className="font-mono">{label(current)}</span>
          </span>
          <Button type="submit" variant="ghost" size="sm" disabled={busy}>
            {t("inventory.substitution.clear")}
          </Button>
        </Form>
      ) : (
        <Form method="post" className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="_action" value="setSubstitution" />
          <Select name="faultyId" defaultValue="" className="max-w-sm">
            <option value="">{t("inventory.substitution.choose")}</option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {label(target)}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="outline" size="sm" disabled={busy || targets.length === 0}>
            {t("inventory.substitution.set")}
          </Button>
        </Form>
      )}
    </div>
  );
}
