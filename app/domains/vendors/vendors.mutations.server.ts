import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import type { Tx } from "~/lib/db.server";
import { hasSqlState, NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import type { Vendor } from "~/generated/prisma/client";
import type { VendorCreateInput, VendorEditInput } from "./vendors.schema";

function vendorFields(input: VendorCreateInput) {
  return {
    name: input.name,
    contact: input.contact ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    url: input.url ?? null,
    address: input.address ?? null,
    locationId: input.locationId ?? null,
  };
}

async function requireLocation(tx: Tx, locationId: string | undefined) {
  if (locationId && !(await tx.location.findUnique({ where: { id: locationId } }))) {
    throw new ValidationError({ locationId: [tr("places.err.location.unknown")] });
  }
}

function rethrowVendorError(error: unknown): never {
  if (hasSqlState(error, "P2025")) throw new NotFoundError();
  if (hasSqlState(error, "P2003") || hasSqlState(error, "23503")) {
    throw new ValidationError({ locationId: [tr("places.err.location.unknown")] });
  }
  throw error;
}

export async function createVendor(actor: AuditActor, input: VendorCreateInput): Promise<Vendor> {
  return txWithAudit(actor, async (tx, audit) => {
    await requireLocation(tx, input.locationId);
    let vendor: Vendor;
    try {
      vendor = await tx.vendor.create({
        data: { ...vendorFields(input), createdById: actor?.id ?? null },
      });
    } catch (error) {
      rethrowVendorError(error);
    }
    await audit({
      action: "VendorCreated",
      entityType: "vendor",
      entityId: vendor.id,
      data: { name: vendor.name, locationId: vendor.locationId },
    });
    return vendor;
  });
}

export async function updateVendor(
  actor: AuditActor,
  id: string,
  input: VendorEditInput,
): Promise<Vendor> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.vendor.findUnique({ where: { id } });
    if (!before) throw new NotFoundError();
    await requireLocation(tx, input.locationId);
    let vendor: Vendor;
    try {
      vendor = await tx.vendor.update({ where: { id }, data: vendorFields(input) });
    } catch (error) {
      rethrowVendorError(error);
    }
    await audit({
      action: "VendorUpdated",
      entityType: "vendor",
      entityId: vendor.id,
      data: {
        from: { name: before.name, locationId: before.locationId },
        to: { name: vendor.name, locationId: vendor.locationId },
      },
    });
    return vendor;
  });
}

export async function deleteVendor(actor: AuditActor, id: string): Promise<Vendor> {
  return txWithAudit(actor, async (tx, audit) => {
    const vendor = await tx.vendor.findUnique({ where: { id } });
    if (!vendor) throw new NotFoundError();
    const detachedStockItems = await tx.inventoryItem.count({ where: { vendorId: id } });
    try {
      await tx.vendor.delete({ where: { id } });
    } catch (error) {
      rethrowVendorError(error);
    }
    await audit({
      action: "VendorDeleted",
      entityType: "vendor",
      entityId: id,
      data: { name: vendor.name, detachedStockItems },
    });
    return vendor;
  });
}
