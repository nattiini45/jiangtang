import {
  ArrowDownUp,
  CircleAlert,
  ArrowLeft,
  BarChart3,
  Boxes,
  Building2,
  CalendarDays,
  Database,
  FolderKanban,
  History,
  Info,
  KanbanSquare,
  LayoutDashboard,
  ListTodo,
  MapPin,
  NotebookPen,
  Search,
  Settings,
  Ticket,
  Timer,
  Users,
  UserPlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MessageKey } from "~/i18n";

/**
 * The desktop navigation list — the single source of truth for both the app
 * shell's sidebar and the command palette's "Go to …" verbs. Extracted
 * into a client-safe module so the palette derives its navigation verbs from
 * the same array the sidebar renders; a nav entry added here appears in both
 * places without a second edit.
 *
 * "Start from a room" IA — rooms lead the nav. `adminOnly` entries are hidden
 * for non-admins (their loaders enforce requireRole regardless — nav is UX,
 * not the guard).
 */
export type NavGroup =
  "work" | "places" | "service" | "admin" | "back" | "people" | "data" | "system";

export interface NavEntry {
  to: string;
  labelKey: MessageKey;
  adminLabelKey?: MessageKey;
  icon: LucideIcon;
  end: boolean;
  group: NavGroup;
  adminOnly?: boolean;
  adminArea?: boolean;
}

export const NAV_GROUPS: { id: NavGroup; labelKey: MessageKey }[] = [
  { id: "work", labelKey: "nav.group.work" },
  { id: "places", labelKey: "nav.group.places" },
  { id: "service", labelKey: "nav.group.service" },
  { id: "admin", labelKey: "nav.group.admin" },
];

const ADMIN_GROUPS: { id: NavGroup; labelKey?: MessageKey }[] = [
  { id: "back" },
  { id: "people", labelKey: "nav.group.people" },
  { id: "data", labelKey: "nav.group.data" },
  { id: "system", labelKey: "nav.group.system" },
];

export const NAV: NavEntry[] = [
  { to: "/", labelKey: "nav.overview", icon: LayoutDashboard, end: true, group: "work" },
  { to: "/calendar", labelKey: "nav.calendar", icon: CalendarDays, end: true, group: "work" },
  { to: "/plans", labelKey: "plans.title", icon: ListTodo, end: false, group: "work" },
  { to: "/board", labelKey: "nav.board", icon: KanbanSquare, end: false, group: "work" },
  { to: "/tasks", labelKey: "nav.tasks", icon: ListTodo, end: false, group: "work" },
  { to: "/timesheet", labelKey: "nav.timesheet", icon: Timer, end: false, group: "work" },
  { to: "/projects", labelKey: "nav.projects", icon: FolderKanban, end: false, group: "work" },
  { to: "/notes", labelKey: "nav.notes", icon: NotebookPen, end: false, group: "work" },
  {
    to: "/activity",
    labelKey: "nav.activity",
    icon: History,
    end: false,
    group: "work",
    adminOnly: true,
  },
  {
    to: "/analytics",
    labelKey: "nav.analytics",
    icon: BarChart3,
    end: false,
    group: "work",
    adminOnly: true,
  },
  { to: "/search", labelKey: "nav.search", icon: Search, end: false, group: "work" },
  { to: "/rooms", labelKey: "nav.rooms", icon: Building2, end: false, group: "places" },
  {
    to: "/rounds",
    labelKey: "functions.rounds.title",
    icon: ListTodo,
    end: false,
    group: "places",
  },
  {
    to: "/functions",
    labelKey: "functions.list.title",
    icon: CircleAlert,
    end: false,
    group: "places",
  },
  { to: "/locations", labelKey: "nav.locations", icon: MapPin, end: false, group: "places" },
  { to: "/inventory", labelKey: "nav.inventory", icon: Boxes, end: false, group: "places" },
  { to: "/tickets", labelKey: "nav.tickets", icon: Ticket, end: false, group: "service" },
  { to: "/events", labelKey: "nav.events", icon: CalendarDays, end: false, group: "service" },
  {
    to: "/import",
    labelKey: "nav.import",
    icon: ArrowDownUp,
    end: false,
    group: "admin",
    adminOnly: true,
  },
  {
    to: "/admin",
    labelKey: "nav.administration",
    adminLabelKey: "admin.overview.title",
    icon: Settings,
    end: false,
    group: "admin",
    adminOnly: true,
  },
  {
    to: "/admin/users",
    labelKey: "nav.users",
    icon: Users,
    end: false,
    group: "people",
    adminOnly: true,
    adminArea: true,
  },
  {
    to: "/admin/invitations",
    labelKey: "admin.invitations.title",
    icon: UserPlus,
    end: false,
    group: "people",
    adminOnly: true,
    adminArea: true,
  },
  {
    to: "/admin/structure",
    labelKey: "admin.structure.title",
    icon: Settings,
    end: false,
    group: "people",
    adminOnly: true,
    adminArea: true,
  },
  {
    to: "/admin/search-index",
    labelKey: "nav.searchIndex",
    icon: Database,
    end: false,
    group: "data",
    adminOnly: true,
    adminArea: true,
  },
  {
    to: "/admin/about",
    labelKey: "nav.about",
    icon: Info,
    end: false,
    group: "system",
    adminOnly: true,
    adminArea: true,
  },
];

export function navigationFor(admin: boolean, pathname: string) {
  const adminArea = admin && (pathname === "/admin" || pathname.startsWith("/admin/"));
  const entries = NAV.filter(
    (item) =>
      (!item.adminOnly || admin) &&
      (Boolean(item.adminArea) === adminArea || (adminArea && !!item.adminLabelKey)),
  ).map((item) =>
    adminArea && item.adminLabelKey
      ? { ...item, labelKey: item.adminLabelKey, group: "back" as const, end: true }
      : item,
  );
  if (adminArea && admin)
    entries.unshift({
      to: "/",
      labelKey: "nav.backToWorkspace",
      icon: ArrowLeft,
      end: true,
      group: "back",
    });
  return { groups: adminArea ? ADMIN_GROUPS : NAV_GROUPS, entries };
}
