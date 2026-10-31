-- Functional baseline, file 4 of 7: audit immutability and privileged erasure.
--
-- Responsibility: the final state of the ActivityLog append-only guard and the
-- two privileged functions that are allowed to step around it, with the exact
-- security attributes and ACLs the reference installation holds.
--
-- The guard is two objects, both written here in their final form:
--   * jiangtang_activitylog_immutable() raises restrict_violation (SQLSTATE
--     23001) on any UPDATE or DELETE unless the transaction-local GUC
--     jiangtang.audit_bypass is 'on';
--   * activitylog_no_update_delete, a BEFORE ROW trigger on "ActivityLog" that
--     runs it and is set ENABLE ALWAYS.
-- ENABLE ALWAYS is load-bearing, not decoration: a default-enabled trigger is
-- skipped whenever session_replication_role is 'replica', which is exactly the
-- standard knob the old design used as its escape hatch. The reference catalog
-- records tgenabled = 'A' for this trigger, so it fires in every replication
-- role, and the only remaining bypass is the GUC below.
--
-- The bypass is a single mechanism: current_setting('jiangtang.audit_bypass',
-- true) read by the guard, and pg_catalog.set_config('jiangtang.audit_bypass',
-- 'on', true) called by the two SECURITY DEFINER functions below. The `true`
-- third argument makes the setting transaction-local, so it resets by itself at
-- COMMIT or ROLLBACK and no function has to restore it. Omitted as obsolete,
-- because this baseline creates each object once, in its final form:
--   * any guard body without a bypass branch: the guard below is the only
--     definition this file creates;
--   * any session_replication_role = 'replica' / 'origin' toggling body for
--     pseudonymize_actor and prune_activity_log, and any SET search_path =
--     public in them: both are replaced by the jiangtang.audit_bypass
--     mechanism and the pinned search_path below;
--   * any DROP TRIGGER before the CREATE TRIGGER and any separate ALTER TABLE
--     ... ENABLE ALWAYS: a fresh install has no trigger to drop, so the
--     trigger is created once and then enabled ALWAYS.
-- No obsolete bypass implementation survives in this file.
--
-- Security attributes are the measured ones. Both privileged functions are
-- SECURITY DEFINER with SET search_path = pg_catalog, pg_temp: no writable
-- schema is on the path, and every built-in and the public."ActivityLog"
-- relation are fully qualified. The guard function itself is SECURITY INVOKER
-- with no search_path setting, exactly as recorded; it is not hardened here,
-- because changing an attribute the reference does not carry would be a silent
-- authorization change.
--
-- Privileges are written exactly as the reference holds them. The two
-- privileged functions carry proacl {jiangtang=X/jiangtang} - owner EXECUTE
-- only, no PUBLIC entry - reproduced by revoking EXECUTE from PUBLIC. The guard
-- function carries no proacl, i.e. the default state, under which PUBLIC still
-- holds EXECUTE; that default is deliberately left untouched. "ActivityLog"
-- carries an explicit relacl {jiangtang=arwdDxtm/jiangtang} - the owner's full
-- privilege set with no PUBLIC entry - whereas every other relation in the
-- reference has no relacl at all; the REVOKE below reproduces that
-- materialized owner ACL. No grant, revoke or default privilege beyond these
-- three statements is recorded, so none is invented: the reference role is a
-- superuser, and this capture cannot demonstrate least-privilege behaviour.

-- ===========================================================================
-- Append-only guard
-- ===========================================================================

CREATE OR REPLACE FUNCTION jiangtang_activitylog_immutable()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('jiangtang.audit_bypass', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'ActivityLog is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$function$;

CREATE TRIGGER activitylog_no_update_delete
  BEFORE DELETE OR UPDATE ON "ActivityLog"
  FOR EACH ROW EXECUTE FUNCTION jiangtang_activitylog_immutable();

ALTER TABLE "ActivityLog" ENABLE ALWAYS TRIGGER activitylog_no_update_delete;

-- ===========================================================================
-- Privileged functions
-- ===========================================================================

-- pseudonymize_actor: replace an actor's identifying snapshot (name/email) with
-- initials-only across the audit log, keeping the row and its attribution
-- intact ("pseudonymization, not deletion"). Returns the number of rows
-- touched.
CREATE OR REPLACE FUNCTION pseudonymize_actor(target_actor_id text)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  affected integer;
BEGIN
  -- Set the transaction-local bypass flag so the immutability trigger (which is
  -- now ENABLE ALWAYS and no longer honours session_replication_role) lets this
  -- UPDATE through. This is the ONLY sanctioned escape hatch; the function's
  -- SECURITY DEFINER + the admin-gated call sites in the app make this auditable
  -- and narrow. Transaction-local (`true` as the third arg to set_config), so it
  -- resets automatically at COMMIT/ROLLBACK — no need to restore it.
  PERFORM pg_catalog.set_config('jiangtang.audit_bypass', 'on', true);
  UPDATE public."ActivityLog"
    SET "actorSnapshot" = pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object('initials', "actorSnapshot"->>'initials')
    )::jsonb
    WHERE "actorId" = target_actor_id
      AND "actorSnapshot" IS NOT NULL
      AND ("actorSnapshot"->>'name' IS NOT NULL OR "actorSnapshot"->>'email' IS NOT NULL);
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$function$;

-- prune_activity_log: delete audit rows older than the cutoff (retention
-- windows). Runs as the retention boot job (daily tick). Returns rows deleted.
CREATE OR REPLACE FUNCTION prune_activity_log(cutoff timestamptz)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  deleted integer;
BEGIN
  PERFORM pg_catalog.set_config('jiangtang.audit_bypass', 'on', true);
  DELETE FROM public."ActivityLog" WHERE "occurredAt" < cutoff;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$function$;

-- ===========================================================================
-- Privileges
-- ===========================================================================

-- "ActivityLog": the owner keeps every privilege; PUBLIC holds UPDATE and
-- DELETE on no table by default, and this REVOKE is what gives the relation
-- the explicit owner-only relacl the reference records.
REVOKE UPDATE, DELETE ON "ActivityLog" FROM PUBLIC;

-- The two privileged functions are owner-executable only. The guard function
-- above is not revoked: the reference records the default ACL for it, under
-- which PUBLIC may still execute a function that can only raise.
REVOKE EXECUTE ON FUNCTION pseudonymize_actor(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prune_activity_log(timestamptz) FROM PUBLIC;
