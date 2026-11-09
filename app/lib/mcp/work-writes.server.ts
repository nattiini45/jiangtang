import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  createTask,
  updateTask,
  setTaskStatus,
  moveTask,
  setTaskAssignees,
  deleteTask,
} from "~/domains/tasks/tasks.mutations.server";
import { addTaskBlocker, removeTaskBlocker } from "~/domains/tasks/tasks.dependencies.server";
import {
  taskCreateSchema,
  taskEditSchema,
  taskAssigneesSchema,
  taskMoveSchema,
} from "~/domains/tasks/tasks.schema";
import { LANES } from "~/domains/tasks/tasks.lanes";
import { taskActionMetadata } from "~/domains/tasks/tasks.transitions";
import { projectActionMetadata } from "~/domains/projects/projects.transitions";
import {
  createProject,
  updateProject,
  setProjectStatus,
  deleteProject,
} from "~/domains/projects/projects.mutations.server";
import { projectCreateSchema, projectEditSchema } from "~/domains/projects/projects.schema";
import {
  createNote,
  updateNote,
  setNotePinned,
  archiveNote,
  unarchiveNote,
  deleteNote,
} from "~/domains/notes/notes.mutations.server";
import { noteCreateSchema, noteUpdateSchema } from "~/domains/notes/notes.schema";
import {
  startTimer,
  stopTimer,
  createTimeEntry,
  updateTimeEntry,
  deleteTimeEntry,
} from "~/domains/time/time.mutations.server";
import { timeEntryInputSchema } from "~/domains/time/time.schema";
import {
  markNotificationRead,
  markAllNotificationsRead,
} from "~/domains/notifications/notifications.mutations.server";
import { TaskStatus, TaskPriority, ProjectStatus } from "~/generated/prisma/enums";
import { emitChange } from "~/lib/realtime/emit.server";
import { registerTool } from "~/lib/mcp/tools.server";
import { mcpActor, type McpContext } from "~/lib/mcp/types.server";

const id = z.string().trim().min(1).max(200);
const byId = z.object({ id });
const confirmed = byId.extend({ confirm: z.literal(true) });
const instant = z.iso.datetime({ offset: true });
const taskDate = z.union([z.iso.date(), instant]).nullable().optional();
const projectDate = instant.nullable().optional();
const estimate = z.number().int().min(0).optional();
const assignees = z.array(z.object({ userId: id, estimateMinutes: estimate }));
const taskInput = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20000).optional(),
  priority: z.enum(TaskPriority).optional(),
  startAt: taskDate,
  dueAt: taskDate,
  estimateMinutes: estimate,
  projectId: id.optional(),
  parentTaskId: id.optional(),
  locationId: id.optional(),
  labels: z.array(z.string()).optional(),
});
const projectInput = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  color: z.string().optional(),
  startAt: projectDate,
  dueAt: projectDate,
  leadId: id.optional(),
  parentProjectId: id.optional(),
});
const noteInput = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().max(200000).default(""),
  pinned: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  projectId: id.optional(),
  locationId: id.optional(),
});
const timeInput = z.object({
  startsAt: instant,
  endsAt: instant.nullable(),
  taskId: id.optional(),
  comment: z.string().max(2000).nullable().optional(),
  userId: id.optional(),
});

