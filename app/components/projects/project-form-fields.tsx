import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { projectStatusLabel, PROJECT_STATUSES } from "./labels";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Shared field block for the project create + edit forms, bound to
 * `projectCreateSchema` / `projectEditSchema` (`app/domains/projects/`).
 *
 * **`status` renders only on the create form** (`includeStatus`): on edit the
 * field is absent from the schema by design — a transition goes through
 * `setProjectStatus` so it is audited as `ProjectStatusChanged`, not folded
 * into a generic update.
 */
export interface ProjectFormDefaults {
  name?: string | null;
  description?: string | null;
  status?: string | null;
  color?: string | null;
  /** `yyyy-mm-dd` strings — the `en-CA`/Berlin format, not `Date`. */
  startAt?: string | null;
  dueAt?: string | null;
  leadId?: string | null;
  parentProjectId?: string | null;
}

export interface ProjectOption {
  id: string;
  name: string;
}

export function ProjectFormFields({
  defaults,
  leads,
  parents,
  includeStatus = false,
}: {
  defaults?: ProjectFormDefaults;
  /** User rows for the lead picker. */
  leads?: ProjectOption[];
  /** Projects this one could sit under (create + edit; self excluded by the caller). */
  parents?: ProjectOption[];
  includeStatus?: boolean;
}) {
  const locale = useLocale();
  const t = useT();
  return (
    <>
      <FormField name="name" label={t("projects.form.name")}>
        <Input
          name="name"
          defaultValue={defaults?.name ?? ""}
          required
          placeholder={t("projects.form.namePlaceholder")}
        />
      </FormField>

      {includeStatus ? (
        <FormField name="status" label={t("projects.form.status")}>
          <Select name="status" defaultValue={defaults?.status ?? "REQUESTED"}>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {projectStatusLabel(locale, s)}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}

      <FormField
        name="description"
        label={t("projects.form.description")}
        hint={t("common.optional")}
      >
        <Textarea name="description" defaultValue={defaults?.description ?? ""} rows={3} />
      </FormField>

      {/* A text input, not `type="color"`: a color control cannot be empty, and
          an always-submitted value would silently write a colour the user never
          chose. Blank means "no color". */}
      <FormField name="color" label={t("projects.form.color")} hint={t("projects.form.colorHint")}>
        <Input
          name="color"
          defaultValue={defaults?.color ?? ""}
          placeholder="#2f6feb"
          className="font-mono"
        />
      </FormField>

      <div className="grid grid-cols-2 gap-2">
        <FormField name="startAt" label={t("projects.form.startAt")} hint={t("common.optional")}>
          <Input name="startAt" type="date" defaultValue={defaults?.startAt ?? ""} />
        </FormField>
        <FormField
          name="dueAt"
          label={t("projects.form.dueAt")}
          hint={t("projects.form.dueAtHint")}
        >
          <Input name="dueAt" type="date" defaultValue={defaults?.dueAt ?? ""} />
        </FormField>
      </div>

      {leads ? (
        <FormField name="leadId" label={t("projects.form.lead")} hint={t("common.optional")}>
          <Select name="leadId" defaultValue={defaults?.leadId ?? ""}>
            <option value="">—</option>
            {leads.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}

      {parents ? (
        <FormField
          name="parentProjectId"
          label={t("projects.form.parent")}
          hint={t("projects.form.parentHint")}
        >
          <Select name="parentProjectId" defaultValue={defaults?.parentProjectId ?? ""}>
            <option value="">{t("projects.form.rootOption")}</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}
    </>
  );
}
