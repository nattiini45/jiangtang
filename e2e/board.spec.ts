import { test, expect, type Page, type Locator } from "@playwright/test";
import { runPrefix } from "./run";
import { db } from "~/lib/db.server";
import { createTask, moveTask } from "~/domains/tasks/tasks.mutations.server";
import { createProject } from "~/domains/projects/projects.mutations.server";
import type { AuditActor } from "~/lib/audit.server";

/**
 * Board e2e: pointer drag across lanes, keyboard lane move, and
 * keyboard same-lane reorder — each asserted across a reload, so the action
 * round-trips through the server, not just dnd-kit's optimistic state.
 *
 * Fixtures live in a per-run project and the board is opened with its
 * `?project=` filter: the lanes then contain only these cards, which keeps
 * every card inside the viewport — on the full board a Backlog card sits
 * ~2600px down, mouse coordinates are viewport-relative, and a drag dropped
 * in an empty lane region never reaches `closestCenter`'s winning droppable.
 */
const RUN = runPrefix();
const PROJECT_NAME = `${RUN}Projekt`;
const CARD_A = `${RUN}Karte Zeiger`; // Backlog → In Arbeit (pointer)
const CARD_B = `${RUN}Karte Tastatur`; // In Arbeit → Review (keyboard)
const CARD_C = `${RUN}Karte Sortiert Eins`; // same-lane reorder pair
const CARD_D = `${RUN}Karte Sortiert Zwei`;

let boardUrl = "/board";
let actor: AuditActor;
const cardIds: Record<string, string> = {};

// `hasText` is a substring match that also hits elements whose subtree merely
// contains the text — pin the card to the `data-task-card` div that owns the
// exact title link. dnd-kit's role="button"/aria-pressed live on the grip
// handle (a role=button card would nest the title link inside an
// interactive element); its keydown bubbles to the card's listeners.
const card = (page: Page, title: string): Locator =>
  page
    .locator("div[data-task-card]")
    .filter({ has: page.getByRole("link", { name: title, exact: true }) });
const handle = (page: Page, title: string): Locator =>
  page.getByRole("button", { name: `Karte „${title}“` });
const lane = (page: Page, title: string): Locator => page.locator(`[aria-label="${title}"]`);

/** Lane aria-labels in `LANES` order (BACKLOG … CANCELLED). */
const LANE_TITLES = ["Backlog", "In Arbeit", "Review / Blockiert", "Erledigt", "Abgebrochen"];

/** Which lane column currently displays the card — preview-moves included. */
async function cardLaneIndex(page: Page, title: string): Promise<number> {
  for (let i = 0; i < LANE_TITLES.length; i++) {
    if (await lane(page, LANE_TITLES[i]!).locator("a", { hasText: title }).count()) return i;
  }
  return -1;
}

/** Card titles inside a lane, top to bottom. */
async function laneOrder(page: Page, laneTitle: string): Promise<string[]> {
  const cards = lane(page, laneTitle).locator("div[data-task-card] a");
  const texts = await cards.allTextContents();
  return texts.map((t) => t.trim());
}

/** The drop POSTs a fetcher.submit — without waiting for it a reload can race
 *  the request away before it reaches the server. */
function waitForMoveSubmit(page: Page) {
  return page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes("/board"),
    { timeout: 10_000 },
  );
}

/**
 * Lift a card via its grip handle (the element that owns dnd-kit's
 * role="button"/aria-pressed) and wait until the drag is truly active.
 * `useSortable` sets `aria-pressed="true"` on the handle the moment the drag
 * activates — an observable state, not a timer. Activation is also what queues
 * the sensor's `setTimeout` that binds the document-level keydown (which must
 * exist before the first arrow and before the drop Space once a cross-lane
 * preview-move reparents the card and focus falls back to <body>). So:
 * press Space until aria-pressed appears, then one timer turn — our timer is
 * queued after the sensor's own bind timer (FIFO), making the wait exact.
 */
async function liftCard(page: Page, source: Locator) {
  await source.waitFor();
  await source.focus();
  await expect(source).toBeFocused(); // hydration must have landed before keys
  await expect
    .poll(
      async () => {
        // Only press when the drag isn't live yet — a Space during an active
        // keyboard drag is the drop.
        if ((await source.getAttribute("aria-pressed")) !== "true") {
          await page.keyboard.press("Space"); // lift
        }
        return source.getAttribute("aria-pressed");
      },
      { intervals: [100, 150, 200], timeout: 5_000 },
    )
    .toBe("true");
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
}

test.beforeAll(async () => {
  const admin = await db.user.findFirstOrThrow({ where: { email: process.env.ADMIN_EMAIL } });
  actor = { id: admin.id, name: admin.name, email: admin.email, initials: admin.initials };
  // Playwright re-runs beforeAll when the worker restarts after a failed test,
  // so every fixture lookup must be idempotent — create only what is missing.
  const project =
    (await db.project.findFirst({
      where: { name: PROJECT_NAME },
      select: { id: true, slug: true },
    })) ?? (await createProject(actor, { name: PROJECT_NAME, status: "CONFIRMED" }));
  boardUrl = `/board?project=${project.slug}`;

  const existing = await db.task.findMany({
    where: { title: { startsWith: RUN } },
    select: { id: true, title: true },
  });
  const wanted: [string, "BACKLOG" | "IN_PROGRESS"][] = [
    [CARD_A, "BACKLOG"],
    [CARD_B, "IN_PROGRESS"],
    [CARD_C, "BACKLOG"],
    [CARD_D, "BACKLOG"],
  ];
  for (const [title, status] of wanted) {
    const row =
      existing.find((t) => t.title === title) ??
      (await createTask(actor, { title, status, labels: [], projectId: project.id }));
    cardIds[title] = row.id;
  }
});

