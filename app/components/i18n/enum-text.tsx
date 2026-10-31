import type { StockStatus, TaskPriority, UserRole } from "~/generated/prisma/client";
import { useLocale } from "~/i18n/use-t";
import { roleLabel } from "~/components/auth/labels";
import { kindLabel } from "~/components/locations/labels";
import { stockStatusLabel, taskPriorityLabel } from "~/lib/status";

/**
 * Localized enum text for the module-level DataGrid column definitions, whose
 * cell callbacks have no hook access: each cell renders one of these instead.
 */

export function TaskPriorityText({ value }: { value: TaskPriority }) {
  return <>{taskPriorityLabel(useLocale(), value)}</>;
}

export function StockStatusText({ value }: { value: StockStatus }) {
  return <>{stockStatusLabel(useLocale(), value)}</>;
}

export function LocationKindText({ kind }: { kind: string }) {
  return <>{kindLabel(useLocale(), kind)}</>;
}

export function RoleText({ role }: { role: UserRole }) {
  return <>{roleLabel(useLocale(), role)}</>;
}
