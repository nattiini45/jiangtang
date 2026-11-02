import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { createTask, moveTask, setTaskAssignees } from "~/domains/tasks/tasks.mutations.server";
import { addTaskBlocker } from "~/domains/tasks/tasks.dependencies.server";
import { raiseTicketFromTask } from "~/domains/tasks/tasks.harmony.server";
import { getTask } from "~/domains/tasks/tasks.queries.server";
import { getTicket } from "~/domains/tickets/tickets.queries.server";
import { ValidationError } from "~/lib/errors.server";

/**
 * The task-core exit walk — one integration pass over everything the task
 * core must do together, through the domain API the routes call: move across
 * lanes, block, refuse the cycle (the 2-edge reverse AND a 3-chain), assign
 * with a per-person estimate, raise the ticket — then reload both sides and
 * prove the harmony links still hold in BOTH directions.
 *
 * The domain tests cover each verb alone; this exists to cover them
 * COMPOSING — the refusal paths especially, since every one must leave no
 * audit row behind.
 */
const RUN = `tasksexit_${Date.now().toString(36)}`;
const actor = { id: null, name: "tasks exit", email: `${RUN}@t.local` };

const taskIds: string[] = [];
const ticketIds: string[] = [];
const userIds: string[] = [];

async function make(title: string) {
  const t = await createTask(actor, { title: `${RUN} ${title}`, status: "BACKLOG", labels: [] });
  taskIds.push(t.id);
  return t;
}

const auditsFor = (entityType: string, entityId: string) =>
  db.activityLog.count({ where: { entityType, entityId } });

afterAll(async () => {
  for (const id of [...taskIds].reverse())
    await db.task.delete({ where: { id } }).catch(() => undefined);
  for (const id of ticketIds) await db.ticket.delete({ where: { id } }).catch(() => undefined);
  for (const id of userIds) await db.user.delete({ where: { id } }).catch(() => undefined);
  await db.$disconnect();
});

describe("tasks exit — move, block, assign, raise, links hold", () => {
  it("composes the whole flow end to end", async () => {
    const a = await make("alpha");
    const b = await make("beta");
    const c = await make("gamma");

    // 1. Move across lanes: BACKLOG → IN_PROGRESS maps the status and moves
    //    the card to the new lane's tail.
    const moved = await moveTask(actor, a.id, { lane: "IN_PROGRESS" });
    expect(moved.status).toBe("IN_PROGRESS");
    expect(moved.position.toNumber()).toBeGreaterThanOrEqual(1);

    // 2. a is blocked by b; the reverse edge (b blocked by a) would close the
    //    2-cycle and is refused — and writes nothing.
    await addTaskBlocker(actor, a.id, b.id);
    const auditsBeforeRefusals = await auditsFor("task", b.id);
    await expect(addTaskBlocker(actor, b.id, a.id)).rejects.toThrow(ValidationError);
    // 3-chain: c ← b already holds transitively through a? No — c is fresh;
    //    make c blocked by a, then b ← c would close a←b←c... the cycle is
    //    b→? Let the chain be a←b and a←c, then c blocked by b is fine but
    //    b blocked by c closes b→a? Walk it: c is blocked by a; b is blocked
    //    by nothing. "b blocked by c" is legal UNLESS b is reachable from c
    //    via blockers — c's blockers: a; a's blockers: b. So c→a→b — b IS
    //    reachable: the edge closes a 3-cycle.
    await addTaskBlocker(actor, c.id, a.id);
    await expect(addTaskBlocker(actor, b.id, c.id)).rejects.toThrow(ValidationError);
    expect(await auditsFor("task", b.id)).toBe(auditsBeforeRefusals); // refusals wrote no audit row

    // 3. Assign with a per-person estimate — TaskAssignees.estimateMinutes.
    const user = await db.user.create({
      data: { email: `${RUN}@test.local`, name: `${RUN} dev`, initials: "WD" },
    });
    userIds.push(user.id);
    await setTaskAssignees(actor, a.id, [{ userId: user.id, estimateMinutes: 45 }]);
    expect(
      await db.taskAssignees.findUniqueOrThrow({
        where: { taskId_userId: { taskId: a.id, userId: user.id } },
      }),
    ).toMatchObject({ estimateMinutes: 45 });

    // 4. Raise the ticket — the harmony write: OPEN, priority mapped,
    //    assignees copied, BOTH link columns set.
    const { ticket } = await raiseTicketFromTask(actor, a.id, { type: "INCIDENT" });
    ticketIds.push(ticket.id);

    // 5. Reload BOTH rows and prove the links hold in both directions.
    const reTask = await getTask(a.id);
    const reTicket = await getTicket(ticket.id);
    expect(reTask!.ticket?.id).toBe(ticket.id);
    expect(reTicket!.task?.id).toBe(a.id);
    expect(reTicket!.linkedTasks.map((t) => t.id)).toContain(a.id);
    expect(reTask!.primaryForTickets.map((t) => t.id)).toContain(ticket.id);
    expect(reTicket!.assignees.map((u) => u.id)).toContain(user.id);
    expect(reTicket!.status).toBe("OPEN");
  });
});
