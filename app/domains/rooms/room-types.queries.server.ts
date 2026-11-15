import { db } from "~/lib/db.server";
import { currentLocale } from "~/i18n/request-locale.server";
import library from "~/lib/equipment-kinds/library.json" with { type: "json" };
import { listRoomFunctions, getFunctionStates } from "~/domains/functions/functions.queries.server";

export async function listRoomTypes() {
  const locale = currentLocale();
  const rows = await db.roomType.findMany({
    where: { archivedAt: null },
    include: { functions: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    ...row,
    name:
      (!row.renamed && library.roomTypes.find((type) => type.key === row.systemKey)?.[locale]) ||
      row.name,
  }));
}

export async function roomExpectationFields(roomId?: string) {
  const [types, functions, expectations, states] = await Promise.all([
    listRoomTypes(),
    listRoomFunctions(),
    roomId ? db.roomFunctionExpectation.findMany({ where: { roomId } }) : [],
    roomId ? getFunctionStates({ roomIds: [roomId] }) : [],
  ]);
  return {
    types,
    functions,
    expectations,
    servedIds: states.filter((row) => row.hasCarrier).map((row) => row.functionId),
  };
}
