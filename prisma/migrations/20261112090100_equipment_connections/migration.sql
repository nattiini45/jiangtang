CREATE TABLE "EquipmentConnection" (
  "id" TEXT NOT NULL,
  "note" TEXT,
  CONSTRAINT "EquipmentConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EquipmentConnectionEnd" (
  "portId" TEXT NOT NULL,
  "equipmentId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  CONSTRAINT "EquipmentConnectionEnd_pkey" PRIMARY KEY ("portId")
);

CREATE UNIQUE INDEX "EquipmentConnectionEnd_connectionId_equipmentId_key" ON "EquipmentConnectionEnd"("connectionId", "equipmentId");
CREATE UNIQUE INDEX "EquipmentConnectionEnd_portId_equipmentId_key" ON "EquipmentConnectionEnd"("portId", "equipmentId");
CREATE UNIQUE INDEX "EquipmentPort_id_equipmentId_key" ON "EquipmentPort"("id", "equipmentId");

ALTER TABLE "EquipmentConnectionEnd" ADD CONSTRAINT "EquipmentConnectionEnd_portId_equipmentId_fkey" FOREIGN KEY ("portId", "equipmentId") REFERENCES "EquipmentPort"("id", "equipmentId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "EquipmentConnectionEnd" ADD CONSTRAINT "EquipmentConnectionEnd_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "EquipmentConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION enforce_equipment_connection_pair() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE
  ids text[] := ARRAY[]::text[];
  target_id text;
BEGIN
  IF TG_TABLE_NAME = 'EquipmentConnection' THEN
    IF TG_OP <> 'DELETE' THEN ids := array_append(ids, NEW.id); END IF;
    IF TG_OP <> 'INSERT' THEN ids := array_append(ids, OLD.id); END IF;
  ELSE
    IF TG_OP <> 'DELETE' THEN ids := array_append(ids, NEW."connectionId"); END IF;
    IF TG_OP <> 'INSERT' THEN ids := array_append(ids, OLD."connectionId"); END IF;
  END IF;
  FOREACH target_id IN ARRAY ids LOOP
    IF EXISTS (SELECT 1 FROM public."EquipmentConnection" WHERE id = target_id)
       AND (SELECT count(*) FROM public."EquipmentConnectionEnd" WHERE "connectionId" = target_id) <> 2 THEN
      RAISE EXCEPTION 'An equipment connection must have exactly two ends'
        USING ERRCODE = '23514', CONSTRAINT = 'equipment_connection_pair';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER equipment_connection_two_ends
AFTER INSERT OR UPDATE OR DELETE ON "EquipmentConnection"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION enforce_equipment_connection_pair();

CREATE CONSTRAINT TRIGGER equipment_connection_end_two_ends
AFTER INSERT OR UPDATE OR DELETE ON "EquipmentConnectionEnd"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION enforce_equipment_connection_pair();
