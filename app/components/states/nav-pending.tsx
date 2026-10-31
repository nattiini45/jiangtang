import { useFetchers, useNavigation } from "react-router";

/**
 * The single navigation-pending indicator — a thin top progress bar
 * driven by `useNavigation()` plus any in-flight fetchers, so a pending
 * action (board drop, quick status) reads as work-in-progress too. Mounted
 * once in each shell; renders nothing while idle.
 */
export function NavPendingIndicator() {
  const navigation = useNavigation();
  const fetchers = useFetchers();
  const busy = navigation.state !== "idle" || fetchers.some((f) => f.state !== "idle");
  return (
    <div
      aria-hidden={!busy}
      className={
        busy
          ? "bg-primary fixed inset-x-0 top-0 z-50 h-0.5 animate-pulse"
          : "pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 bg-transparent"
      }
    />
  );
}
