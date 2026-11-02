import { useFetchers, useNavigation } from "react-router";
import { cn } from "~/lib/utils";

/**
 * The single navigation-pending indicator — a thin top progress bar
 * driven by `useNavigation()` plus any in-flight fetchers, so a pending
 * action (board drop, quick status) reads as work-in-progress too. Mounted
 * once in each shell. It waits 160ms before fading in, so a quick navigation
 * never flashes it.
 */
export function NavPendingIndicator() {
  const navigation = useNavigation();
  const fetchers = useFetchers();
  const busy = navigation.state !== "idle" || fetchers.some((f) => f.state !== "idle");
  return (
    <div
      aria-hidden={!busy}
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden transition-opacity",
        busy ? "opacity-100 delay-160 duration-160" : "opacity-0 duration-120",
      )}
    >
      <div className="bg-fluid-accent animate-nav-progress h-full w-1/3 motion-reduce:w-full motion-reduce:animate-none" />
    </div>
  );
}
