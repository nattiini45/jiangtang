-- Functional baseline, file 6 of 7: the workitem lane table and view.
--
-- Responsibility: the two objects Prisma cannot model - the lane mapping table
-- with the five reference rows that are part of the schema's data, and the
-- UNION ALL view that lists tasks and tickets through it. Neither is generated
-- by `migrate dev`: Prisma Migrate ignores views in both directions, and
-- workitem_lane maps two enums onto one vocabulary, so it is meant to be
-- editable data rather than a model.
--
-- "workitem_lane" is created with its columns in the catalog's live ordinal
-- order - 1 lane, 2 task_statuses, 3 ticket_statuses - all three NOT NULL with a
-- primary key on lane. The array types are load-bearing: the mapping is
-- many-to-one on both sides (BACKLOG covers two task statuses) and one row per
-- lane is what makes five rows the complete vocabulary.
--
-- The five INSERT rows below are REQUIRED REFERENCE DATA, not demo or user data,
-- and the plan requires exactly these five:
--
--   lane          task_statuses              ticket_statuses
--   BACKLOG       BACKLOG, TODO              OPEN
--   IN_PROGRESS   IN_PROGRESS                IN_PROGRESS
--   IN_REVIEW     IN_REVIEW, BLOCKED         (empty text array)
--   DONE          DONE                       RESOLVED
--   CANCELLED     CANCELLED                  CANCELLED
--
-- Three details of those rows are semantic, not cosmetic. Array element order is
-- preserved as measured (BACKLOG lists BACKLOG before TODO; IN_REVIEW lists
-- IN_REVIEW before BLOCKED), because array constructors are ordered values. The
-- IN_REVIEW ticket_statuses is ARRAY[]::text[] - an empty array, which is what
-- the catalog records - and NOT NULL, which would mean "no ticket mapping"
-- rather than "no ticket status in this lane". And the lane vocabulary is the
-- double-L CANCELLED in both the lane name and its task_statuses, which is the
-- measured final state.
--
-- The double-L spelling is written directly, and that is a deliberate omission
-- of history, not an accident: the lane row is seeded as 'CANCELLED' with
-- task_statuses ARRAY['CANCELLED'] and the TaskStatus enum carries the same
-- double-L label, while the earlier single-L spelling existed only in the
-- reference installation. A fresh install has no old label to rename and no old
-- row to update, so the single-L conversion statements the reference needed -
-- the enum VALUE rename and the lane-row UPDATE - are omitted and the final
-- state is created once. The final TaskStatus enum, with the same double-L
-- label, is file 2's.
--
-- The view is the catalog's recorded definition, reproduced expression by
-- expression: nine columns in this exact order - id, kind, title, lane,
-- sort_priority, assignee_ids, project_id, due_at, updated_at - as a two-arm
-- UNION ALL over "Task" and "Ticket", each arm left-joined to the lane table on
-- its own status array. The mapping rules that must survive consolidation:
--
--   * priority mapping. Tasks map their enum to a dense integer through an
--     explicit CASE - URGENT 1, HIGH 2, MEDIUM 3, LOW 4, LOWEST 5, every other
--     status NULL - so the board sorts by urgency, not by enum order. Tickets
--     already carry an integer priority and pass it through unchanged; the two
--     arms are therefore comparable without a second CASE.
--   * sorted assignee arrays. Each arm aggregates its own join table -
--     "TaskAssignees"."userId" for tasks, _Assignees."B" for tickets - with
--     array_agg(... ORDER BY ...) inside a LATERAL subquery, so the array is
--     ordered by id. The board renders it directly; an unordered array would
--     make the output depend on heap order.
--   * nullable ticket projections. A ticket has no project and no due date, so
--     the ticket arm projects NULL::text AS project_id and
--     NULL::timestamptz AS due_at - typed NULLs, which is what fixes the column
--     types of the UNION. Both arms cast id, title and kind to text and each
--     sort_priority to int; updated_at is the one projected column that neither
--     arm casts.
--   * column order. The nine columns are named in both arms in the order above,
--     so the view's ordinals match the catalog's 1..9 rather than relying on
--     positional agreement between two SELECT lists that happen to line up.
--
-- Deliberately absent from this file, by design:
--   * the 'CANCELED' seed row and the RENAME VALUE / UPDATE pair that replaced
--     it (named above);
--   * IF NOT EXISTS / ON CONFLICT DO NOTHING on either the table or the rows - a
--     fresh install has neither, and a guard would silently accept a conflicting
--     pre-existing object or a sixth row;
--   * CREATE OR REPLACE VIEW - the view is created once, and the object matrix
--     records altered_after_creation = false;
--   * any other row in any table: this file inserts into "workitem_lane" and
--     nowhere else, and inserts exactly five rows;
--   * every table, enum, key and foreign key the view reads. "Task", "Ticket",
--     "TaskAssignees" and "_Assignees" are file 2's; the enums are file 2's.

