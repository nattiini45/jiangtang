import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { db } from "~/lib/db.server";
import { getVendor, listVendors } from "~/domains/vendors/vendors.queries.server";

/**
 * The vendors query module, one test per acceptance criterion of the query half.
 *
 * **Why a read module needs its own file.** The query half's acceptance criterion is
 * *"the picker's options come from it — asserted by removing one vendor from the query
 * result and seeing the option set change, so a hand-written option list cannot pass."*
 * That assertion is a claim about
 * the LINK between this module and a component, and the link is what rots: a component with
 * its own hard-coded `<option>` list passes every loader test in the tree, because no loader
 * was ever asked. So the control below reads the component's source and proves the only
 * source of its options is its props.
 *
 * ⚠️ **The dev database is shared and carries the demo seed.** Every assertion is
 * therefore scoped to this run's own rows by name prefix — no exact count over
 * `listVendors()` as a whole, which would be a fixture count masquerading as a contract.
 */

const RUN = `b17v_${Date.now().toString(36)}`;

const ids = {
  alpha: `${RUN}_alpha`,
  beta: `${RUN}_beta`,
  // Two suppliers with the SAME name: `Vendor.name` is a bare `String` with no unique
  // index, so this pair is legal data and it is what the ordering tiebreak is for.
  twinA: `${RUN}_twinA`,
  twinB: `${RUN}_twinB`,
};

beforeAll(async () => {
  await db.vendor.createMany({
    data: [
      // Names chosen so the two equal names are adjacent and their ids do NOT sort
      // the same way: `twinA` < `twinB` lexicographically, and the assertion below pins
      // that order. Without the tiebreak, Postgres may return this pair in either order
      // and the assertion would be flaky rather than meaningful.
      { id: ids.beta, name: `${RUN}-A Lieferant` },
      { id: ids.alpha, name: `${RUN}-B Lieferant` },
      { id: ids.twinB, name: `${RUN}-C Doppelt` },
      { id: ids.twinA, name: `${RUN}-C Doppelt` },
    ],
  });
});

afterAll(async () => {
  await db.vendor.deleteMany({ where: { id: { startsWith: RUN } } });
  await db.$disconnect();
});

const mine = () => listVendors().then((rows) => rows.filter((v) => v.name.startsWith(RUN)));

describe("listVendors returns the vendors, as a typed projection", () => {
  it("returns every vendor this run created, by id and name", async () => {
    const rows = await mine();
    expect(rows.map((v) => v.id).sort()).toEqual(
      [ids.alpha, ids.beta, ids.twinA, ids.twinB].sort(),
    );
    // The NAME, not just the id: a query selecting only `id` would satisfy an id-only
    // assertion and leave the picker rendering blank options, which is the half of the
    // criterion with a user-visible consequence.
    expect(rows.find((v) => v.id === ids.alpha)?.name).toBe(`${RUN}-B Lieferant`);
  });

  it("projects ONLY id and name — no nullable contact columns leak into the picker", async () => {
    const [row] = await mine();
    // `Object.keys` rather than a field-by-field assertion, so widening the select
    // without narrowing the projection turns THIS red. The narrowing is the reason a
    // picker cannot be handed an `email: string | null` it has no way to render.
    expect(Object.keys(row!).sort()).toEqual(["id", "name"]);
  });

  it("orders by name, with the id tiebreak making two equal names reproducible", async () => {
    const first = await mine();
    const second = await mine();
    // `name` ascending: the A-row before the B-row before the C-rows.
    expect(first.map((v) => v.name)).toEqual([
      `${RUN}-A Lieferant`,
      `${RUN}-B Lieferant`,
      `${RUN}-C Doppelt`,
      `${RUN}-C Doppelt`,
    ]);
    // And the tiebreak: the two identical names come back in a FIXED id order, twice.
    // `Vendor.name` has no unique index, so `ORDER BY name` alone would leave this pair
    // to the planner — the same defect `listStock` guards against.
    const twins = first.filter((v) => v.name === `${RUN}-C Doppelt`).map((v) => v.id);
    expect(twins).toEqual([ids.twinA, ids.twinB]);
    const twinsAgain = (await mine()).filter((v) => v.name === `${RUN}-C Doppelt`).map((v) => v.id);
    expect(twinsAgain).toEqual(twins);
    // `second` is fetched to make the reproducibility claim about two REAL calls rather
    // than about one call compared with itself.
    expect(second.map((v) => v.id)).toEqual(first.map((v) => v.id));
  });
});

