# Recurring work

Enable a template under **Recurring work**, or create a plan with a source and rationale.
Templates do nothing until enabled. Administrators choose the scope, responsible person, first
due date and interval. Members carry out the work without configuring it. An unassigned plan is
for the team; assigning a person labels responsibility without hiding it from colleagues.

Month-based inspections advance independently for each device from its actual inspection date.
A round advances only after every selected room is complete. Month ends are clamped, so a
January 31 inspection followed by a one-month interval becomes February 28 or 29.
The calendar shows each next occurrence, and the home shows it on or after its due date.

Enter semester starts once a year. The pre-semester round is due the day before each start;
completing it clears the covered occurrence and exposes the next entered start. No future
semester is guessed. With no room selection, the plan includes every room with check functions;
another team can choose its own room set rather than adopting a lecture-hall classification.

An inspection records passed/failed, the inspection date, the actor and a test report reference
as an append-only reading. Failure opens a fault on the device and its room function. If several
functions apply, choose the affected one. Devices without a room retain an equipment fault
without a fictional room link. Passing later does not resolve an existing fault automatically.

## Template evidence

- **Portable electrical equipment:** [DGUV Regulation 3, section 5, table 1B][dguv] gives a
  six-month guideline under normal conditions, three months on construction sites. An error
  rate below 2% can justify extension; the stated maxima are one year in workshops and two
  years in offices or comparable conditions. These are guidelines, not a universal legal
  six-month period. The qualified electrician determines the interval from the risk assessment.
  The movable pool is an editable starting scope, not proof that every item needs this test.
  Exclude passive equipment and equipment outside the applicable electrical test regime.
- **Test method:** [DKE's DIN EN 50699 (VDE 0702):2021-06 summary][vde] identifies periodic
  testing as the successor to that portion of DIN VDE 0701-0702. Testing after repairs is a
  separate standard. The DKE summary is linked beside the template's DGUV basis.
- **Pre-semester round:** this is an explicit team scheduling policy, not a regulatory interval.
  [DGUV Information 203-071][guidance] describes how inspection periods are determined; it
  does not prescribe semesters or this team's room checks.
- **Filters:** the shipped catalogue records part replacement intervals in operating hours,
  with no universal cleaning interval. The existing reading-based due view compares recorded
  filter hours against an actual model/part interval. It never converts hours to calendar months
  or invents a cleaning period when the manufacturer has not supplied one. A team can create a
  sourced calendar inspection plan where its actual manual specifies one.
  For example, the catalogue-linked [Epson EB-L1750U user manual][epson], page 209, recommends
  cleaning every 20,000 operating hours, more often in dusty conditions. This is a model-specific
  cleaning recommendation, not a generic replacement interval or a calendar period.

These sources were checked on 2026-11-14. This feature records work; it is not an electrical
test procedure or a substitute for a qualified person's risk assessment.

[dguv]: https://www.bgbau-medien.de/handlungshilfen_gb/daten/dguv/3/5.htm#d5A1N2
[vde]: https://www.dke.de/de/normen-standards/dokument?id=7156902&type=dke%7Cdokument
[guidance]: https://publikationen.dguv.de/widgets/pdf/download/article/787
[epson]: https://download.epson-europe.com/pub/download/6292/epson629296eu.zip
