import { reconcileRoomTypes } from "./room-types.library.server";

export const order = 2;
export async function register() {
  try {
    await reconcileRoomTypes();
  } catch (error) {
    console.error("[room-types] startup step failed; will retry on next start", error);
  }
}
