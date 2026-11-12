import { reconcileModelCatalog } from "~/domains/catalog/catalog.library.server";
export const order = 2;
export async function register() {
  try {
    await reconcileModelCatalog();
  } catch (error) {
    console.error("[model-catalog] reconcile failed; will retry on next start", error);
  }
}
