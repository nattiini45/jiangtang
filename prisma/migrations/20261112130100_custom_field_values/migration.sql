ALTER TABLE "Room" ADD COLUMN "customValues" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "Equipment" ADD COLUMN "customValues" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "Room" ADD CONSTRAINT room_custom_values CHECK (jsonb_typeof("customValues") = 'object' AND pg_column_size("customValues") <= 32768);
ALTER TABLE "Equipment" ADD CONSTRAINT equipment_custom_values CHECK (jsonb_typeof("customValues") = 'object' AND pg_column_size("customValues") <= 32768);