/**
 * `--repeat-each` reruns each test against the SAME rows — iteration n
 * inherits the lanes iteration n−1 left behind. Re-normalize through
 * `moveTask` (audited, no-op semantics when already correct): appending A, C,
 * D to the Backlog TAIL in that fixed order converges the lane to [A, C, D]
 * from any starting state — so the reorder pair always starts C-above-D.
 * (A `beforeId`-only move can't express „directly above a mid-lane card":
 * `positionBetween(null, next)` answers `next − 1`, which collides whenever
 * `next`'s predecessor already sits there.)
 */
test.beforeEach(async () => {
  await moveTask(actor, cardIds[CARD_A]!, { lane: "BACKLOG" });
  await moveTask(actor, cardIds[CARD_C]!, { lane: "BACKLOG" });
  await moveTask(actor, cardIds[CARD_D]!, { lane: "BACKLOG" });
  await moveTask(actor, cardIds[CARD_B]!, { lane: "IN_PROGRESS" });
});

test.afterAll(async () => {
  await db.$disconnect();
});

test("pointer drag moves a card from Backlog to In Arbeit and persists", async ({ page }) => {
  await page.goto(boardUrl);
  await expect(card(page, CARD_A)).toBeVisible();

  // dnd-kit PointerSensor: down, several moves (activation distance), drop on
  // the lane. The press lands near the card's bottom edge because its centre
  // is the title link, whose pointerdown handler stops propagation for plain
  // clicks and would keep the sensor from ever starting the drag.
  const from = card(page, CARD_A);
  const fromBox = (await from.boundingBox())!;
  const press = { x: fromBox.width / 2, y: fromBox.height - 8 };
  await from.hover({ position: press });
  await page.mouse.down();
  const targetBox = (await lane(page, "In Arbeit").boundingBox())!;
  const moved = waitForMoveSubmit(page);
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 80, { steps: 12 });
  await page.mouse.up();
  await moved;

  await expect(lane(page, "In Arbeit").locator("a", { hasText: CARD_A })).toBeVisible();

  await page.reload();
  await page.waitForLoadState("load");
  await expect(lane(page, "In Arbeit").locator("a", { hasText: CARD_A })).toBeVisible();
});

test("keyboard Space + ArrowRight + Space moves the card one lane right", async ({ page }) => {
  await page.goto(boardUrl);
  const source = card(page, CARD_B);
  await expect(source).toBeVisible();

  await liftCard(page, handle(page, CARD_B));
  const moved = waitForMoveSubmit(page);
  // Closed-loop navigation: ArrowRight/ArrowLeft each step the preview one
  // droppable sideways. Blindly re-pressing ArrowRight overshoots (Review →
  // Erledigt → Abgebrochen) — instead read which lane the card's preview is
  // in (onDragOver reparents it live) and press toward the target, never past
  // it.
  await expect
    .poll(
      async () => {
        const pos = await cardLaneIndex(page, CARD_B);
        if (pos !== 2) await page.keyboard.press(pos < 2 ? "ArrowRight" : "ArrowLeft");
        return pos;
      },
      { intervals: [150, 200, 300, 400], timeout: 8_000 },
    )
    .toBe(2);
  await page.keyboard.press("Space"); // drop
  await moved;

  await expect(lane(page, "Review / Blockiert").locator("a", { hasText: CARD_B })).toBeVisible();

  await page.reload();
  await page.waitForLoadState("load");
  await expect(lane(page, "Review / Blockiert").locator("a", { hasText: CARD_B })).toBeVisible();
});

test("same-lane keyboard reorder persists across reload", async ({ page }) => {
  await page.goto(boardUrl);
  // CARD_C was created before CARD_D — it sits above it in Backlog.
  const before = await laneOrder(page, "Backlog");
  expect(before.indexOf(CARD_C)).toBeLessThan(before.indexOf(CARD_D));

  await liftCard(page, handle(page, CARD_C));
  const moved = waitForMoveSubmit(page);
  // Press ArrowDown until the DRAGGED card's own transform shows a downward
  // displacement (positive Y). Watching a sibling's transform is unreliable —
  // dnd-kit leaves a settled `translate3d(0px, 0px, 0px)` on it, which reads
  // non-empty without any shift having happened.
  await expect
    .poll(
      async () => {
        const t = await card(page, CARD_C).evaluate((el) => el.style.transform);
        if (!/translate3d\([^,]+,\s*[1-9]/.test(t)) await page.keyboard.press("ArrowDown");
        return t;
      },
      { intervals: [150, 200, 300, 400], timeout: 8_000 },
    )
    .toMatch(/translate3d\([^,]+,\s*[1-9]/);
  await page.keyboard.press("Space"); // drop
  await moved;

  // CARD_C now sits below CARD_D in Backlog (not in another lane).
  const after = await laneOrder(page, "Backlog");
  expect(after.indexOf(CARD_C)).toBeGreaterThan(after.indexOf(CARD_D));
  await expect(lane(page, "Backlog").locator("a", { hasText: CARD_C })).toBeVisible();

  await page.reload();
  await page.waitForLoadState("load");
  const persisted = await laneOrder(page, "Backlog");
  expect(persisted.indexOf(CARD_C)).toBeGreaterThan(persisted.indexOf(CARD_D));
});
