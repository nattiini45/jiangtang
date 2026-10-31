import {
  ArrowDownUp,
  BarChart3,
  Boxes,
  Building2,
  CalendarDays,
  Database,
  FolderKanban,
  Gauge,
  History,
  KanbanSquare,
  LayoutDashboard,
  ListTodo,
  MapPin,
  NotebookPen,
  Radio,
  School,
  Search,
  Ticket,
  Timer,
  Users,
  Warehouse,
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
export interface NavEntry {
  to: string;
  labelKey: MessageKey;
  icon: LucideIcon;
  end: boolean;
  adminOnly?: boolean;
}

export const NAV: NavEntry[] = [
  { to: "/", labelKey: "nav.overview", icon: LayoutDashboard, end: true },
  { to: "/board", labelKey: "nav.board", icon: KanbanSquare, end: false },
  { to: "/tasks", labelKey: "nav.tasks", icon: ListTodo, end: false },
  { to: "/timesheet", labelKey: "nav.timesheet", icon: Timer, end: false },
  { to: "/capacity", labelKey: "nav.capacity", icon: Gauge, end: false },
  { to: "/projects", labelKey: "nav.projects", icon: FolderKanban, end: false },
  { to: "/notes", labelKey: "nav.notes", icon: NotebookPen, end: false },
  { to: "/activity", labelKey: "nav.activity", icon: History, end: false },
  { to: "/search", labelKey: "nav.search", icon: Search, end: false },
  { to: "/rooms", labelKey: "nav.rooms", icon: Building2, end: false },
  { to: "/locations", labelKey: "nav.locations", icon: MapPin, end: false },
  { to: "/campuses", labelKey: "nav.campuses", icon: School, end: false },
  { to: "/inventory", labelKey: "nav.inventory", icon: Boxes, end: false },
  { to: "/inventory/stock", labelKey: "nav.stock", icon: Warehouse, end: false },
  { to: "/tickets", labelKey: "nav.tickets", icon: Ticket, end: false },
  { to: "/events", labelKey: "nav.events", icon: CalendarDays, end: false },
  { to: "/frequencies", labelKey: "nav.frequencies", icon: Radio, end: false },
  { to: "/import", labelKey: "nav.import", icon: ArrowDownUp, end: false },
  { to: "/analytics", labelKey: "nav.analytics", icon: BarChart3, end: false, adminOnly: true },
  { to: "/admin/users", labelKey: "nav.users", icon: Users, end: false, adminOnly: true },
  { to: "/admin/index", labelKey: "nav.searchIndex", icon: Database, end: false, adminOnly: true },
];
