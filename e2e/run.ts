import { readFileSync } from "node:fs";

/**
 * The run-scoped title prefix (`e2e-<runId>-`). Written to `e2e/.run-id` by
 * global-setup so test workers, which run in separate processes, all share
 * the same run id.
 *
 * A missing or malformed `.run-id` is an error, and only the generated
 * `^e2e-[a-z0-9]+-$` form is accepted. There is no `e2e-local-` fallback.
 */
export function runPrefix(): string {
  let content: string;
  try {
    content = readFileSync("e2e/.run-id", "utf8").trim();
  } catch (error) {
    throw new Error(
      `e2e/.run-id not found or unreadable. Run global-setup first. Error: ${(error as Error).message}`,
      { cause: error },
    );
  }

  // Validate format: must match ^e2e-[a-z0-9]+-$
  const pattern = /^e2e-[a-z0-9]+-$/;
  if (!pattern.test(content)) {
    throw new Error(
      `e2e/.run-id has invalid format: "${content}". Expected pattern: ^e2e-[a-z0-9]+-$`,
    );
  }

  return content;
}
