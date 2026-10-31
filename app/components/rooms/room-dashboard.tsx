import { Link } from "react-router";
import { ExternalLink } from "lucide-react";
import { DateCell, MonoCell } from "~/components/data-grid";
import { StatusBadge } from "~/components/ui/status-badge";
import { Button } from "~/components/ui/button";
import { categoryLabel } from "~/components/inventory/labels";
import { FileUpload } from "~/components/upload/file-upload";
import { AttachmentGallery } from "~/components/upload/attachment-gallery";
import { ActivityFeed } from "~/components/history/activity-feed";
import { AttachmentCategory } from "~/generated/prisma/enums";
import type { DashboardEquipment, RoomDashboardData } from "~/domains/rooms/rooms.dashboard.server";
import { useLocale, useT } from "~/i18n/use-t";

const FEATURE_LABELS = [
  ["hasProjector", "rooms.features.hasProjector"],
  ["hasMicrophony", "rooms.features.hasMicrophony"],
  ["hasBlackboard", "rooms.features.hasBlackboard"],
  ["hasWebConference", "rooms.features.hasWebConference"],
  ["hasAutoRecording", "rooms.features.hasAutoRecording"],
] as const;

export function RoomDashboard({ data }: { data: RoomDashboardData }) {
  const t = useT();
  const locale = useLocale();
  const { room, equipment, openTickets, recentTickets, attachments, history } = data;
  const photoRedirect = `/rooms/${room.slug}`;

  const byCategory = new Map<string, DashboardEquipment[]>();
  for (const e of equipment) {
    const arr = byCategory.get(e.category) ?? [];
    arr.push(e);
    byCategory.set(e.category, arr);
  }
  const features = FEATURE_LABELS.filter(([k]) => room[k as keyof typeof room]);
  const meta = [room.campus?.name, room.building?.name].filter(Boolean).join(" · ");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-xl">{room.name}</h1>
          {room.roomNumber ? <MonoCell>{room.roomNumber}</MonoCell> : null}
          <StatusBadge kind="room" value={room.status} />
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link to={`/rooms/${room.slug}/clone`}>{t("rooms.dashboard.duplicate")}</Link>
          </Button>
          <Button asChild>
            <Link to={`/rooms/${room.slug}/edit`}>{t("rooms.dashboard.edit")}</Link>
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground text-sm">
        {meta || t("rooms.dashboard.noLocation")}
        {room.capacity != null ? ` · ${t("rooms.dashboard.seats", { count: room.capacity })}` : ""}
        {room.owner ? ` · ${room.owner}` : ""}
      </p>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <section className="border-border border">
            <header className="border-border flex items-center justify-between border-b px-3 py-2">
              <h2 className="text-sm font-medium">{t("rooms.dashboard.installed")}</h2>
              <Button asChild size="sm" variant="ghost">
                <Link to={`/inventory/new?roomId=${room.id}`}>
                  {t("rooms.dashboard.addDevice")}
                </Link>
              </Button>
            </header>
            {equipment.length === 0 ? (
              <p className="text-muted-foreground p-3 text-sm">
                {t("rooms.dashboard.noEquipment")}
              </p>
            ) : (
              <div className="divide-border divide-y">
                {[...byCategory.entries()].map(([cat, units]) => (
                  <div key={cat} className="p-3">
                    <p className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
                      {categoryLabel(locale, cat as DashboardEquipment["category"])}
                    </p>
                    <ul className="flex flex-col gap-1">
                      {units.map((u) => (
                        <li key={u.id} className="flex items-center gap-2 text-sm">
                          <Link to={`/inventory/${u.id}`} className="hover:underline">
                            {u.name ?? u.modelName ?? "—"}
                          </Link>
                          {u.assetTag ? <MonoCell>{u.assetTag}</MonoCell> : null}
                          <span className="ml-auto">
                            <StatusBadge kind="equipment" value={u.status} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="border-border border">
            <header className="border-border flex items-center justify-between border-b px-3 py-2">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium">{t("rooms.dashboard.tickets")}</h2>
                {openTickets.length > 0 ? (
                  <span className="text-status-warning font-mono text-xs">
                    {t("rooms.dashboard.openTickets", { count: openTickets.length })}
                  </span>
                ) : null}
              </div>
              <Button asChild size="sm" variant="ghost">
                <Link to={`/quick-entry?roomId=${room.id}`}>{t("rooms.dashboard.addEntry")}</Link>
              </Button>
            </header>
            {recentTickets.length === 0 ? (
              <p className="text-muted-foreground p-3 text-sm">{t("rooms.dashboard.noTickets")}</p>
            ) : (
              <ul className="divide-border divide-y">
                {recentTickets.map((ticket) => (
                  <li key={ticket.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="text-muted-foreground font-mono text-xs">
                      {t(`search.ticketType.${ticket.type}`)}
                    </span>
                    <Link to={`/tickets/${ticket.id}`} className="truncate hover:underline">
                      {ticket.title}
                    </Link>
                    <span className="ml-auto">
                      <StatusBadge kind="ticket" value={ticket.status} />
                    </span>
                    <DateCell value={ticket.occurredAt} withTime={false} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="border-border border">
            <header className="border-border border-b px-3 py-2">
              <h2 className="text-sm font-medium">{t("rooms.dashboard.history")}</h2>
            </header>
            <ActivityFeed entries={history} />
          </section>
        </div>

        <div className="flex flex-col gap-4">
          <section className="border-border flex flex-col gap-3 border p-3">
            <p className="text-muted-foreground text-xs uppercase tracking-wide">
              {t("rooms.dashboard.photos")}
            </p>
            <AttachmentGallery attachments={attachments} redirectTo={photoRedirect} />
            <FileUpload
              target={{ roomId: room.id }}
              categories={[
                AttachmentCategory.ROOM,
                AttachmentCategory.CONTROL_PANEL,
                AttachmentCategory.CONNECTION_PANEL,
              ]}
              redirectTo={photoRedirect}
            />
          </section>

          {features.length > 0 || room.mediaKeyRequired ? (
            <section className="border-border border p-3">
              <p className="text-muted-foreground text-xs uppercase tracking-wide">
                {t("rooms.features.legend")}
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                {features.map(([k, labelKey]) => (
                  <span
                    key={k}
                    className="border-border bg-secondary rounded-sm border px-2 py-0.5 text-xs"
                  >
                    {t(labelKey)}
                  </span>
                ))}
                {room.mediaKeyRequired ? (
                  <span className="border-status-warning/40 text-status-warning rounded-sm border px-2 py-0.5 text-xs">
                    {t("rooms.dashboard.mediaKey")}
                  </span>
                ) : null}
              </div>
            </section>
          ) : null}

          {room.videoInputs.length > 0 || room.audioOutputs.length > 0 ? (
            <section className="border-border flex flex-col gap-2 border p-3 text-sm">
              {room.videoInputs.length > 0 ? (
                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">
                    {t("rooms.form.videoInputs")}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {room.videoInputs.map((v) => (
                      <span
                        key={v}
                        className="border-border rounded-sm border px-1.5 py-0.5 font-mono text-xs"
                      >
                        {v}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {room.audioOutputs.length > 0 ? (
                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">
                    {t("rooms.form.audioOutputs")}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {room.audioOutputs.map((v) => (
                      <span
                        key={v}
                        className="border-border rounded-sm border px-1.5 py-0.5 font-mono text-xs"
                      >
                        {v}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {room.bookingUrl || room.manualUrl || room.virtualTourUrl ? (
            <section className="border-border border p-3">
              <p className="text-muted-foreground text-xs uppercase tracking-wide">
                {t("rooms.dashboard.links")}
              </p>
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {room.bookingUrl ? (
                  <li>
                    <ExtLink href={room.bookingUrl} label={t("rooms.dashboard.bookingLink")} />
                  </li>
                ) : null}
                {room.manualUrl ? (
                  <li>
                    <ExtLink href={room.manualUrl} label={t("rooms.dashboard.manualLink")} />
                  </li>
                ) : null}
                {room.virtualTourUrl ? (
                  <li>
                    <ExtLink href={room.virtualTourUrl} label={t("rooms.dashboard.tourLink")} />
                  </li>
                ) : null}
              </ul>
            </section>
          ) : null}

          {room.tipsNotes ? (
            <section className="border-border border p-3">
              <p className="text-muted-foreground text-xs uppercase tracking-wide">
                {t("rooms.dashboard.tips")}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{room.tipsNotes}</p>
            </section>
          ) : null}

          {room.renewalStatus || room.lastCheckedAt ? (
            <section className="border-border text-muted-foreground flex flex-col gap-1 border p-3 text-xs">
              {room.renewalStatus ? (
                <p>{t("rooms.dashboard.renewal", { status: room.renewalStatus })}</p>
              ) : null}
              {room.lastCheckedAt ? (
                <p className="flex items-center gap-1">
                  {t("rooms.dashboard.lastChecked")}{" "}
                  <DateCell value={room.lastCheckedAt} withTime={false} />
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ExtLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary inline-flex items-center gap-1 hover:underline"
    >
      {label}
      <ExternalLink className="size-3" />
    </a>
  );
}
