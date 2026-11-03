import { Form, Link } from "react-router";
import { StatusCell } from "~/components/data-grid";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { TicketType, type TicketStatus } from "~/generated/prisma/enums";
import { useT } from "~/i18n/use-t";

export interface LinkedTicket {
  id: string;
  title: string;
  status: TicketStatus;
}

/**
 * The ticket panel on `/tasks/:id`: a linked ticket is shown with an
 * "unlink" button (`unlinkTicket` clears `Task.ticketId` — and `Ticket.taskId`
 * too when it points back here); an unlinked task gets the "Ticket erstellen"
 * form (`raiseTicketFromTask` — an OPEN ticket prefilled from the task,
 * assignees copied, both link columns set in one transaction).
 */
export function TaskTicketPanel({ ticket, busy }: { ticket: LinkedTicket | null; busy: boolean }) {
  const t = useT();
  if (ticket) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <Link to={`/tickets/${ticket.id}`} className="hover:underline">
          {ticket.title}
        </Link>
        <StatusCell kind="ticket" value={ticket.status} />
        <Form method="post" className="ml-auto">
          <input type="hidden" name="_action" value="ticket-unlink" />
          <Button type="submit" variant="secondary" size="compact" disabled={busy}>
            {t("tasks.ticket.unlink")}
          </Button>
        </Form>
      </div>
    );
  }
  return (
    <Form method="post" className="flex items-center gap-2">
      <input type="hidden" name="_action" value="ticket-raise" />
      <Select
        name="type"
        required
        aria-label={t("tasks.ticket.typeAria")}
        className="max-w-[14rem]"
      >
        {Object.values(TicketType).map((type) => (
          <option key={type} value={type}>
            {t(`search.ticketType.${type}`)}
          </option>
        ))}
      </Select>
      <Button type="submit" variant="secondary" size="compact" disabled={busy}>
        {t("tasks.ticket.create")}
      </Button>
    </Form>
  );
}