export function registerWorkWrites(server: McpServer, context: McpContext): void {
  registerTool(
    server,
    context,
    {
      name: "create_task",
      description:
        "Create a task or subtask with optional assignees and per-assignee estimates. Task dates accept a Berlin calendar day or an ISO instant with offset.",
      schema: z.object({
        input: taskInput.extend({ status: z.enum(TaskStatus).optional() }),
        assignees: assignees.default([]),
      }),
      write: true,
    },
    async ({ input, assignees }, ctx) => {
      const task = await createTask(
        mcpActor(ctx),
        taskCreateSchema.parse(input),
        taskAssigneesSchema.parse(assignees),
      );
      await emitChange({ entityType: "task", id: task.id, op: "created" });
      return task;
    },
  );
  registerTool(
    server,
    context,
    {
      name: "update_task",
      description:
        "Replace task content and parentTaskId. Omitted optional fields are cleared. Use separate tools for status, ordering and assignees. Dates accept a Berlin calendar day or an ISO instant with offset.",
      schema: byId.extend({ input: taskInput }),
      write: true,
    },
    async ({ id, input }, ctx) => {
      const task = await updateTask(mcpActor(ctx), id, taskEditSchema.parse({ ...input, id }));
      await emitChange({ entityType: "task", id: task.id, op: "updated" });
      return task;
    },
  );
  registerTool(
    server,
    context,
    {
      name: "set_task_status",
      description:
        "Change a task to any distinct status and move it to its target lane tail, including changes within a lane. Dependencies do not gate status. Returns legal next actions; same status returns a structured transition rejection. No confirm argument required.",
      schema: byId.extend({ status: z.enum(TaskStatus) }),
      write: true,
    },
    async ({ id, status }, ctx) => {
      const task = await setTaskStatus(mcpActor(ctx), id, status);
      await emitChange({ entityType: "task", id: task.id, op: "updated" });
      return { ...task, ...taskActionMetadata(task.status) };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "move_task",
      description:
        "Move a task into a board lane between afterId and beforeId using domain fractional ordering. Omit afterId for the top edge or beforeId for the bottom edge. Within-lane reorder preserves status; identical neighbours are an unaudited no-op. Cross-lane moves use the lane default. Returns legal next status actions. No confirm argument required.",
      schema: byId.extend({ lane: z.enum(LANES), afterId: id.optional(), beforeId: id.optional() }),
      write: true,
    },
    async ({ id, ...move }, ctx) => {
      const task = await moveTask(mcpActor(ctx), id, taskMoveSchema.parse(move));
      await emitChange({ entityType: "task", id: task.id, op: "updated" });
      return { ...task, ...taskActionMetadata(task.status) };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "set_task_assignees",
      description:
        "Replace all task assignees and their individual estimateMinutes; an empty list removes all assignees.",
      schema: byId.extend({ assignees }),
      write: true,
    },
    async ({ id, assignees }, ctx) => {
      const task = await setTaskAssignees(mcpActor(ctx), id, taskAssigneesSchema.parse(assignees));
      await emitChange({ entityType: "task", id: task.id, op: "updated" });
      return { ...task, assignees };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "add_task_blocker",
      description:
        "Make taskId blocked by blockerTaskId. Rejects self-dependencies, duplicates and cycles.",
      schema: z.object({ taskId: id, blockerTaskId: id }),
      write: true,
    },
    async ({ taskId, blockerTaskId }, ctx) => {
      const edge = await addTaskBlocker(mcpActor(ctx), taskId, blockerTaskId);
      await emitChange({ entityType: "task", id: taskId, op: "updated" });
      return edge;
    },
  );
  registerTool(
    server,
    context,
    {
      name: "remove_task_blocker",
      description:
        "Remove the dependency making taskId blocked by blockerTaskId. Requires confirm:true.",
      schema: z.object({ taskId: id, blockerTaskId: id, confirm: z.literal(true) }),
      write: true,
      destructive: true,
    },
    async ({ taskId, blockerTaskId }, ctx) => {
      await removeTaskBlocker(mcpActor(ctx), taskId, blockerTaskId);
      await emitChange({ entityType: "task", id: taskId, op: "updated" });
      return { taskId, blockerTaskId, removed: true };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "delete_task",
      description: "Delete a task without subtasks. Requires confirm:true.",
      schema: confirmed,
      write: true,
      destructive: true,
    },
    async ({ id }, ctx) => {
      const task = await deleteTask(mcpActor(ctx), id);
      await emitChange({ entityType: "task", id: task.id, op: "deleted" });
      return { id: task.id, title: task.title, deleted: true };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "create_project",
      description: "Create a project. Dates must be ISO instants with offsets.",
      schema: z.object({
        input: projectInput.extend({ status: z.enum(ProjectStatus).optional() }),
      }),
      write: true,
    },
    async ({ input }, ctx) => {
      const project = await createProject(mcpActor(ctx), projectCreateSchema.parse(input));
      await emitChange({ entityType: "project", id: project.id, op: "created" });
      return project;
    },
  );
  registerTool(
    server,
    context,
    {
      name: "update_project",
      description:
        "Replace project content and parentProjectId, clearing omitted optional fields. Use set_project_status for status. Dates must be ISO instants with offsets.",
      schema: byId.extend({ input: projectInput }),
      write: true,
    },
    async ({ id, input }, ctx) => {
      const project = await updateProject(
        mcpActor(ctx),
        id,
        projectEditSchema.parse({ ...input, id }),
      );
      await emitChange({ entityType: "project", id: project.id, op: "updated" });
      return project;
    },
  );
  registerTool(
    server,
    context,
    {
      name: "set_project_status",
      description:
        "Change a project to any distinct status with an audited transition, without cascading to contained work or imposing completion gates. Returns legal next actions; same status returns a structured transition rejection. No confirm argument required.",
      schema: byId.extend({ status: z.enum(ProjectStatus) }),
      write: true,
    },
    async ({ id, status }, ctx) => {
      const project = await setProjectStatus(mcpActor(ctx), id, status);
      await emitChange({ entityType: "project", id: project.id, op: "updated" });
      return { ...project, ...projectActionMetadata(project.status) };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "delete_project",
      description:
        "Delete a project without subprojects, detaching its other references. Requires confirm:true.",
      schema: confirmed,
      write: true,
      destructive: true,
    },
    async ({ id }, ctx) => {
      const project = await deleteProject(mcpActor(ctx), id);
      await emitChange({ entityType: "project", id: project.id, op: "deleted" });
      return { id: project.id, name: project.name, deleted: true };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "create_note",
      description: "Create a Markdown note with tags and optional project or location.",
      schema: z.object({ input: noteInput }),
      write: true,
    },
    async ({ input }, ctx) => {
      const note = await createNote(mcpActor(ctx), noteCreateSchema.parse(input));
      await emitChange({ entityType: "note", id: note.id, op: "created" });
      return note;
    },
  );
  registerTool(
    server,
    context,
    {
      name: "update_note",
      description:
        "Replace a complete note document using its last read version. A stale version returns a conflict instead of overwriting another save. Omitted optional fields are cleared.",
      schema: byId.extend({ input: noteInput.extend({ version: z.number().int().min(1) }) }),
      write: true,
    },
    async ({ id, input }, ctx) => {
      const { version, ...document } = noteUpdateSchema.parse(input);
      const note = await updateNote(mcpActor(ctx), id, document, version);
      await emitChange({ entityType: "note", id: note.id, op: "updated" });
      return note;
    },
  );
  registerTool(
    server,
    context,
    {
      name: "set_note_pinned",
      description: "Pin or unpin a note.",
      schema: byId.extend({ pinned: z.boolean() }),
      write: true,
    },
    async ({ id, pinned }, ctx) => {
      const note = await setNotePinned(mcpActor(ctx), id, pinned);
      await emitChange({ entityType: "note", id: note.id, op: "updated" });
      return { id: note.id, title: note.title, pinned: note.pinned, version: note.version };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "archive_note",
      description: "Archive a note. Requires confirm:true.",
      schema: confirmed,
      write: true,
      destructive: true,
    },
    async ({ id }, ctx) => {
      const note = await archiveNote(mcpActor(ctx), id);
      await emitChange({ entityType: "note", id: note.id, op: "updated" });
      return { id: note.id, title: note.title, archivedAt: note.archivedAt };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "unarchive_note",
      description: "Restore an archived note to the active list.",
      schema: byId,
      write: true,
    },
    async ({ id }, ctx) => {
      const note = await unarchiveNote(mcpActor(ctx), id);
      await emitChange({ entityType: "note", id: note.id, op: "updated" });
      return { id: note.id, title: note.title, archivedAt: note.archivedAt };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "delete_note",
      description: "Permanently delete a note. Requires confirm:true.",
      schema: confirmed,
      write: true,
      destructive: true,
    },
    async ({ id }, ctx) => {
      const note = await deleteNote(mcpActor(ctx), id);
      await emitChange({ entityType: "note", id: note.id, op: "deleted" });
      return { id: note.id, title: note.title, deleted: true };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "start_timer",
      description:
        "Start the signed-in user's timer, optionally on a task. Refuses a second running timer.",
      schema: z.object({ taskId: id.optional() }),
      write: true,
    },
    async ({ taskId }, ctx) => {
      const entry = await startTimer(mcpActor(ctx), taskId);
      await emitChange({ entityType: "timeEntry", id: entry.id, op: "created" });
      return entry;
    },
  );
  registerTool(
    server,
    context,
    {
      name: "stop_timer",
      description:
        "Stop the signed-in user's running timer strictly after its start time. A start equal to or later than the server's current time is refused without changes. Recover by correcting startsAt or supplying an endsAt after startsAt with update_time_entry, or wait until after the start time.",
      schema: z.object({}),
      write: true,
    },
    async (_input, ctx) => {
      const entry = await stopTimer(mcpActor(ctx));
      await emitChange({ entityType: "timeEntry", id: entry.id, op: "updated" });
      return entry;
    },
  );
  registerTool(
    server,
    context,
    {
      name: "create_time_entry",
      description:
        "Create a time entry using ISO instants with offsets. Null endsAt creates a running timer whose startsAt must be at or before the server's mutation-time now. Use start_timer to start your own timer at server time. Finished intervals require endsAt after startsAt and may be in the future. Members log for themselves; only admins may choose userId.",
      schema: z.object({ input: timeInput }),
      write: true,
    },
    async ({ input }, ctx) => {
      const entry = await createTimeEntry(
        mcpActor(ctx),
        timeEntryInputSchema.parse({
          ...input,
          startsAt: new Date(input.startsAt),
          endsAt: input.endsAt === null ? null : new Date(input.endsAt),
        }),
      );
      await emitChange({ entityType: "timeEntry", id: entry.id, op: "created" });
      return entry;
    },
  );
  registerTool(
    server,
    context,
    {
      name: "update_time_entry",
      description:
        "Replace a time entry's times, task and comment using ISO instants with offsets. Changed running results (endsAt: null) require startsAt at or before the server's mutation-time now; identical updates remain unaudited no-write no-ops, including existing future-running entries. Finished intervals require endsAt after startsAt and may be in the future. Use start_timer to start your own timer at server time. Members edit only their own entries; admins may edit others. Ownership cannot be reassigned.",
      schema: byId.extend({ input: timeInput.omit({ userId: true }) }),
      write: true,
    },
    async ({ id, input }, ctx) => {
      const entry = await updateTimeEntry(
        mcpActor(ctx),
        id,
        timeEntryInputSchema.parse({
          ...input,
          startsAt: new Date(input.startsAt),
          endsAt: input.endsAt === null ? null : new Date(input.endsAt),
        }),
      );
      await emitChange({ entityType: "timeEntry", id: entry.id, op: "updated" });
      return entry;
    },
  );
  registerTool(
    server,
    context,
    {
      name: "delete_time_entry",
      description:
        "Delete a time entry. Members delete only their own entries; admins may delete others. Requires confirm:true.",
      schema: confirmed,
      write: true,
      destructive: true,
    },
    async ({ id }, ctx) => {
      const entry = await deleteTimeEntry(mcpActor(ctx), id);
      await emitChange({ entityType: "timeEntry", id: entry.id, op: "deleted" });
      return { id: entry.id, userId: entry.userId, deleted: true };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "mark_notification_read",
      description:
        "Mark one notification in the signed-in user's own inbox as read. Admins cannot modify another user's inbox.",
      schema: byId,
      write: true,
    },
    async ({ id }, ctx) => {
      const notification = await markNotificationRead(mcpActor(ctx), id);
      return { id: notification.id, readAt: notification.readAt };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "mark_all_notifications_read",
      description:
        "Mark all unread notifications in the signed-in user's own inbox as read, returning the changed count.",
      schema: z.object({}),
      write: true,
    },
    async (_input, ctx) => ({ count: await markAllNotificationsRead(mcpActor(ctx)) }),
  );
}
