import type { listDeviceKinds } from "~/lib/equipment-kinds/kinds.server";

export type KindGroups = Awaited<ReturnType<typeof listDeviceKinds>>;

export function KindOptions({ groups }: { groups: KindGroups }) {
  return groups
    .filter((group) => group.kinds.length > 0)
    .map((group) => (
      <optgroup key={group.id} label={group.name}>
        {group.kinds.map((kind) => (
          <option key={kind.id} value={kind.id}>
            {kind.name}
          </option>
        ))}
      </optgroup>
    ));
}
