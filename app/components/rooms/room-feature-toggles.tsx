import { Checkbox } from "~/components/ui/checkbox";
import type { MessageKey } from "~/i18n";
import { useT } from "~/i18n/use-t";

const FLAGS = [
  { name: "hasProjector", labelKey: "rooms.features.hasProjector" },
  { name: "hasMicrophony", labelKey: "rooms.features.hasMicrophony" },
  { name: "hasBlackboard", labelKey: "rooms.features.hasBlackboard" },
  { name: "hasWebConference", labelKey: "rooms.features.hasWebConference" },
  { name: "hasAutoRecording", labelKey: "rooms.features.hasAutoRecording" },
  { name: "mediaKeyRequired", labelKey: "rooms.features.mediaKeyRequired" },
] as const satisfies ReadonlyArray<{ name: string; labelKey: MessageKey }>;

export type RoomFlagName = (typeof FLAGS)[number]["name"];
export type RoomFlags = Partial<Record<RoomFlagName, boolean>>;

export function RoomFeatureToggles({ defaults }: { defaults?: RoomFlags }) {
  const t = useT();
  return (
    <fieldset className="border-border grid grid-cols-2 gap-2 border p-3 sm:grid-cols-3">
      <legend className="text-muted-foreground px-1 text-xs uppercase tracking-wide">
        {t("rooms.features.legend")}
      </legend>
      {FLAGS.map((f) => (
        <label key={f.name} className="flex items-center gap-2 text-sm">
          <Checkbox name={f.name} defaultChecked={defaults?.[f.name] ?? false} />
          {t(f.labelKey)}
        </label>
      ))}
    </fieldset>
  );
}
