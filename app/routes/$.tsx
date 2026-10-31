import type { Route } from "./+types/$";

// No route matches these URLs, so React Router would answer from the framework
// default boundary before the root loader ever runs, which loses the visitor's
// locale. Matching here keeps the root loader in play and the root ErrorBoundary
// renders the localized 404. The default export is required: without one the
// module is a resource route and the thrown Response would be sent unrendered.
export function loader(_: Route.LoaderArgs): never {
  throw new Response(null, { status: 404 });
}

export default function NotFound() {
  return null;
}
