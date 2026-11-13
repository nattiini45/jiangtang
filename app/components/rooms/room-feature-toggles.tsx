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

export function RoomFeatureToggles({
  defaults,
  expectations = false,
}: {
  defaults?: RoomFlags;
  expectations?: boolean;
}) {
  const t = useT();
  return (
    <fieldset className="bg-card shadow-surface-2 grid grid-cols-2 gap-2 rounded-lg p-4 sm:grid-cols-3">
      <legend className="text-muted-foreground px-1 text-xs">{t("rooms.features.legend")}</legend>
      {FLAGS.filter(
        (f) => !expectations || f.name === "hasBlackboard" || f.name === "mediaKeyRequired",
      ).map((f) => (
        <label key={f.name} className="flex items-center gap-2 text-sm">
          <Checkbox name={f.name} defaultChecked={defaults?.[f.name] ?? false} />
          {t(f.labelKey)}
        </label>
      ))}
    </fieldset>
  );
}