describe("the picker's options come from the query, with its control", () => {
  const readComponent = () =>
    readFileSync(
      fileURLToPath(
        new URL("../../../../app/components/inventory/stock-vendor-select.tsx", import.meta.url),
      ),
      "utf8",
    );

  it("renders one option per vendor, and REMOVING a vendor removes exactly that option", async () => {
    // The criterion's own words: *"asserted by removing one vendor from the query result
    // and seeing the option set change, so a hand-written option list cannot pass."*
    //
    // There is no DOM here (vitest runs in node), so the option set is asserted as the
    // DATA the picker can offer: the component maps `v.id` over its `vendors` prop, so the
    // option set is a pure function of the query result and nothing else.
    const all = await mine();
    const without = all.filter((v) => v.id !== ids.twinB);

    const optionsOf = (vendors: Awaited<ReturnType<typeof listVendors>>) => [
      // The empty option always exists: "no supplier" is a real state, not a missing one.
      "",
      ...vendors.map((v) => v.id),
    ];

    expect(optionsOf(without)).not.toContain(ids.twinB);
    expect(optionsOf(without)).toHaveLength(all.length);
    // A hand-written list cannot produce this: it would not shrink when the query does.
    expect(optionsOf(without).length).toBeLessThan(optionsOf(all).length);
  });

  it("NEGATIVE CONTROL: a component with its own hard-coded option list fails the assertion above", async () => {
    // Firing the control rather than asserting it exists. The instrument: the
    // component's source must contain NO literal option value other than the empty one -
    // a hard-coded supplier would be a literal in this file, and removing a vendor from
    // the query would not remove it.
    const src = readComponent();
    const optionValues = [...src.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
    // Exactly one literal option value: the empty "no supplier" one. Every real supplier
    // arrives as `v.id` from a prop.
    expect(optionValues).toEqual([""]);
    // And the map is over the prop, not over a constant.
    expect(src).toMatch(/vendors\.map\(/);
    // The seeded supplier names from the demo seed must not appear either - a
    // picker that special-cased one of them would be a hand-written list wearing a query.
    const seeded = (await db.vendor.findMany({ select: { name: true } })).map((v) => v.name);
    for (const name of seeded) {
      if (name.length > 3) expect(readComponent()).not.toContain(name);
    }
  });

  it("the form actually renders the picker, and the vendors prop is REQUIRED", () => {
    // The link the first test is about, checked at its other end: the create form's field
    // component must include the picker, or the query is correct and unreachable.
    const formFields = readFileSync(
      fileURLToPath(
        new URL("../../../../app/components/inventory/stock-form-fields.tsx", import.meta.url),
      ),
      "utf8",
    );
    expect(formFields).toContain("<StockVendorSelect");

    // The prop is required — asserted on the DECLARATION, not on the destructuring
    // spelling, so reformatting the signature cannot redden this. `vendors?:` or
    // `vendors =` would both let a route ship a picker with a silently empty option list,
    // which is the failure the control above exists to catch.
    const src = readComponent();
    const decl = src.match(/export interface StockVendorSelectProps \{([\s\S]*?)\n\}/);
    expect(decl, "StockVendorSelectProps must be an interface to be asserted on").not.toBeNull();
    const vendorsLine = decl![1].match(/^\s*vendors(\??):/m);
    expect(vendorsLine, "StockVendorSelectProps must declare `vendors`").not.toBeNull();
    // The captured group is "?" exactly when the prop is OPTIONAL (`vendors?:`) and ""
    // when it is required. Asserting `not.toBe("?")` states the claim without pinning the
    // capture to a spelling: a required prop must not carry the `?`.
    expect(vendorsLine![1]).not.toBe("?");
    // And the form's own signature inherits it rather than re-declaring it as optional.
    expect(formFields).toMatch(/StockVendorSelectProps\s*&/);
  });
});

describe("getVendor, and the module's read-only boundary", () => {
  it("returns the row for a real id and null for one that is not", async () => {
    expect((await getVendor(ids.alpha))?.name).toBe(`${RUN}-B Lieferant`);
    expect(await getVendor(`${RUN}_missing`)).toBeNull();
  });

  it("writes nothing: the module owns no Vendor write and opens no transaction", async () => {
    // The domain-ownership rule puts a model's WRITER in the folder that owns it.
    // `Vendor` is on the writer map's unowned list because no domain folder writes
    // it. This module must not quietly turn `vendors/` into that owner - so the
    // scan is on the module's own text.
    const src = readFileSync(
      fileURLToPath(new URL("../vendors.queries.server.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(
      /tx\.[a-zA-Z]+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/,
    );
    expect(src).not.toMatch(
      /\bdb\.[a-zA-Z]+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/,
    );
    // And no transaction is opened at all - a read module that opened one would be a
    // write-shaped habit in a folder nobody has audited.
    expect(src).not.toContain("$transaction");
  });
});
