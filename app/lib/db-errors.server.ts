/**
 * Did a write fail on a unique constraint? Prisma's P2002, or the driver
 * adapter's structured `UniqueConstraintViolation`, at any depth of `cause`.
 */
export function isUniqueViolation(error: unknown): boolean {
  let cur: unknown = error;
  for (let depth = 0; cur && depth < 6; depth++) {
    const e = cur as {
      code?: unknown;
      meta?: { driverAdapterError?: { cause?: { kind?: unknown } } };
    };
    if (e.code === "P2002") return true;
    if (e.meta?.driverAdapterError?.cause?.kind === "UniqueConstraintViolation") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
