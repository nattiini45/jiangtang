---
version: 1
slug: "app-routes-desktop-account-route-tsx"
primary_target: "app/routes/_desktop.account/route.tsx"
related_targets: ["app/routes/_desktop.account/personal-access-tokens.tsx"]
---

# Account access management

## Scope and mode

Mode: Operate. Signed-in team members create and revoke their own MCP access tokens;
admins can also inspect safe metadata and revoke tokens belonging to other accounts.
The token section extends My account without changing password or two-factor behavior.

## Direction contract

THESIS: Make delegated access understandable and revocable in the existing account screen.
Keep token management together rather than introducing a separate settings dashboard.

OWN-WORLD: Inherit Fluid Functionalism, shared inputs, native selects, neutral badges,
surface shadows, typography and density tokens. Preserve light and dark themes.

STORY: Name a client connection, choose read-only or read-write access, save the secret once,
then use scope and Berlin-formatted lifecycle timestamps to decide when to revoke it.

FIRST VIEWPORT: Preserve the existing account details, two-factor and password sections.
Append a single-column token section: introduction, labeled creation form, focused one-time
result when present, personal metadata list and an admin-only disclosure for other accounts.
Together the personal and admin sections cover all tokens without duplication. Creation is
the primary action; revocation is contextual and requires confirmation. The distinctive
interaction is the one-time secret reveal with explicit copy, feedback and dismissal. Keep
the secret visible through unrelated account actions until dismissed, then restore input focus.

FORM: Local extension of the established account layout; no concept roll or comp applies.
Use the supplied implementation brief as the subagent decision input. Wrap long names and
dates within the account column at desktop and practical tablet widths.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review,
the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Verification constraints

Verify creation, one-time visibility, copying, dismissal, both scopes, empty and populated
lists, revocation cancellation and confirmation, and admin owner metadata. Screenshots
must never contain a raw token. Capture only safe metadata after hiding or revoking the
synthetic token. This extension adds no assets and does not change DESIGN.md.
The agreed verification widths are 1440px, 1280px and 768px. The existing desktop shell
retains its fixed sidebar at 390px, clipping all account sections; a mobile account route
or responsive navigation is outside this phase's scope.
