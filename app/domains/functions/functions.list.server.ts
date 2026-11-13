import { listCampuses, listBuildings } from "~/domains/rooms/rooms.queries.server";
import { listNotWorking, listRoomFunctions } from "./functions.queries.server";

export async function getFunctionList(request: Request) {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  const filters = {
    functionId: params.get("functionId") || "",
    campusId: params.get("campusId") || "",
    buildingId: params.get("buildingId") || "",
    state: state === "DOWN" || state === "LIMITED" ? state : "",
    unassigned: params.get("unassigned") === "true",
    newestFirst: params.get("sort") === "newest",
  } as const;
  const [rows, functions, campuses, buildings] = await Promise.all([
    listNotWorking({ ...filters, state: filters.state || undefined }),
    listRoomFunctions(),
    listCampuses(),
    listBuildings(),
  ]);
  return { rows, functions, campuses, buildings, filters, now: new Date() };
}
