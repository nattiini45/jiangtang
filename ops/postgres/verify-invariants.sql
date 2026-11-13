-- verify-invariants.sql — the minimum real safety net for a production deploy
-- (the un-droppable invariants described below).
--
-- Run AFTER `prisma migrate deploy`, in the same migrate job, so a database
-- that lost an invariant fails the deploy BEFORE the app ever starts:
--
--   prisma migrate deploy && prisma db execute --file ops/postgres/verify-invariants.sql
--
-- (or directly: psql "$DATABASE_URL" -f ops/postgres/verify-invariants.sql)
--
-- READ-ONLY: every check is a catalog query inside one DO block. Nothing is
-- created, altered, or dropped — a check that fixes things would also hide
-- them. On any missing invariant the script raises EXCEPTION (non-zero exit,
-- names every offender) and the migrate job — and with it the app, which
-- depends on `service_completed_successfully` — stops. No statement below is
-- DDL or DML, and none sets a configuration value that outlives the block.
--
-- Keep this list in sync with the seven-file baseline in prisma/migrations/
-- (later migrations follow it and are only required to come after it):
-- it covers the invariants that are NOT restorable by re-running a Prisma
-- migration on an existing database (folded hand-written SQL: EXCLUDE
-- constraints, triggers, extensions, indexes Prisma does not model, reference
-- data the schema cannot express), plus the trigger that protects the audit
-- spine. Each check names the canonical file that owns the object.
DO $verify$
DECLARE
  missing text[] := '{}';
  have boolean;
