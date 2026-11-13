export function expectedFunctionIds(
  room: {
    roomTypeId: string | null;
    roomType: { functions: { functionId: string }[] } | null;
    functionExpectations: { functionId: string; expected: boolean }[];
  },
  served: string[],
) {
  const expected = new Set(
    room.roomTypeId ? room.roomType?.functions.map((row) => row.functionId) : served,
  );
  for (const row of room.functionExpectations) {
    if (row.expected) expected.add(row.functionId);
    else expected.delete(row.functionId);
  }
  return expected;
}

export const legacyFunctionFlags = {
  picture: "hasProjector",
  sound: "hasMicrophony",
  conferencing: "hasWebConference",
  recording: "hasAutoRecording",
} as const;

export function servedFunctionIds(
  functions: { id: string; kinds: { kindId: string; role: string }[] }[],
  devices: { kindId: string | null; status: string }[],
) {
  return functions
    .filter((fn) =>
      fn.kinds.some(
        (link) =>
          link.role === "CARRIER" &&
          devices.some((device) => device.status !== "RETIRED" && device.kindId === link.kindId),
      ),
    )
    .map((fn) => fn.id);
}
