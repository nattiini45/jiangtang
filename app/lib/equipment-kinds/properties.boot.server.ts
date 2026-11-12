import { reconcileLibrary } from "~/lib/custom-fields/library.server";

export const order = 1;
export async function register() {
  try {
    await reconcileLibrary();
  } catch (error) {
    console.error(
      "[equipment-properties] library reconcile failed; will retry on next start",
      error,
    );
  }
}