BEGIN
  -- ── 1/2. Booking no-double-booking EXCLUDE constraints (golden rule) ──
  -- 20261023000200_booking_constraints
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_room_no_overlap'
      AND contype = 'x'
      AND conrelid = '"EventRoomBooking"'::regclass
  ) INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'EXCLUDE constraint event_room_no_overlap on "EventRoomBooking" (room double-booking)');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'equipment_alloc_no_overlap'
      AND contype = 'x'
      AND conrelid = '"EquipmentAllocation"'::regclass
  ) INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'EXCLUDE constraint equipment_alloc_no_overlap on "EquipmentAllocation" (equipment double-booking)');
  END IF;

  -- ── 3. ActivityLog immutability trigger (append-only audit spine) ──
  -- 20261023000300_audit_privacy. Existence is not enough: the trigger must be
  -- ENABLE ALWAYS ('A'), because a default-enabled trigger ('O') is silently
  -- skipped when a session runs under session_replication_role = replica, which
  -- is exactly the window the record must survive.
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'activitylog_no_update_delete'
      AND c.relname = 'ActivityLog'
      AND NOT t.tgisinternal
  ) INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'trigger activitylog_no_update_delete on "ActivityLog" (append-only audit)');
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname = 'activitylog_no_update_delete'
        AND c.relname = 'ActivityLog'
        AND t.tgenabled = 'A'
    ) INTO have;
    IF NOT have THEN
      missing := array_append(missing, 'trigger activitylog_no_update_delete is not ENABLE ALWAYS (tgenabled <> ''A'')');
    END IF;
  END IF;

  -- ── 4/5. Required extensions ──
  -- 20261023000000_extensions
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'extension vector (pgvector — Chunk.embedding)');
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'extension pg_trgm (trigram indexes for lexical search)');
  END IF;

  -- ── 6. Chunk HNSW index (vector retrieval path) ──
  -- 20261023000400_search_indexes. By access method, not by name: what the
  -- invariant protects is that the embedding column is HNSW-indexed, whatever
  -- the index happens to be called.
  SELECT EXISTS (
    SELECT 1
    FROM pg_class idx
    JOIN pg_index i ON i.indexrelid = idx.oid
    JOIN pg_am am ON am.oid = idx.relam
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE t.relname = 'Chunk' AND am.amname = 'hnsw'
  ) INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'HNSW index on "Chunk" (expected "Chunk_embedding_hnsw", 20261023000400_search_indexes)');
  END IF;

  -- ── 7. One running timer per user (partial unique index) ──
  -- 20261023000600_time_tracking_constraints
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'TimeEntry' AND indexname = 'time_entry_one_running_per_user'
  ) INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'partial unique index time_entry_one_running_per_user on "TimeEntry" (single running timer)');
  END IF;

  -- ── 8. The applied ledger starts with the seven-file baseline ──
  -- A deploy that half-applied, or a database still carrying a name from the
  -- historical chain, is not the schema these invariants are written for.
  SELECT to_regclass('public._prisma_migrations') IS NOT NULL INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'table "_prisma_migrations" (the migration ledger — run prisma migrate deploy first)');
  ELSE
    -- Later migrations sort after the baseline, so the baseline is the prefix.
    SELECT count(*) >= 7
       AND (array_agg(migration_name ORDER BY migration_name)::text[])[1:7] = ARRAY[
             '20261023000000_extensions',
             '20261023000100_core_schema',
             '20261023000200_booking_constraints',
             '20261023000300_audit_privacy',
             '20261023000400_search_indexes',
             '20261023000500_workitem_view',
             '20261023000600_time_tracking_constraints'
           ]::text[]
      INTO have
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
    IF NOT have THEN
      missing := array_append(missing, '_prisma_migrations does not start with the seven canonical finished migrations (unapplied, rolled back, or historical name present)');
    END IF;
  END IF;

  -- ── 9. workitem_lane carries the five-lane vocabulary ──
  -- 20261023000500_workitem_view. The rows ARE part of the schema: an empty
  -- mapping table makes every status fall through the view's LEFT JOIN.
  SELECT to_regclass('public."workitem_lane"') IS NOT NULL INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'table "workitem_lane" (the one lane vocabulary of the workitem board)');
  ELSE
    SELECT count(*) = 5
       AND count(*) FILTER (WHERE task_statuses IS NULL OR ticket_statuses IS NULL) = 0
       AND array_agg(lane ORDER BY lane) = ARRAY['BACKLOG', 'CANCELLED', 'DONE', 'IN_PROGRESS', 'IN_REVIEW']::text[]
      INTO have
      FROM "workitem_lane";
    IF NOT have THEN
      missing := array_append(missing, '"workitem_lane" does not hold exactly the five lanes BACKLOG, CANCELLED, DONE, IN_PROGRESS, IN_REVIEW as non-null arrays');
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM "workitem_lane"
      WHERE lane = 'IN_REVIEW' AND ticket_statuses = ARRAY[]::text[]
    ) INTO have;
    IF NOT have THEN
      missing := array_append(missing, 'workitem_lane IN_REVIEW.ticket_statuses is not the empty text array (no ticket status lives in that lane)');
    END IF;

    -- Both enums mapped, exactly once each, and nothing invented. Read from
    -- pg_enum rather than a copied list: the failure this catches is a NEW
    -- enum label that no lane covers.
    SELECT EXISTS (
      SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'TaskStatus'
    ) AND NOT EXISTS (
      SELECT e.enumlabel::text FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'TaskStatus'
      EXCEPT
      SELECT unnest(task_statuses)::text FROM "workitem_lane"
    ) AND NOT EXISTS (
      SELECT unnest(task_statuses)::text FROM "workitem_lane"
      EXCEPT
      SELECT e.enumlabel::text FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'TaskStatus'
    ) INTO have;
    IF NOT have THEN
      missing := array_append(missing, 'workitem_lane.task_statuses does not map every "TaskStatus" label exactly once');
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'TicketStatus'
    ) AND NOT EXISTS (
      SELECT e.enumlabel::text FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'TicketStatus'
      EXCEPT
      SELECT unnest(ticket_statuses)::text FROM "workitem_lane"
    ) AND NOT EXISTS (
      SELECT unnest(ticket_statuses)::text FROM "workitem_lane"
      EXCEPT
      SELECT e.enumlabel::text FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'TicketStatus'
    ) INTO have;
    IF NOT have THEN
      missing := array_append(missing, 'workitem_lane.ticket_statuses does not map every "TicketStatus" label exactly once');
    END IF;
  END IF;

  -- ── 10/11. Privileged functions are SECURITY DEFINER with a pinned search_path ──
  -- 20261023000300_audit_privacy. They write to the append-only spine, so the
  -- privilege and the path are the invariant: a SECURITY INVOKER version, or one
  -- resolving through a writable schema, is a different (and weaker) object even
  -- when the body is identical.
  SELECT count(*) = 2
     AND count(DISTINCT p.proname) = 2
    INTO have
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('pseudonymize_actor', 'prune_activity_log')
      AND p.prosecdef
      AND EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS setting
        WHERE setting LIKE 'search_path=%'
          AND setting LIKE '%pg_catalog%'
          AND setting NOT LIKE '%public%'
      );
  IF NOT have THEN
    missing := array_append(missing, 'pseudonymize_actor / prune_activity_log are not both SECURITY DEFINER with a search_path pinned to pg_catalog (no writable schema)');
  END IF;

  SELECT count(*) = 2 AND bool_and(t.tgdeferrable AND t.tginitdeferred AND t.tgenabled = 'O')
    INTO have FROM pg_trigger t
    JOIN pg_class r ON r.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
      AND p.proname = 'enforce_equipment_connection_pair'
      AND ((r.relname = 'EquipmentConnection' AND t.tgname = 'equipment_connection_two_ends')
        OR (r.relname = 'EquipmentConnectionEnd' AND t.tgname = 'equipment_connection_end_two_ends'));
  IF NOT have THEN
    missing := array_append(missing, 'equipment connection pair constraint triggers are missing, disabled or not initially deferred');
  END IF;

  -- ── 12/13. Statement-kind counts after additive migrations ──
  -- Exact, because each counted statement kind maps one-to-one onto a catalog
  -- row: 28 CREATE TYPE = 28 enum types, 72 FOREIGN KEY = 72 contype 'f',
  -- 2 EXCLUDE USING = 2 contype 'x', and the sixteen named CHECKs.
  SELECT count(*) = 28 INTO have
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e';
  IF NOT have THEN
    missing := array_append(missing, 'public schema does not hold exactly the 28 enum types the migrations create');
  END IF;

  SELECT count(*) = 72 INTO have
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public' AND c.contype = 'f';
  IF NOT have THEN
    missing := array_append(missing, 'public schema does not hold exactly the 72 foreign keys the migrations create');
  END IF;

  SELECT count(*) = 2 INTO have
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public' AND c.contype = 'x';
  IF NOT have THEN
    missing := array_append(missing, 'public schema does not hold exactly the 2 EXCLUDE constraints the baseline creates');
  END IF;

  SELECT count(*) = 16 INTO have
    FROM pg_constraint
    WHERE conname IN ('room_renewal_order', 'time_entry_interval_positive', 'equipment_function_group_name', 'equipment_kind_name', 'custom_field_key', 'custom_field_name', 'custom_field_help', 'custom_field_section', 'custom_field_unit', 'custom_field_option_label', 'room_custom_values', 'equipment_custom_values', 'list_columns_shape', 'custom_field_library_scope', 'equipment_model_custom_values', 'ticket_impact_values')
      AND contype = 'c';
  IF NOT have THEN
    missing := array_append(missing, 'room, timer, equipment kind/group or custom field CHECK constraints are missing');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_impact_values' AND conrelid = '"Ticket"'::regclass
      AND contype = 'c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%impact%IS NULL%DOWN%LIMITED%'
  ) INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'ticket impact must be empty, DOWN or LIMITED');
  END IF;

  -- Index floor, deliberately a floor: the 107 surviving CREATE INDEX statements are only
  -- part of what pg_indexes reports (every primary key and unique constraint
  -- also owns an index, and each EXCLUDE constraint owns one), so an exact
  -- catalog total is NOT derivable from the migration text. 107 is the number the
  -- text itself creates. The database's own constraint indexes also count, so
  -- the check stays a floor rather than an exact total.
  SELECT count(*) >= 107 INTO have
    FROM pg_indexes WHERE schemaname = 'public';
  IF NOT have THEN
    missing := array_append(missing, 'public schema holds fewer than the 107 explicitly created indexes (pg_indexes count)');
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
    WHERE idx.relname = 'EquipmentModel_catalogKey_key' AND i.indisunique AND i.indisvalid
      AND pg_get_indexdef(i.indexrelid) LIKE '%("catalogKey")') INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'model catalog key unique index is missing or invalid');
  END IF;

  SELECT count(*) = 2 INTO have FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    WHERE idx.relname IN ('equipment_function_group_active_name', 'equipment_kind_active_name')
      AND i.indisunique AND i.indisvalid
      AND pg_get_expr(i.indexprs, i.indrelid) = 'lower(name)'
      AND pg_get_expr(i.indpred, i.indrelid) = '("archivedAt" IS NULL)';
  IF NOT have THEN
    missing := array_append(missing, 'case-insensitive active equipment kind/group name indexes are missing or have the wrong definition');
  END IF;

  SELECT count(*) = 3 INTO have FROM pg_constraint
    WHERE conname IN ('EquipmentKind_groupId_fkey', 'Equipment_kindId_fkey', 'EquipmentModel_kindId_fkey')
      AND contype = 'f' AND confdeltype = 'r';
  IF NOT have THEN
    missing := array_append(missing, 'equipment kind/group RESTRICT foreign keys are missing');
  END IF;

  SELECT count(*) = 3 INTO have FROM pg_constraint
    WHERE conname IN ('CustomFieldKind_fieldId_fkey', 'CustomFieldKind_kindId_fkey', 'CustomFieldOption_fieldId_fkey')
      AND contype = 'f' AND ((conname = 'CustomFieldKind_kindId_fkey' AND confdeltype = 'r')
        OR (conname <> 'CustomFieldKind_kindId_fkey' AND confdeltype = 'c'));
  IF NOT have THEN
    missing := array_append(missing, 'custom field option/kind foreign keys are missing or have wrong deletion actions');
  END IF;

  SELECT count(*) = 2 INTO have FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
    WHERE i.indisunique AND i.indisvalid AND (
      (idx.relname = 'CustomField_scope_key_key' AND pg_get_indexdef(i.indexrelid) LIKE '%(scope, key)')
      OR (idx.relname = 'custom_field_option_active_label' AND pg_get_expr(i.indexprs, i.indrelid) = 'lower(label)'
        AND pg_get_expr(i.indpred, i.indrelid) = '("archivedAt" IS NULL)'));
  IF NOT have THEN
    missing := array_append(missing, 'custom field key and active option label unique indexes are missing or invalid');
  END IF;

  SELECT count(*) = 3 INTO have FROM pg_attribute a
    JOIN pg_class r ON r.oid = a.attrelid JOIN pg_namespace n ON n.oid = r.relnamespace
    JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND r.relname IN ('Room', 'Equipment', 'EquipmentModel') AND a.attname = 'customValues'
      AND a.attnotnull AND a.atttypid = 'jsonb'::regtype AND pg_get_expr(d.adbin, d.adrelid) = '''{}''::jsonb';
  IF NOT have THEN
    missing := array_append(missing, 'room/device/model custom values JSONB columns require NOT NULL and the empty-object default');
  END IF;
  SELECT count(*) = 3 INTO have FROM pg_constraint WHERE conname IN ('room_custom_values', 'equipment_custom_values', 'equipment_model_custom_values')
    AND convalidated AND pg_get_constraintdef(oid) LIKE '%jsonb_typeof%' AND pg_get_constraintdef(oid) LIKE '%pg_column_size%' AND pg_get_constraintdef(oid) LIKE '%32768%';
  IF NOT have THEN
    missing := array_append(missing, 'custom values object/32 KB CHECK definitions are missing');
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'list_columns_shape'
    AND conrelid = '"ListColumns"'::regclass AND convalidated
    AND pg_get_constraintdef(oid) LIKE '%cardinality%'
    AND pg_get_constraintdef(oid) LIKE '%12%'
    AND pg_get_constraintdef(oid) LIKE '%name%') INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'list columns must contain 1 to 12 columns with the name first');
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_field_library_scope'
    AND conrelid = '"CustomField"'::regclass AND convalidated
    AND pg_get_constraintdef(oid) LIKE '%systemKey%IS NULL%EQUIPMENT%') INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'library properties must have EQUIPMENT scope');
  END IF;
  SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
    WHERE idx.relname = 'CustomFieldOption_fieldId_systemKey_key' AND i.indisunique AND i.indisvalid
      AND pg_get_indexdef(i.indexrelid) LIKE '%("fieldId", "systemKey")%') INTO have;
  IF NOT have THEN
    missing := array_append(missing, 'library option keys must be unique within their property');
  END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Jiangtang invariant check FAILED — % missing invariant(s): %',
      array_length(missing, 1), array_to_string(missing, '; ')
      USING HINT = 'Do not deploy onto this database until `prisma migrate deploy` has applied the seven-file baseline in prisma/migrations/';
  END IF;

  RAISE NOTICE 'Jiangtang invariants OK: 2 EXCLUDE constraints, ENABLE ALWAYS audit trigger, vector + pg_trgm extensions, Chunk HNSW index, one-running-timer index, seven-name ledger prefix, five workitem lanes covering both enums, 2 pinned SECURITY DEFINER functions, 2 connection-pair triggers, equipment kind/group active names and RESTRICT references, library property scope and option keys, unique model catalog keys, 28 enums / 72 foreign keys / 16 CHECKs, >=107 public indexes';
END
$verify$;
