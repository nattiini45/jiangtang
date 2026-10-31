import { db, type Tx } from "~/lib/db.server";

/**
 * Query-only dashboard module. The card reads themselves live in the
 * owning domains (tasks, tickets, activity, attachments); this folder holds
 * the genuinely cross-domain question — "is the workspace empty?" — which no
 * single owner can answer. `FOLDERS` key is `[]`: reads only, no writes.
 */

/** The models the empty check counts — first-run means none of these exist. */
type WorkspaceCountsClient = Pick<Tx, "task" | "project" | "note" | "inventoryItem">;

/**
 * First-run gate: true while the workspace holds zero tasks, zero
 * projects, zero notes and zero stock items — the four cards the empty state
 * offers to create. Takes an optional client so a test can ask the question
 * inside a transaction it will roll back.
 */
export async function workspaceIsEmpty(client: WorkspaceCountsClient = db): Promise<boolean> {
  const [tasks, projects, notes, stockItems] = await Promise.all([
    client.task.count(),
    client.project.count(),
    client.note.count(),
    client.inventoryItem.count(),
  ]);
  return tasks + projects + notes + stockItems === 0;
}
