import { z } from "zod";
import { msgKey } from "~/i18n";
import { StockStatus } from "~/generated/prisma/enums";
import { STOCK_STATUS_ALIASES } from "~/lib/status";

/**
 * Zod schemas for the **stock** half of the inventory domain
 * (`InventoryItem` — "general tracked stock, sibling to `Equipment`").
 *
 * These sit beside the Equipment-facing `inventory.schema.ts` rather than inside
 * it, because the two families are separate namespaces: stock
 * is `inventory.stock.*`, with its own routes and its own page. Only the shared shape —
 * optional text arriving as an empty string from a form — is reused, and it is
 * re-declared here rather than imported so a change to the Equipment importer
 * cannot silently move the stock form's contract.
 *
 * ⚠️ **`category` and `unit` are free strings here, and that is deliberate, not
 * laziness.** `status` is not one of them: the column is `StockStatus?` now, so
 * the enum IS the schema and this field
 * validates against it — the "two halves disagreeing" hazard is gone precisely
 * because the column is typed.
 */

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** An optional free-text field. Empty string and whitespace both mean "absent". */
const optionalText = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());

/** An optional foreign key. Same empty-string handling, min length enforced. */
const optionalId = z.preprocess(emptyToUndefined, z.string().min(1).optional());

/**
 * `status` — `StockStatus?`. The form sends the enum value; the CSV import may
 * send the enum value OR its German or English label, case-insensitively (a
 * spreadsheet cell reads „Verliehen“ or "On loan", not `ON_LOAN`), whatever the
 * UI language. All spellings resolve to the enum; anything else is a field
 * error, so a bad cell refuses the row instead of silently nulling it.
 */
const optionalStatus = z.preprocess(
  (v) => {
    const cleared = emptyToUndefined(v);
    if (typeof cleared !== "string") return cleared;
    return STOCK_STATUS_ALIASES.resolve(cleared) ?? cleared;
  },
  z
    .nativeEnum(StockStatus, {
      errorMap: () => ({ message: msgKey("places.err.stock.statusInvalid") }),
    })
    .optional(),
);

/**
 * An optional date. Accepts a `Date` (server path) or a parsable string (form
 * path) and normalises to `Date`; an unparsable string is a field error rather
 * than an `Invalid Date` that Postgres would reject with a driver error nobody
 * can render. `null` is accepted explicitly so a *cleared* date is
 * distinguishable from an absent one in the mutation.
 */
const optionalDate = z.preprocess(
  (v) => (v === "" || v === null ? null : typeof v === "string" ? new Date(v) : v),
  z.union([z.date(), z.null()]).optional(),
);

/**
 * `purchasePrice` is `Decimal @db.Decimal(10, 2)` in the schema — money is never
 * a float (the same note the model carries). A form hands us a string, so the
 * value is normalised to a string here and handed to Prisma untouched rather than
 * being parsed to `number` and re-serialized.
 */
const optionalMoney = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? null : String(v)),
  z
    .string()
    .regex(/^\d{1,8}([.,]\d{1,2})?$/, msgKey("places.err.stock.priceInvalid"))
    .nullable()
    .optional(),
);

