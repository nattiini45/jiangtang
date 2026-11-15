import rules from "~/lib/equipment-kinds/reading-rules.json" with { type: "json" };

type ReadingRule = {
  limits: string[];
  partKinds?: string[];
};

export const readingRules: Record<string, ReadingRule> = rules;

export function readingDue(value: unknown, limit: number | null, margin: number) {
  if (typeof value !== "number" || !limit) return "unknown" as const;
  if (value >= limit) return "due" as const;
  return value >= limit * (1 - margin / 100) ? ("soon" as const) : ("ok" as const);
}

export function readingAge(observedAt: Date, now: Date) {
  return Math.max(0, Math.floor((+now - +observedAt) / 86_400_000));
}
