import { z } from "zod";

export const HOME_BLOCKS = ["faults", "due", "today", "mine", "activity"] as const;
export const HOME_MODES = ["show", "highlight", "hide"] as const;
export const homeLayoutSchema = z
  .array(z.object({ id: z.enum(HOME_BLOCKS), mode: z.enum(HOME_MODES) }))
  .length(HOME_BLOCKS.length)
  .refine((items) => new Set(items.map((item) => item.id)).size === HOME_BLOCKS.length);
export type HomeLayout = z.infer<typeof homeLayoutSchema>;
export type HomeBlock = HomeLayout[number]["id"];

export function defaultHomeLayout(): HomeLayout {
  return HOME_BLOCKS.map((id) => ({ id, mode: id === "faults" ? "highlight" : "show" }));
}

export function readHomeLayout(value: unknown): HomeLayout {
  const result = homeLayoutSchema.safeParse(value);
  return result.success ? result.data : defaultHomeLayout();
}

export function visibleHomeLayout(layout: HomeLayout) {
  return [...layout]
    .filter((item) => item.mode !== "hide")
    .sort((a, b) => Number(b.mode === "highlight") - Number(a.mode === "highlight"));
}