/**
 * `quantity` — a count of physical objects.
 *
 * ⚠️ **The `min(0)` is this slice's reading, and it is a FORM rule, not a schema
 * one:** `InventoryItem.quantity` is `Int @default(1)` with no CHECK, so a
 * negative quantity is still writable through any other path (a CSV import, a
 * direct query). It is rejected here because a form is where a minus sign gets
 * typed by accident, and because "we have minus three microphones" is not a state
 * a stock list can be sorted into. Nothing in forbids it, so this is named
 * rather than smuggled in — a future slice that wants backorders removes one line.
 *
 * 🔴 **A blank means "not stated" and takes the default `1` — and `.default`
 * goes on the INSIDE of `z.preprocess`, which is the load-bearing part of this
 * line.** On the installed `zod` 3.25.76 the outcome is the same for all five
 * spellings:
 *
 * | spelling | `""` | `"   "` | `-5` |
 * |---|---|---|---|
 * | `quantity.default(1)` (earlier spelling) | `0` 🔴 | `0` 🔴 | rejected |
 * | `z.preprocess(f, quantity).default(1)` — **the literal wording** | **REJECT** 🔴 | **REJECT** 🔴 | rejected |
 * | `z.preprocess(f, quantity).optional().default(1)` | **REJECT** 🔴 | **REJECT** 🔴 | rejected |
 * | **`z.preprocess(f, quantity.default(1))` — what this is** | **`1`** ✅ | **`1`** ✅ | rejected ✅ |
 *
 * ⚠️ **The middle two rows are the design's own prescription, and it does not work.**
 * zod 3's `ZodDefault` takes the default only when the *input* is `undefined`, and
 * a blank CSV cell arrives as `""` — so with the default on the outside, `""`
 * reaches `z.coerce.number()` as `NaN` and the row is **rejected** instead of
 * defaulted. The default has to be the INNER type for the preprocess to turn a
 * blank into the `undefined` that `ZodDefault` is listening for.
 *
 * **This is why the test asserts the outcome and not the spelling** — every one of
 * the three rejected rows above is a build that compiles, lints and passes every
 * test written against the intent.
 *
 * `null` still coerces to `0`, exactly as it did before: that is unchanged
 * behaviour on a path no caller takes (a CSV cell is a string, a form field is a
 * string), and "fix" it here would mean inventing a rule the contract did not
 * ask for.
 */
const quantity = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number()
    .int(msgKey("places.err.stock.quantityInt"))
    .min(0, msgKey("places.err.stock.quantityNegative"))
    .default(1),
);

/** ── Create / edit ─────────────────────────────────────────────────────────── */

export const stockCreateSchema = z.object({
  name: z.string().trim().min(1, msgKey("places.err.name.required")),
  /** The two unique identifiers. Optional: NULLs stay distinct. */
  sku: optionalText,
  serial: optionalText,
  /** Blank ⇒ "not stated" ⇒ `1`; an explicit `0` stays `0` (see `quantity`). */
  quantity,
  /** Untyped value sets — see the file header. */
  category: optionalText,
  /** `StockStatus?`, enum value or German label on input — see `optionalStatus`. */
  status: optionalStatus,
  unit: optionalText,
  purchasedAt: optionalDate,
  purchasePrice: optionalMoney,
  warrantyExpiresAt: optionalDate,
  vendorId: optionalId,
  locationId: optionalId,
  /** The harmony link to `Equipment`. Written by the stock-mutation domain, settable here. */
  equipmentId: optionalId,
  tags: z.array(z.string().trim().min(1)).default([]),
});

/** Edit: the same shape plus `id`. Every field stays optional-on-empty. */
export const stockEditSchema = stockCreateSchema.extend({ id: z.string().min(1) });

export type StockCreateInput = z.infer<typeof stockCreateSchema>;
export type StockEditInput = z.infer<typeof stockEditSchema>;

/** ── List options ──────────────────────────────────────────────────────────── */

/**
 * Stock-list options. Consumed by `listStock` and by the location panel.
 * `search` matches `name` — deliberately `contains`, because this is a human
 * typing a word. `serial`/`sku` **exact** matching is the search route's work
 * and is a different contract (a serial is an identifier, and a prefix of one is
 * not another device's).
 */
export const stockListOptionsSchema = z.object({
  locationId: optionalId,
  vendorId: optionalId,
  equipmentId: optionalId,
  search: optionalText,
  /** Include items with no `locationId` in a location-scoped list (default true:
   * "assigned nowhere" is a stock state worth seeing, and hiding it by default
   * is how unstored gear disappears). */
  includeUnassigned: z.coerce.boolean().optional().default(true),
});

export type StockListOptions = z.infer<typeof stockListOptionsSchema>;
