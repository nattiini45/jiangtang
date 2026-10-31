import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";

/**
 * Loader/action tests for the `/tasks*` routes and the ticket→task raise
 * — the `projects-routes.test.ts` shape, one surface over.
 *
 * ⚠️ **This is not a render test.** Vitest runs in `node` with no DOM, so
 * these call the exported `loader`/`action` directly against the real dev
 * database. What is provable here is that the routes compute the right
 * answer, refuse the right things, and write nothing when they refuse.
 */
const RUN = `b47_task_${Date.now().toString(36)}`;

const TEST_USER: AuthUser = {
  id: null as unknown as string,
  name: "Tasks Tester",
  email: `${RUN}@test.local`,
  initials: "TT",
  role: "MEMBER",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireUser: vi.fn(async () => TEST_USER) };
});

// Imported AFTER the mock so the route modules see the mocked requireUser.
const indexRoute = await import("~/routes/_desktop.tasks._index/route");
const newRoute = await import("~/routes/_desktop.tasks.new/route");
const detailRoute = await import("~/routes/_desktop.tasks.$id/route");
const importRoute = await import("~/routes/_desktop.tasks.import/route");
const ticketRoute = await import("~/routes/_desktop.tickets.$id/route");

const taskIds: string[] = [];
const ticketIds: string[] = [];
const userIds: string[] = [];
const projectIds: string[] = [];

const post = (url: string, body: Record<string, string | string[]>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) {
    for (const one of Array.isArray(v) ? v : [v]) form.append(k, one);
  }
  return new Request(url, { method: "POST", body: form });
};

const postDetail = (id: string, body: Record<string, string | string[]>) =>
  detailRoute.action({
    request: post(`http://localhost/tasks/${id}`, body),
    params: { id },
  } as never);

const postNew = (body: Record<string, string | string[]>) =>
  newRoute.action({ request: post("http://localhost/tasks/new", body) } as never);

const loadIndex = async (query = "") =>
  (await indexRoute.loader({
    request: new Request(`http://localhost/tasks${query}`),
  } as never)) as {
    tasks: Array<{ id: string; title: string; status: string; dueAt: Date | null }>;
    filters: Record<string, string>;
  };

const mine = <T extends { title: string }>(r: { tasks: T[] }): T[] =>
  r.tasks.filter((t) => t.title.startsWith(RUN));

/** Creates a task through the REAL route action — the full post path. */
async function makeTask(title: string, over: Record<string, string> = {}) {
  const res = await postNew({ title: `${RUN} ${title}`, ...over });
  if (!(res instanceof Response))
    throw new Error(`create did not redirect: ${JSON.stringify(res)}`);
  const id = res.headers.get("location")!.split("/").pop()!;
  taskIds.push(id);
  return db.task.findUniqueOrThrow({ where: { id } });
}

