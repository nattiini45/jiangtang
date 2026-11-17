import type { Tx } from "~/lib/db.server";
import { NotFoundError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";

export async function lockEventSeries(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "EventSeries" WHERE "id" = ${id} FOR UPDATE`;
  const series = await tx.eventSeries.findUnique({ where: { id } });
  if (!series) throw new NotFoundError();
  return series;
}

export async function detachOccurrence(tx: Tx, id: string) {
  const where = { id };
  let event = await tx.event.findUnique({ where });
  if (!event) throw new NotFoundError(tr("work.err.event.notFound"));
  while (event.seriesId && event.occurrenceKey) {
    const series = await lockEventSeries(tx, event.seriesId);
    event = await tx.event.findUniqueOrThrow({ where });
    if (event.seriesId !== series.id || !event.occurrenceKey) continue;
    await tx.eventSeries.update({
      where: { id: series.id },
      data: { exceptions: { push: event.occurrenceKey } },
    });
    await tx.event.update({ where, data: { seriesId: null } });
    break;
  }
  if (!event.seriesId && event.occurrenceKey) {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${id} FOR UPDATE`;
    event = await tx.event.findUniqueOrThrow({ where });
  }
  return event;
}
