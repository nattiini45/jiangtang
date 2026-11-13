import type { EquipmentStatus, FaultImpact, FunctionRole } from "~/generated/prisma/client";

type Device = {
  id: string;
  role: FunctionRole;
  status: EquipmentStatus;
  statusSince: Date | null;
  substitutedBy: { status: EquipmentStatus } | null;
};
type Fault = {
  id: string;
  equipmentId: string | null;
  functionId: string | null;
  impact: FaultImpact | null;
  occurredAt: Date;
};

export function deriveFunctionState(devices: Device[], faults: Fault[]) {
  const evidence: {
    state: "DOWN" | "LIMITED";
    since: Date | null;
    deviceId?: string;
    ticketId?: string;
  }[] = [];
  const out = (device: Device) =>
    !(device.substitutedBy?.status === "OPERATIONAL") &&
    (device.status !== "OPERATIONAL" ||
      faults.some((fault) => !fault.functionId && fault.equipmentId === device.id));
  const carriers = devices.filter((device) => device.role === "CARRIER");
  const allOut = carriers.length > 0 && carriers.every(out);
  for (const device of devices) {
    if (!out(device)) continue;
    const deviceFaults = faults.filter(
      (fault) => !fault.functionId && fault.equipmentId === device.id,
    );
    const times = [
      ...(device.status !== "OPERATIONAL" ? [device.statusSince] : []),
      ...deviceFaults.map((fault) => fault.occurredAt),
    ];
    evidence.push({
      state: device.role === "CARRIER" && allOut ? "DOWN" : "LIMITED",
      since: times.some((time) => time === null)
        ? null
        : new Date(Math.min(...times.map((time) => time!.getTime()))),
      deviceId: device.id,
      ticketId: deviceFaults[0]?.id,
    });
  }
  for (const fault of faults.filter((fault) => fault.functionId))
    evidence.push({
      state: fault.impact ?? "LIMITED",
      since: fault.occurredAt,
      ticketId: fault.id,
    });
  const state: "DOWN" | "LIMITED" | "NO_KNOWN_FAULT" = evidence.some(
    (entry) => entry.state === "DOWN",
  )
    ? "DOWN"
    : evidence.length
      ? "LIMITED"
      : "NO_KNOWN_FAULT";
  const causes = evidence
    .filter((entry) => entry.state === state)
    .sort((a, b) => (a.since?.getTime() ?? -Infinity) - (b.since?.getTime() ?? -Infinity));
  return { state, since: causes[0]?.since ?? null, causes };
}
