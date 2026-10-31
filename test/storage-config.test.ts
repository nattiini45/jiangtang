import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * The production Compose stack must receive the upload-encryption key, and must
 * not carry a default POSTGRES_PASSWORD — the value has to be supplied.
 * Static parse only: no Docker, no database, no env loading.
 */

const COMPOSE_PATH = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));
const PROD_ENV_PATH = fileURLToPath(new URL("../.env.production.example", import.meta.url));

const REQUIRED_PASSWORD_REF = "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in the environment}";

type ComposeService = { environment?: Record<string, string> | string[] };
type Compose = { services: Record<string, ComposeService> };

function appEnvironment(compose: Compose): Record<string, string> {
  const env = compose.services.app?.environment;
  if (!env || Array.isArray(env)) throw new Error("app.environment must be a mapping");
  return env;
}

/** Collect every string leaf in the parsed document with its dotted path. */
function stringLeaves(node: unknown, path = "$"): Array<{ path: string; value: string }> {
  if (typeof node === "string") return [{ path, value: node }];
  if (Array.isArray(node)) return node.flatMap((v, i) => stringLeaves(v, `${path}[${i}]`));
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => stringLeaves(v, `${path}.${k}`));
  }
  return [];
}

/** Parse a dotenv-style file into a name → value map (no interpolation, no process.env writes). */
function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    out.set(m[1], m[2]);
  }
  return out;
}

describe("production compose: upload encryption key", () => {
  it("passes STORAGE_ENCRYPTION_KEY into the app container, required from the environment", async () => {
    const compose = parse(await readFile(COMPOSE_PATH, "utf8")) as Compose;
    const env = appEnvironment(compose);
    expect(env.STORAGE_ENCRYPTION_KEY).toBe(
      "${STORAGE_ENCRYPTION_KEY:?set STORAGE_ENCRYPTION_KEY in the environment}",
    );
  });

  it("passes STORAGE_KEY_SALT into the app container as an optional override (empty default)", async () => {
    const compose = parse(await readFile(COMPOSE_PATH, "utf8")) as Compose;
    expect(appEnvironment(compose).STORAGE_KEY_SALT).toBe("${STORAGE_KEY_SALT:-}");
  });

  it("production example declares a blank STORAGE_ENCRYPTION_KEY and no key material", async () => {
    const env = parseDotenv(await readFile(PROD_ENV_PATH, "utf8"));
    expect(env.has("STORAGE_ENCRYPTION_KEY")).toBe(true);
    expect(env.get("STORAGE_ENCRYPTION_KEY")).toBe("");
    expect(env.has("STORAGE_KEY_SALT")).toBe(true);
    expect(env.get("STORAGE_KEY_SALT")).toBe("");
  });
});

describe("production compose: POSTGRES_PASSWORD", () => {
  it("every reference requires a supplied value and has no demo-password fallback", async () => {
    const raw = await readFile(COMPOSE_PATH, "utf8");
    const compose = parse(raw) as Compose;
    const refs = stringLeaves(compose).filter((leaf) => leaf.value.includes("POSTGRES_PASSWORD"));

    // postgres (env), backup (PGPASSWORD), migrate (DATABASE_URL), app (DATABASE_URL)
    expect(refs.length).toBeGreaterThanOrEqual(4);
    for (const ref of refs) {
      expect(ref.value, ref.path).toContain(REQUIRED_PASSWORD_REF);
      expect(ref.value, ref.path).not.toMatch(/POSTGRES_PASSWORD:-/);
    }
    expect(raw).not.toMatch(/POSTGRES_PASSWORD:-/);
  });

  it("production example leaves POSTGRES_PASSWORD blank", async () => {
    const env = parseDotenv(await readFile(PROD_ENV_PATH, "utf8"));
    expect(env.get("POSTGRES_PASSWORD")).toBe("");
  });
});
