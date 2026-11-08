# Design resource decisions

The design baseline preserves the implemented Fluid Functionalism system in `app/app.css` and
`app/components/ui/`. This is an operational university AV/facilities workspace, not a marketing
canvas. [PRODUCT.md](../PRODUCT.md) records the maintainer's audience and replacement-tool brief;
[DESIGN.md](../DESIGN.md) records the incumbent implementation. The app is Operate mode and these
documents are Read mode; their surface briefs live under `.impeccable/surfaces/`.

## Resource selection

These decisions capture the maintainer's approved design-resource research dated 2026-11-08
(crew report JIAN-6, "Design resources evaluation", the source supplied for this baseline).
They are adoption constraints, not a fresh legal opinion or a statement that dependencies were
installed. Jiangtang is public and Apache-2.0, so copied assets are redistributed. Recheck the
upstream license of any particular asset before introducing it.

The research's primary license references include React Bits' `LICENSE.md` in
`DavidHDev/react-bits`, Realtime Colors' `LICENSE.md` in `juxtopposed/realtimecolors`, and unDraw's
published license page. The restrictions below record that research's conservative adoption
decisions, not an independently verified interpretation of every export or asset license.

| Resource                | Decision and reason                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lucide                  | Keep the existing icon library (`components.json`, `lucide-react` in `package.json`); no second icon family is needed. Preserve license notices.                             |
| Magic UI                | No app adoption. Its animated marketing components do not serve task completion; MIT does not make them appropriate operational UI. `/welcome` remains parked.               |
| React Bits              | Reject for the app: decorative effects plus MIT with Commons Clause redistribution concerns for a public Apache-2.0 codebase.                                                |
| LottieFiles / Lottie    | Reject for the app: a new player dependency and animation assets without an operational need. Asset licensing and editor-plan terms need separate checks.                    |
| unDraw                  | Reject for the app: flat illustrative decoration does not help operational work; the research also found distribution/central-use wording requiring caution.                 |
| Haikei                  | No generated decorative backgrounds in the app; blobs and waves add visual noise without helping a task.                                                                     |
| bg.ibelick              | Reject copied background snippets: no author-provided repository license was found in the research, and decorative backgrounds are unnecessary here.                         |
| Realtime Colors         | Preview only. Research found CC BY-NC-ND terms with export coverage unresolved; do not paste generated CSS, Tailwind code or assets. Keep independently chosen token values. |
| UI Colors               | Optional palette exploration helper, not a component dependency. No palette change is approved by the baseline; retain canonical CSS and verify contrast in both themes.     |
| Fontjoy / uncut.wtf     | Do not introduce a new font pairing. Existing Inter covers the interface; alternative fonts require a demonstrated need and their own license check.                         |
| Uiverse                 | Do not copy novelty controls. Existing primitives already implement the scale, themes and affordances.                                                                       |
| 21st.dev                | Reference only unless a specific component earns adoption and its individual license is verified. No blanket registry approval.                                              |
| Mobbin                  | Human reference only within its terms; do not copy content or use its restricted material for AI processing.                                                                 |
| Land-book / CTA Gallery | Skip for the app: landing-page/CTA composition does not address operational gaps. Research also found restrictive or missing content terms.                                  |
| SVGL                    | Defer brand assets until a real integration needs them and its trademark/brand rules are checked. Use the integration's name meanwhile.                                      |

## Boundaries

No design library or skill is vendored by this baseline. Impeccable is a crew tool, not a runtime
dependency. Its durable context files are versioned here so future work can preserve the product
and its current system. No default-language code or interface behavior changes with these docs.