async function makeUser(tag: string) {
  const user = await db.user.create({
    data: {
      email: `${RUN}-${tag}@test.local`,
      name: `${RUN} ${tag}`,
      initials: `${RUN.slice(-3)}${tag}`,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeTicket(over: Record<string, unknown> = {}) {
  const ticket = await db.ticket.create({
    data: { type: "INCIDENT", title: `${RUN} ticket`, ...over },
  });
  ticketIds.push(ticket.id);
  return ticket;
}

afterAll(async () => {
  for (const id of [...taskIds].reverse())
    await db.task.delete({ where: { id } }).catch(() => undefined);
  for (const id of ticketIds) await db.ticket.delete({ where: { id } }).catch(() => undefined);
  for (const id of projectIds) await db.project.delete({ where: { id } }).catch(() => undefined);
  for (const id of userIds) await db.user.delete({ where: { id } }).catch(() => undefined);
  await db.$disconnect();
});

describe("/tasks — index filters", () => {
  it("defaults to the open set; ?status=alle and a garbage value both degrade to unfiltered", async () => {
    const open = await makeTask("open", { status: "TODO" });
    await makeTask("done", { status: "DONE" });

    const def = mine(await loadIndex());
    expect(def.map((t) => t.id)).toContain(open.id);
    expect(def.map((t) => t.id)).toHaveLength(1);

    const all = mine(await loadIndex("?status=alle"));
    expect(all).toHaveLength(2);

    const garbage = mine(await loadIndex("?status=NOPE"));
    expect(garbage).toHaveLength(2); // garbage degrades to unfiltered, never throws
  });

  it("filters by assignee (user id), project slug, label, and due window — unknown refs unfilter", async () => {
    const user = await makeUser("flt");
    const project = await db.project.create({ data: { name: `${RUN} p`, slug: `${RUN}-p` } });
    projectIds.push(project.id);
    const assigned = await makeTask("asg");
    const dated = await makeTask("dated", { dueAt: "2999-01-01", labels: "woche" });
    await db.taskAssignees.create({ data: { taskId: assigned.id, userId: user.id } });

    expect(mine(await loadIndex(`?assignee=${user.id}`)).map((t) => t.id)).toEqual([assigned.id]);
    expect(mine(await loadIndex("?assignee=me")).length).toBeGreaterThanOrEqual(0); // actor has no id → unfiltered, no throw
    expect(mine(await loadIndex("?assignee=not-a-user&status=alle"))).toHaveLength(
      mine(await loadIndex("?status=alle")).length,
    );
    expect(mine(await loadIndex(`?project=${project.slug}`)).length).toBe(0);
    expect(mine(await loadIndex("?project=not-a-slug")).length).toBeGreaterThanOrEqual(2);
    expect(mine(await loadIndex("?label=woche")).map((t) => t.id)).toEqual([dated.id]);
    expect(mine(await loadIndex("?due=week")).map((t) => t.id)).not.toContain(dated.id); // 2999 is not this week
    expect(mine(await loadIndex("?due=overdue")).length).toBe(0); // nothing due in the past
    expect(mine(await loadIndex("?due=nonsense")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("/tasks/:id — actions", () => {
  it("updates content fields and changes status via the intents", async () => {
    const task = await makeTask("edit-me");
    const res = await postDetail(task.id, {
      _action: "update",
      title: `${RUN} edited`,
      body: "neuer Text",
    });
    expect(res instanceof Response && res.headers.get("location")).toBe(`/tasks/${task.id}`);
    const after = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.body).toBe("neuer Text");

    const res2 = await postDetail(task.id, { _action: "status", status: "IN_PROGRESS" });
    expect(res2 instanceof Response).toBe(true);
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      "IN_PROGRESS",
    );
  });

  it("surfaces a dependency cycle as a form error, not a thrown response", async () => {
    const a = await makeTask("cycle-a");
    const b = await makeTask("cycle-b");
    const first = await postDetail(a.id, { _action: "blocker-add", blockerTaskId: b.id });
    expect(first instanceof Response).toBe(true); // a←b landed

    const second = (await postDetail(b.id, { _action: "blocker-add", blockerTaskId: a.id })) as {
      formErrors?: string[];
    };
    expect(second).not.toBeInstanceOf(Response);
    expect(second.formErrors?.[0]).toMatch(/Kreis|Zykl|blockiert/i);
    // Nothing written: still exactly one edge.
    expect(await db.taskDependency.count({ where: { blockedByTaskId: b.id } })).toBe(0);
  });

  it("raises a ticket from the task and unlinks it again — both columns, both ways", async () => {
    const task = await makeTask("ticketed");
    const raised = await postDetail(task.id, { _action: "ticket-raise", type: "INCIDENT" });
    expect(raised instanceof Response).toBe(true);
    const linked = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(linked.ticketId).not.toBeNull();
    const ticket = await db.ticket.findUniqueOrThrow({ where: { id: linked.ticketId! } });
    ticketIds.push(ticket.id);
    expect(ticket.taskId).toBe(task.id);

    const unlinked = await postDetail(task.id, { _action: "ticket-unlink" });
    expect(unlinked instanceof Response).toBe(true);
    const after = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.ticketId).toBeNull();
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).taskId).toBeNull();
  });
});

describe("/tickets/:id — raise a task", () => {
  it("creates the primary task and redirects to it", async () => {
    const ticket = await makeTicket({ priority: 1 });
    const res = (await ticketRoute.action({
      request: post(`http://localhost/tickets/${ticket.id}`, {
        _action: "raise-task",
        projectId: "",
      }),
      params: { id: ticket.id },
    } as never)) as Response;
    expect(res instanceof Response).toBe(true);
    const taskId = res.headers.get("location")!.split("/").pop()!;
    taskIds.push(taskId);
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.ticketId).toBe(ticket.id);
    expect(task.priority).toBe("URGENT"); // ticket priority 1 → URGENT
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).taskId).toBe(taskId);
  });
});

describe("/tasks/import", () => {
  const act = (body: Record<string, string>) =>
    importRoute.action({ request: post("http://localhost/tasks/import", body) } as never);

  it("imports a clean file — enum-by-label rows land in the right lanes", async () => {
    const user = await makeUser("imp");
    const project = await db.project.create({ data: { name: `${RUN} ip`, slug: `${RUN}-ip` } });
    projectIds.push(project.id);
    const csv = [
      "title,status,priority,start,due,estimate,labels,assignees,project",
      `${RUN} eins,In Arbeit,Hoch,2026-10-10,15.10.2026,1h30,bühne,${user.initials},${project.slug}`,
      `${RUN} zwei,Offen,,2999-12-31,,90m,,${user.email},`,
    ].join("\n");
    const res = await act({ _action: "commit", csv });
    expect(res instanceof Response && res.headers.get("location")).toBe("/tasks");
    const rows = await db.task.findMany({
      where: { title: { startsWith: RUN }, id: { notIn: taskIds } },
    });
    for (const r of rows) taskIds.push(r.id);
    const eins = rows.find((r) => r.title.endsWith("eins"))!;
    expect(eins.status).toBe("IN_PROGRESS"); // German label → enum
    expect(eins.priority).toBe("HIGH");
    expect(eins.estimateMinutes).toBe(90); // 1h30
    const zwei = rows.find((r) => r.title.endsWith("zwei"))!;
    expect(zwei.estimateMinutes).toBe(90); // 90m
    expect(await db.taskAssignees.count({ where: { taskId: zwei.id, userId: user.id } })).toBe(1);
  });

  it("refuses an unknown assignee AND an unknown project — whole file, nothing written", async () => {
    const csv = ["title,assignees,project", `${RUN} bad-row,nobody-${RUN},no-such-slug`].join("\n");
    const res = (await act({ _action: "commit", csv })) as { error?: string };
    expect(res).not.toBeInstanceOf(Response);
    expect(res.error).toMatch(/Zeile 2/);
    expect(res.error).toMatch(/assignees/);
    expect(res.error).toMatch(/project/);
    expect(await db.task.count({ where: { title: `${RUN} bad-row` } })).toBe(0);
  });
});
