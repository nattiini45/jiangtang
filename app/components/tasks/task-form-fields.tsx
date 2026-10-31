import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { TASK_PRIORITIES, taskPriorityLabel, TASK_STATUSES, taskStatusLabel } from "./labels";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Shared field block for the task create + edit forms, bound to
 * `taskCreateSchema` / `taskEditSchema` (`app/domains/tasks/`).
 *
 * **`status` renders only on the create form** (`includeStatus`): on edit the
 * field is absent from the schema by design — a transition goes through
 * `setTaskStatus`/`moveTask` so it is audited `TaskStatusChanged`/`TaskMoved`,
 * not folded into a generic update (the `updateProject` division of labour).
 *
 * **`labels` renders one input per label plus ONE empty one to add** — the
 * `tags` pitfall: the schema trims, drops blanks and dedupes, so the empty
 * box can never reject the save. `formDataToObject` collapses the repeated
 * `labels` key into an array (one input stays a bare string; both are handled).
 */
export interface TaskFormDefaults {
  title?: string | null;
  body?: string | null;
  status?: string | null;
  priority?: string | null;
  /** `yyyy-mm-dd` strings — the `en-CA`/Berlin format, not `Date`. */
  startAt?: string | null;
  dueAt?: string | null;
  estimateMinutes?: number | null;
  projectId?: string | null;
  parentTaskId?: string | null;
  locationId?: string | null;
  labels?: string[];
}

export interface TaskOption {
  id: string;
  name: string;
}

export function TaskFormFields({
  defaults,
  projects,
  parents,
  locations,
  includeStatus = false,
  titleAutoFocus = false,
}: {
  defaults?: TaskFormDefaults;
  /** `{id, name}` rows for the project picker. */
  projects?: TaskOption[];
  /** Tasks this one could sit under (create + edit; self excluded by the caller). */
  parents?: TaskOption[];
  /** `{id, name}` rows for the location picker. */
  locations?: TaskOption[];
  includeStatus?: boolean;
  /** `/tasks/new` autofocuses the title so the palette flow is keys-only. */
  titleAutoFocus?: boolean;
}) {
  const locale = useLocale();
  const t = useT();
  const labels = [...(defaults?.labels ?? []), ""];
  const optional = t("common.optional");
  return (
    <>
      <FormField name="title" label={t("tasks.form.title")}>
        <Input
          name="title"
          defaultValue={defaults?.title ?? ""}
          required
          autoFocus={titleAutoFocus}
          placeholder={t("tasks.form.titlePlaceholder")}
        />
      </FormField>

      {includeStatus ? (
        <FormField name="status" label={t("tasks.form.status")}>
          <Select name="status" defaultValue={defaults?.status ?? "BACKLOG"}>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {taskStatusLabel(locale, s)}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}

      <FormField name="body" label={t("tasks.form.body")} hint={optional}>
        <Textarea name="body" defaultValue={defaults?.body ?? ""} rows={4} />
      </FormField>

      <FormField name="priority" label={t("tasks.form.priority")} hint={optional}>
        <Select name="priority" defaultValue={defaults?.priority ?? ""}>
          <option value="">—</option>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {taskPriorityLabel(locale, p)}
            </option>
          ))}
        </Select>
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <FormField name="startAt" label={t("tasks.form.start")} hint={optional}>
          <Input name="startAt" type="date" defaultValue={defaults?.startAt ?? ""} />
        </FormField>
        <FormField name="dueAt" label={t("tasks.form.due")} hint={t("tasks.form.dueHint")}>
          <Input name="dueAt" type="date" defaultValue={defaults?.dueAt ?? ""} />
        </FormField>
      </div>

      <FormField
        name="estimateMinutes"
        label={t("tasks.form.estimate")}
        hint={t("tasks.form.estimateHint")}
      >
        <Input
          name="estimateMinutes"
          type="number"
          min={0}
          step={1}
          defaultValue={defaults?.estimateMinutes ?? ""}
        />
      </FormField>

      {projects ? (
        <FormField name="projectId" label={t("tasks.form.project")} hint={optional}>
          <Select name="projectId" defaultValue={defaults?.projectId ?? ""}>
            <option value="">—</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}

      {parents ? (
        <FormField
          name="parentTaskId"
          label={t("tasks.form.parent")}
          hint={t("tasks.form.parentHint")}
        >
          <Select name="parentTaskId" defaultValue={defaults?.parentTaskId ?? ""}>
            <option value="">{t("tasks.form.parentNone")}</option>
            {parents.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}

      {locations ? (
        <FormField name="locationId" label={t("tasks.form.location")} hint={optional}>
          <Select name="locationId" defaultValue={defaults?.locationId ?? ""}>
            <option value="">—</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}

      <FormField name="labels" label={t("tasks.form.labels")} hint={t("tasks.form.labelsHint")}>
        <span className="flex flex-col gap-1.5">
          {labels.map((label, i) => (
            <Input
              key={i}
              name="labels"
              defaultValue={label}
              placeholder={i === labels.length - 1 ? t("tasks.form.newLabelPlaceholder") : ""}
              aria-label={
                i === labels.length - 1
                  ? t("tasks.form.newLabel")
                  : t("tasks.form.labelN", { n: i + 1 })
              }
            />
          ))}
        </span>
      </FormField>
    </>
  );
}