-- ===========================================================================
-- Lane mapping table
-- ===========================================================================

CREATE TABLE "workitem_lane" (
  lane            text PRIMARY KEY,
  task_statuses   text[] NOT NULL,
  ticket_statuses text[] NOT NULL
);

-- The five rows, one per lane. Required reference data, in the mapping order
-- above; no user, demo or import data follows.
INSERT INTO "workitem_lane" (lane, task_statuses, ticket_statuses) VALUES
  ('BACKLOG',     ARRAY['BACKLOG', 'TODO'],        ARRAY['OPEN']),
  ('IN_PROGRESS', ARRAY['IN_PROGRESS'],            ARRAY['IN_PROGRESS']),
  ('IN_REVIEW',   ARRAY['IN_REVIEW', 'BLOCKED'],   ARRAY[]::text[]),
  ('DONE',        ARRAY['DONE'],                   ARRAY['RESOLVED']),
  ('CANCELLED',   ARRAY['CANCELLED'],               ARRAY['CANCELLED']);

-- ===========================================================================
-- Workitem view
-- ===========================================================================

CREATE VIEW "workitem" AS
SELECT
  t.id::text                                   AS id,
  'TASK'::text                                 AS kind,
  t.title::text                                AS title,
  l.lane                                       AS lane,
  CASE t.priority::text
    WHEN 'URGENT' THEN 1
    WHEN 'HIGH'   THEN 2
    WHEN 'MEDIUM' THEN 3
    WHEN 'LOW'    THEN 4
    WHEN 'LOWEST' THEN 5
  END::int                                     AS sort_priority,
  COALESCE(a.assignee_ids, '{}'::text[])       AS assignee_ids,
  t."projectId"::text                          AS project_id,
  t."dueAt"                                    AS due_at,
  t."updatedAt"                                AS updated_at
FROM "Task" t
LEFT JOIN "workitem_lane" l ON t.status::text = ANY(l.task_statuses)
LEFT JOIN LATERAL (
  SELECT array_agg(ta."userId" ORDER BY ta."userId") AS assignee_ids
  FROM "TaskAssignees" ta
  WHERE ta."taskId" = t.id
) a ON true

UNION ALL

SELECT
  k.id::text                                   AS id,
  'TICKET'::text                               AS kind,
  k.title::text                                AS title,
  l.lane                                       AS lane,
  k.priority::int                              AS sort_priority,
  COALESCE(ka.assignee_ids, '{}'::text[])      AS assignee_ids,
  NULL::text                                   AS project_id,
  NULL::timestamptz                            AS due_at,
  k."updatedAt"                                AS updated_at
FROM "Ticket" k
LEFT JOIN "workitem_lane" l ON k.status::text = ANY(l.ticket_statuses)
LEFT JOIN LATERAL (
  SELECT array_agg(j."B" ORDER BY j."B") AS assignee_ids
  FROM "_Assignees" j
  WHERE j."A" = k.id
) ka ON true;
