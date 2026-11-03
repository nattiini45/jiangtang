import { z } from "zod";
import { msgKey } from "~/i18n";
import { ProjectStatus, TaskPriority, TaskStatus } from "~/generated/prisma/enums";

/**
 * The `jiangtang-workspace` JSON transfer format, version 1. This schema
 * validates STRUCTURE only — references (emails, slugs, ids pointing at other
 * rows) are resolved inside the import transaction so one bad reference
 * refuses the whole file atomically.
 *
 * Ids are normally cuid-shaped: Prisma `@default(cuid())` ids are `c` + 20–32
 * lowercase alphanumerics. The transfer format additionally admits the demo
 * workspace's reserved `seed_*` namespace: the seeded demo rows carry
 * stable, explicit ids and a raw export/import must round-trip them without
 * filtering. The union is transfer-only: it admits the reserved demo namespace,
 * not arbitrary primary-key strings. No other domain validator changes. A file
 * that ships anything else (uuid, serial,
 * "task-1") is rejected before the transaction opens — importing arbitrary
 * caller-chosen primary keys would let a file shadow ids the generator could
 * later mint.
 */

export const TRANSFER_FORMAT = "jiangtang-workspace" as const;
export const TRANSFER_VERSION = 1 as const;

/** Prisma `@default(cuid())` shape — also the mobile capture clientId shape. */
export const CUID_PATTERN = /^c[a-z0-9]{20,32}$/;

/** The demo seed's explicit-id namespace (`scripts/seed/data.ts`). */
const SEED_ID_PATTERN = /^seed_[a-z0-9]+(?:_[a-z0-9]+)*$/;

const transferId = z
  .string()
  .max(64)
  .refine(
    (value) => CUID_PATTERN.test(value) || SEED_ID_PATTERN.test(value),
    msgKey("places.err.transfer.idInvalid"),
  );

/** ISO-8601 instant or Berlin date — anything `Date.parse` accepts. */
const instant = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), msgKey("places.err.transfer.dateInvalid"))
  .transform((s) => new Date(s));

const nullableInstant = instant.nullable().default(null);
const nullableText = z.string().nullable().default(null);

export const transferProjectSchema = z.object({
  id: transferId,
  slug: z.string().min(1),
  name: z.string().min(1),
  description: nullableText,
  status: z.enum(ProjectStatus),
  color: nullableText,
  startAt: nullableInstant,
  dueAt: nullableInstant,
  leadEmail: z.email().nullable().default(null),
  parentSlug: z.string().nullable().default(null),
});

export const transferAssigneeSchema = z.object({
  email: z.email(),
  estimateMinutes: z.number().int().nonnegative().nullable().default(null),
});

export const transferTaskSchema = z.object({
  id: transferId,
  title: z.string().min(1),
  body: nullableText,
  status: z.enum(TaskStatus),
  priority: z.enum(TaskPriority).nullable().default(null),
  startAt: nullableInstant,
  dueAt: nullableInstant,
  estimateMinutes: z.number().int().nonnegative().nullable().default(null),
  labels: z.array(z.string()).default([]),
  projectSlug: z.string().nullable().default(null),
  parentTaskId: transferId.nullable().default(null),
  assignees: z.array(transferAssigneeSchema).default([]),
  blockedBy: z.array(transferId).default([]),
});

export const transferNoteSchema = z.object({
  id: transferId,
  title: z.string().min(1),
  body: z.string().default(""),
  tags: z.array(z.string()).default([]),
  pinned: z.boolean().default(false),
  projectSlug: z.string().nullable().default(null),
  locationId: transferId.nullable().default(null),
  archivedAt: nullableInstant,
});

export const workspaceTransferSchema = z.object({
  format: z.literal(TRANSFER_FORMAT),
  version: z.literal(TRANSFER_VERSION),
  exportedAt: z.string().optional(),
  projects: z.array(transferProjectSchema).default([]),
  tasks: z.array(transferTaskSchema).default([]),
  notes: z.array(transferNoteSchema).default([]),
});

export type WorkspaceTransfer = z.infer<typeof workspaceTransferSchema>;
export type TransferProject = z.infer<typeof transferProjectSchema>;
export type TransferTask = z.infer<typeof transferTaskSchema>;
export type TransferNote = z.infer<typeof transferNoteSchema>;
