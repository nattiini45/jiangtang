import * as React from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { useT } from "~/i18n/use-t";

export interface AssigneeUser {
  id: string;
  name: string;
  initials: string | null;
}

export interface AssigneeRow {
  userId: string;
  estimateMinutes: number | null;
}

/**
 * The assignees editor on `/tasks/:id`: one row per assignee — a user
 * select and that person's share of the estimate (`TaskAssignees.
 * estimateMinutes`) — plus an empty row to add. The form submits the
 * `assigneeUser`/`assigneeEstimate` key PAIRS zipped by row; a row with no
 * user chosen is dropped server-side, and removing every row clears the set.
 *
 * Client state only governs how many rows render — the submitted pairs are the
 * source of truth, so a mid-edit navigation can't lose the selection the DOM
 * carries.
 */
export function TaskAssigneesEditor({
  users,
  assignees,
}: {
  /** Selectable users (active ones plus anyone already assigned). */
  users: AssigneeUser[];
  /** Current assignee rows. */
  assignees: AssigneeRow[];
}) {
  const t = useT();
  const [rows, setRows] = React.useState<AssigneeRow[]>([
    ...assignees,
    { userId: "", estimateMinutes: null },
  ]);
  // Rows are keyed by index deliberately: the pair that matters is the one the
  // DOM submits, and an index key keeps the user's in-progress selection on the
  // row it was typed into.
  //
  // `useState` captures the prop once — a fetcher revalidation (e.g. the
  // palette's „Mir zuweisen" verb) would otherwise leave the section stale
  // until a reload. Adopt the new committed set only while the user hasn't
  // diverged from the old one, so a live refetch still can't wipe an
  // in-progress selection.
  const committedRef = React.useRef(assignees);
  React.useEffect(() => {
    const prev = committedRef.current;
    committedRef.current = assignees;
    setRows((current) => {
      const filled = current.filter((r) => r.userId !== "");
      const same =
        filled.length === prev.length &&
        filled.every(
          (r, i) => r.userId === prev[i].userId && r.estimateMinutes === prev[i].estimateMinutes,
        );
      return same ? [...assignees, { userId: "", estimateMinutes: null }] : current;
    });
  }, [assignees]);
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Select
            name="assigneeUser"
            value={row.userId}
            onChange={(e) =>
              setRows(rows.map((r, j) => (j === i ? { ...r, userId: e.target.value } : r)))
            }
            aria-label={t("tasks.assignees.userAria", { n: i + 1 })}
          >
            <option value="">—</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
          <Input
            name="assigneeEstimate"
            type="number"
            min={0}
            step={1}
            defaultValue={row.estimateMinutes ?? ""}
            placeholder={t("tasks.assignees.minutesPlaceholder")}
            className="nums w-24"
            aria-label={t("tasks.assignees.minutesAria", { n: i + 1 })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-compact"
            aria-label={t("tasks.assignees.removeRow")}
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="compact"
        className="self-start"
        onClick={() => setRows([...rows, { userId: "", estimateMinutes: null }])}
      >
        {t("tasks.assignees.addPerson")}
      </Button>
    </div>
  );
}
