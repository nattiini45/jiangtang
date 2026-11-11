import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// These cases hand a POSIX bash a PATH holding only stub tools. Git Bash on Windows
// prepends its own /usr/bin to PATH, so the stubs cannot shadow the real ones there;
// Linux CI still runs them.
const itPosixPath = it.skipIf(process.platform === "win32");

/**
 * Preflight: the backup sidecar's scheduled command must invoke the Linux
 * scripts through an explicit `bash` interpreter. The Windows checkout does not
 * carry executable bits for ops/postgres/*.sh (git index mode 100644), so a bare
 * `/ops/backup.sh` is not portable. Each invocation keeps `|| true`, which keeps
 * the scheduler alive; it does NOT make a failed backup count as success.
 * Static parse only: no Docker, no database, no env loading.
 */

const COMPOSE_PATH = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));
const BACKUP_SCRIPT = fileURLToPath(new URL("../ops/postgres/backup.sh", import.meta.url));
const RESTORE_DRILL_SCRIPT = fileURLToPath(
  new URL("../ops/postgres/restore-drill.sh", import.meta.url),
);

type ComposeService = { command?: string | string[]; environment?: Record<string, string> };
type Compose = { services: Record<string, ComposeService> };

/** The backup service's command as one script text, whatever YAML shape it takes. */
function backupCommandText(compose: Compose): string {
  const cmd = compose.services.backup?.command;
  if (cmd === undefined) throw new Error("backup.command is missing");
  return Array.isArray(cmd) ? cmd.join("\n") : cmd;
}

/** Every non-empty line of the command that invokes a given /ops script. */
function invocationLines(text: string, script: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(script));
}

describe("backup sidecar: explicit Bash invocation", () => {
  it("invokes /ops/backup.sh only through bash, with || true, at both call sites", async () => {
    const compose = parse(await readFile(COMPOSE_PATH, "utf8")) as Compose;
    const lines = invocationLines(backupCommandText(compose), "/ops/backup.sh");

    // First run on container start + the daily run inside the loop.
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toBe("bash /ops/backup.sh || true");
    }
  });

  it("invokes /ops/restore-drill.sh only through bash, with its failure handled", async () => {
    const compose = parse(await readFile(COMPOSE_PATH, "utf8")) as Compose;
    const lines = invocationLines(backupCommandText(compose), "/ops/restore-drill.sh");

    // The drill's failure must not stop the scheduler AND must not write
    // a success marker, so it runs inside `if ...; then touch ...; fi` rather
    // than behind `|| true`.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("if bash /ops/restore-drill.sh; then");
  });

  it("has no bare /ops script invocation left in the backup command", async () => {
    const compose = parse(await readFile(COMPOSE_PATH, "utf8")) as Compose;
    const text = backupCommandText(compose);
    expect(text).not.toMatch(/(^|[^a-z ])\/ops\/(backup|restore-drill)\.sh/m);
    expect(text).not.toMatch(/(^|\n)\s*\/ops\//);
  });
});

const WALG_ENV_PATH = fileURLToPath(new URL("../ops/postgres/wal-g/env.sh", import.meta.url));

describe("Retention: setting rename, default and no deprecated alias", () => {
  it("both scripts use WALG_RETENTION_COUNT and no WALG_RETENTION_DAYS", async () => {
    for (const path of [BACKUP_SCRIPT, WALG_ENV_PATH]) {
      const text = await readFile(path, "utf8");
      expect(text, path).toContain("WALG_RETENTION_COUNT");
      expect(text, path).not.toContain("WALG_RETENTION_DAYS");
    }
  });

  it("env.sh defaults WALG_RETENTION_COUNT to 7 only when UNSET (no ':-', so empty stays invalid)", async () => {
    const text = await readFile(WALG_ENV_PATH, "utf8");
    expect(text).toMatch(/WALG_RETENTION_COUNT="\$\{WALG_RETENTION_COUNT-7\}"/);
    expect(text).not.toMatch(/WALG_RETENTION_COUNT:-/);
  });

  it("backup.sh uses the exact version-verified delete command and no VERIFY token", async () => {
    const text = await readFile(BACKUP_SCRIPT, "utf8");
    expect(text).toContain('wal-g delete retain FULL "${WALG_RETENTION_COUNT}" --confirm');
    expect(text).not.toMatch(/\bVERIFY\b/);
    expect(text.toLowerCase()).not.toContain("older than");
  });
});

/**
 * Executable retention test. A TEMPORARY fake `wal-g` records its argv; it is the only
 * wal-g reachable (PATH is replaced with the fake dir plus the bash/coreutils dirs).
 * No real bucket, no real backup. The temp dir is removed in afterAll.
 */
/**
 * Absolute host Bash. Node resolves a bare `bash` through the CHILD's PATH, and the
 * fake-PATH above has no Windows directory, so a bare name gives ENOENT on Windows.
 * On Windows, System32\bash.exe is the WSL launcher, so it is skipped.
 */
function resolveHostBash(): string {
  const names = process.platform === "win32" ? ["bash.exe"] : ["bash"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (process.platform === "win32" && /system32/i.test(candidate)) continue;
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("no Bash found on the host PATH");
}

/** Git Bash needs POSIX-form paths (C:\x -> /c/x) inside PATH and argv. */
function toShellPath(p: string): string {
  if (process.platform !== "win32") return p;
  return p.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, "/");
}

describe("Retention: executable deletion gate with a fake wal-g", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "walg-fake-"));
  const fakeBin = join(tmpRoot, "bin");
  const argvLog = join(tmpRoot, "argv.log");
  const pgdata = join(tmpRoot, "pgdata");

  beforeAll(() => {
    mkdirSync(fakeBin);
    mkdirSync(pgdata);
    writeFileSync(join(pgdata, "PG_VERSION"), "18\n");
    // Fake wal-g: append one line per invocation (argv joined with NUL-free spaces).
    const fake = `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${argvLog}"\nexit 0\n`;
    writeFileSync(join(fakeBin, "wal-g"), fake);
    chmodSync(join(fakeBin, "wal-g"), 0o755);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function runBackup(count: string | undefined): {
    status: number | null;
    deletes: string[];
    spawnError: string | undefined;
  } {
    rmSync(argvLog, { force: true });
    const env: Record<string, string> = {
      // The child's PATH must be POSIX-form for Git Bash; the fake dir comes first.
      PATH: `${toShellPath(fakeBin)}:/usr/bin:/bin`,
      WALG_S3_PREFIX: "s3://synthetic-bucket/postgres",
      AWS_ACCESS_KEY_ID: "synthetic-key-id",
      AWS_SECRET_ACCESS_KEY: "synthetic-secret",
      PGDATA: toShellPath(pgdata),
    };
    if (count !== undefined) env.WALG_RETENTION_COUNT = count;
    const result = spawnSync(resolveHostBash(), [toShellPath(BACKUP_SCRIPT)], {
      env,
      encoding: "utf8",
    });
    const deletes = existsSync(argvLog)
      ? readFileSync(argvLog, "utf8")
          .split(/\r?\n/)
          .filter((line) => line.startsWith("delete "))
      : [];
    return { status: result.status, deletes, spawnError: result.error?.message };
  }

  it("valid count 7 issues exactly the version-verified deletion command", () => {
    const { status, deletes, spawnError } = runBackup("7");
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(0);
    expect(deletes).toEqual(["delete retain FULL 7 --confirm"]);
  });

  it("default (unset) count issues the deletion with 7", () => {
    const { status, deletes, spawnError } = runBackup(undefined);
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(0);
    expect(deletes).toEqual(["delete retain FULL 7 --confirm"]);
  });

  it.each([
    ["zero", "0"],
    ["negative", "-3"],
    ["decimal", "2.5"],
    ["empty", ""],
    ["leading zero", "07"],
    ["non-numeric", "seven"],
  ])("invalid count (%s) issues NO delete command and fails", (_label, value) => {
    const { status, deletes, spawnError } = runBackup(value);
    // A real exit code 1..255 proves bash ran the script; null (spawn failure) must not pass.
    expect(spawnError, "bash must run").toBeUndefined();
    expect(typeof status === "number" && status >= 1 && status <= 255, `status=${status}`).toBe(
      true,
    );
    expect(deletes).toEqual([]);
  });
});

describe("backup scripts: Bash sourcing and secret requirement preserved", () => {
  it("both scripts still declare a Bash shebang and strict mode", async () => {
    for (const path of [BACKUP_SCRIPT, RESTORE_DRILL_SCRIPT]) {
      const text = await readFile(path, "utf8");
      expect(text.split(/\r?\n/)[0], path).toBe("#!/usr/bin/env bash");
      expect(text, path).toContain("set -euo pipefail");
    }
  });

  it("backup service still requires POSTGRES_PASSWORD (no demo fallback)", async () => {
    const compose = parse(await readFile(COMPOSE_PATH, "utf8")) as Compose;
    expect(compose.services.backup?.environment?.PGPASSWORD).toBe(
      "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in the environment}",
    );
  });
});

/**
 * The rehearsal override must start in bounded time, reuse an existing
 * bucket, keep the S3 endpoint internal, wait for the bucket before backing up,
 * and inherit no real integration configuration. Static parse plus a fake `aws`
 * CLI: no Docker, no S3, no network.
 */
const REHEARSAL_COMPOSE_PATH = fileURLToPath(
  new URL("../docker-compose.rehearsal.yml", import.meta.url),
);

type RehearsalService = {
  command?: string | string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  ports?: unknown;
};
type RehearsalCompose = { services: Record<string, RehearsalService> };

async function readRehearsalCompose(): Promise<RehearsalCompose> {
  return parse(await readFile(REHEARSAL_COMPOSE_PATH, "utf8")) as RehearsalCompose;
}

function minioInitCommand(compose: RehearsalCompose): string {
  const cmd = compose.services["minio-init"]?.command;
  if (cmd === undefined) throw new Error("minio-init.command is missing");
  return Array.isArray(cmd) ? cmd.join("\n") : cmd;
}

const BLANKED_APP_INTEGRATIONS = [
  "GLITCHTIP_DSN",
  "ICAL_FEED_TOKEN",
  "CALDAV_URL",
  "CALDAV_USERNAME",
  "CALDAV_PASSWORD",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_MODEL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_DIMENSIONS",
  "EMBEDDING_SEND_DIMENSIONS",
  "EMBEDDING_QUERY_TEMPLATE",
  "EMBEDDING_QUERY_INSTRUCTION",
  "EMBEDDING_PASSAGE_TEMPLATE",
  "RERANK_BASE_URL",
  "RERANK_MODEL",
  "RERANK_API_KEY",
  "GENERATION_BASE_URL",
  "GENERATION_MODEL",
  "GENERATION_API_KEY",
  "GENERATION_MAX_TOKENS",
  "GENERATION_SYSTEM_ROLE",
] as const;

describe("Rehearsal: bounded, private startup (static)", () => {
  it("bucket creation is a bounded head-bucket-then-mb loop with 30 x 2s defaults", async () => {
    const compose = await readRehearsalCompose();
    const init = compose.services["minio-init"];
    const text = minioInitCommand(compose);

    expect(init.environment?.MINIO_INIT_ATTEMPTS).toBe("${MINIO_INIT_ATTEMPTS:-30}");
    expect(init.environment?.MINIO_INIT_SLEEP_SECONDS).toBe("${MINIO_INIT_SLEEP_SECONDS:-2}");

    const head = text.indexOf("s3api head-bucket");
    const create = text.indexOf("s3 mb");
    expect(head, "head-bucket must exist").toBeGreaterThanOrEqual(0);
    expect(create, "s3 mb must exist").toBeGreaterThan(head);
    // Bounded: the old infinite `until` loop is gone, and exhaustion exits 1.
    expect(text).not.toMatch(/\buntil\b/);
    expect(text).toContain('[ "$${attempt}" -le "$${MINIO_INIT_ATTEMPTS}"');
    expect(text).toMatch(/exit 1\b/);
  });

  it("backup waits for PostgreSQL health AND successful bucket creation", async () => {
    const compose = await readRehearsalCompose();
    const dependsOn = compose.services.backup?.depends_on;

    expect(dependsOn?.postgres?.condition).toBe("service_healthy");
    expect(dependsOn?.["minio-init"]?.condition).toBe("service_completed_successfully");
  });

  it("never publishes the S3 endpoint to the host", async () => {
    const compose = await readRehearsalCompose();
    expect(compose.services.minio?.ports ?? []).toEqual([]);
    expect(compose.services["minio-init"]?.ports ?? []).toEqual([]);
  });

  it("takes S3 credentials from the private environment, not override constants", async () => {
    const compose = await readRehearsalCompose();
    const requiredAccess =
      "${REHEARSAL_S3_ACCESS_KEY:?set REHEARSAL_S3_ACCESS_KEY in the environment}";
    const requiredSecret =
      "${REHEARSAL_S3_SECRET_KEY:?set REHEARSAL_S3_SECRET_KEY in the environment}";

    const expected: Record<string, [string, string]> = {
      minio: ["RUSTFS_ACCESS_KEY", "RUSTFS_SECRET_KEY"],
      "minio-init": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
      postgres: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
      backup: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
      restore: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    };
    for (const [service, [accessKey, secretKey]] of Object.entries(expected)) {
      const env = compose.services[service]?.environment;
      expect(env?.[accessKey], service).toBe(requiredAccess);
      expect(env?.[secretKey], service).toBe(requiredSecret);
    }

    const raw = await readFile(REHEARSAL_COMPOSE_PATH, "utf8");
    expect(raw).not.toContain("minioadmin");
    // No literal credential values at all: every secret-shaped env value is
    // either blank (integration deliberately disabled) or an env reference.
    for (const [service, definition] of Object.entries(compose.services)) {
      for (const [key, value] of Object.entries(definition.environment ?? {})) {
        if (!/(KEY|PASSWORD|SECRET|TOKEN)/.test(key)) continue;
        const isBlank = value === "";
        const isReference = /^\$\{[A-Z0-9_]+:?/.test(value);
        expect(isBlank || isReference, `${service}.${key}`).toBe(true);
      }
    }
  });

  it("blanks real integrations and alerting but keeps the search indexer enabled", async () => {
    const compose = await readRehearsalCompose();
    const appEnv = compose.services.app?.environment ?? {};

    for (const key of BLANKED_APP_INTEGRATIONS) {
      expect(appEnv[key], key).toBe("");
    }
    expect(compose.services.alerting?.environment?.ALERT_WEBHOOK).toBe("");
    // Empty is the enabled default; only "off" disables indexing (index.boot.server.ts).
    expect(appEnv.SEARCH_INDEXER).toBe("");
    expect(appEnv.SEARCH_INDEXER).not.toBe("off");
  });
});

/**
 * Executable rehearsal test. A TEMPORARY fake `aws` records its argv and answers per
 * MODE. The extracted minio-init script runs under the host Bash with the fake
 * CLI as the only reachable `aws`. No Docker, no network, no real credentials.
 */
describe("Rehearsal: bucket bootstrap with a fake aws CLI", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "aws-fake-"));
  const fakeBin = join(tmpRoot, "bin");
  const argvLog = join(tmpRoot, "argv.log");
  const scriptPath = join(tmpRoot, "minio-init.sh");
  const SECRET_SENTINEL = "secret-sentinel-do-not-log";

  beforeAll(async () => {
    mkdirSync(fakeBin);
    // Compose escapes `$` as `$$`; de-escape so the script runs under a local shell.
    const script = minioInitCommand(await readRehearsalCompose()).replace(/\$\$/g, "$");
    writeFileSync(scriptPath, script);

    const fake = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${toShellPath(argvLog)}"
case "$MODE" in
  fresh)
    case "$*" in
      *s3api*head-bucket*) exit 1 ;;
      *"s3 mb"*) exit 0 ;;
      *) exit 255 ;;
    esac
    ;;
  existing)
    case "$*" in
      *s3api*head-bucket*) exit 0 ;;
      *) exit 255 ;;
    esac
    ;;
  auth) exit 254 ;;
  *) exit 255 ;;
esac
`;
    writeFileSync(join(fakeBin, "aws"), fake);
    chmodSync(join(fakeBin, "aws"), 0o755);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function runMinioInit(
    mode: string,
    attempts: number,
  ): { status: number | null; calls: string[]; output: string; spawnError: string | undefined } {
    rmSync(argvLog, { force: true });
    const env: Record<string, string> = {
      PATH: `${toShellPath(fakeBin)}:/usr/bin:/bin`,
      MODE: mode,
      WALG_BUCKET: "jiangtang-rehearsal",
      AWS_ACCESS_KEY_ID: "synthetic-key-id",
      AWS_SECRET_ACCESS_KEY: SECRET_SENTINEL,
      MINIO_INIT_ATTEMPTS: String(attempts),
      MINIO_INIT_SLEEP_SECONDS: "0",
    };
    const result = spawnSync(resolveHostBash(), [toShellPath(scriptPath)], {
      env,
      encoding: "utf8",
      // A regression to an unbounded loop must fail the suite, not hang it.
      timeout: 30_000,
    });
    const calls = existsSync(argvLog)
      ? readFileSync(argvLog, "utf8")
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
      : [];
    return {
      status: result.status,
      calls,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      spawnError: result.error?.message,
    };
  }

  it("creates the bucket once when it is fresh", () => {
    const { status, calls, output, spawnError } = runMinioInit("fresh", 30);
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/s3api head-bucket/);
    expect(calls[1]).toMatch(/s3 mb/);
    expect(output).toContain("created");
  });

  it("reuses an existing accessible bucket without calling mb", () => {
    const { status, calls, output, spawnError } = runMinioInit("existing", 30);
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/s3api head-bucket/);
    expect(output).toContain("present");
  });

  it("fails after exactly N attempts when the endpoint is unavailable", () => {
    const { status, calls, output, spawnError } = runMinioInit("unavailable", 2);
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    // head-bucket + mb on each of the two attempts; no third attempt.
    expect(calls).toHaveLength(4);
    expect(output).toContain("FATAL");
  });

  it("fails after exactly N attempts on authentication failure, never reporting success", () => {
    const { status, calls, output, spawnError } = runMinioInit("auth", 2);
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(calls).toHaveLength(4);
    expect(output).not.toContain("present");
    expect(output).not.toContain("created");
  });

  it("never prints the S3 secret", () => {
    for (const mode of ["fresh", "auth"]) {
      const { calls, output } = runMinioInit(mode, 1);
      expect(output).not.toContain(SECRET_SENTINEL);
      expect(calls.join("\n")).not.toContain(SECRET_SENTINEL);
    }
  });
});

/**
 * A restore is destructive, so it must demand explicit confirmation and
 * may only write into the configured empty data subdirectory — never delete an
 * existing one. Static guards plus a stub-wal-g run with a fake `rm` that stops
 * (and records) any regression that tries to delete.
 */
const RESTORE_SCRIPT = fileURLToPath(new URL("../ops/postgres/restore.sh", import.meta.url));
const IN_IMAGE_GUARD_TESTS = fileURLToPath(
  new URL("../ops/postgres/test-restore-guards.sh", import.meta.url),
);

describe("Restore: confirmation and destination guards (static)", () => {
  it("requires RESTORE_CONFIRM=empty-target before any storage call", async () => {
    const text = await readFile(RESTORE_SCRIPT, "utf8");
    expect(text).toContain('"${RESTORE_CONFIRM:-}" != "empty-target"');
    const confirmAt = text.indexOf("RESTORE_CONFIRM");
    const firstWalG = text.indexOf("wal-g");
    expect(confirmAt).toBeGreaterThanOrEqual(0);
    expect(firstWalG).toBeGreaterThan(confirmAt);
  });

  it("never removes the destination directory", async () => {
    const text = await readFile(RESTORE_SCRIPT, "utf8");
    expect(text).not.toMatch(/\brm\s+-[a-zA-Z]*r/);
    expect(text).toContain("refusing to overwrite");
  });

  it("keeps ownership and recovery-config steps", async () => {
    const text = await readFile(RESTORE_SCRIPT, "utf8");
    expect(text).toContain('chown -R postgres:postgres "${PGDATA_DIR}"');
    expect(text).toContain('chmod 700 "${PGDATA_DIR}"');
    expect(text).toContain("recovery_target_action = 'promote'");
    expect(text).toContain("recovery.signal");
  });

  it("main compose passes RESTORE_CONFIRM through and documents --no-deps", async () => {
    const compose = parse(await readFile(COMPOSE_PATH, "utf8")) as RehearsalCompose;
    expect(compose.services.restore?.environment?.RESTORE_CONFIRM).toBe("${RESTORE_CONFIRM:-}");
    const raw = await readFile(COMPOSE_PATH, "utf8");
    expect(raw).toContain("--no-deps");
    expect(raw).toContain("RESTORE_CONFIRM=empty-target");
  });

  it("rehearsal restore no longer depends on postgres but still waits on the bucket", async () => {
    const compose = await readRehearsalCompose();
    const deps = compose.services.restore?.depends_on ?? {};
    expect(deps.postgres).toBeUndefined();
    expect(deps["minio-init"]?.condition).toBe("service_completed_successfully");
    expect(await readFile(REHEARSAL_COMPOSE_PATH, "utf8")).toContain("--no-deps");
  });

  it("ships the in-image guard run", async () => {
    const text = await readFile(IN_IMAGE_GUARD_TESTS, "utf8");
    // The same container invocation CI must use; real postgres user + chown.
    expect(text).toContain("docker run --rm");
    expect(text).toContain("bash /ops/test-restore-guards.sh");
    expect(text).toContain("id postgres");
    expect(text).toContain("real chown");
    // Only wal-g is stubbed: no fake chown/chmod/rm in the sandbox.
    expect(text).toContain('cat > "$FAKE_BIN/wal-g"');
    expect(text).not.toMatch(/FAKE_BIN\/(chown|chmod|rm)/);
    expect(text).toContain("stat -c '%U:%G'");
  });
});

describe("Restore: executable guards with stub wal-g", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "restore-guard-"));
  const fakeBin = join(tmpRoot, "bin");
  const walLog = join(tmpRoot, "wal.log");
  const ownLog = join(tmpRoot, "own.log");
  const rmLog = join(tmpRoot, "rm.log");

  beforeAll(() => {
    mkdirSync(fakeBin);
    const wal = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${toShellPath(walLog)}"
case "$1" in
  backup-fetch)
    if [ "$FAIL_FETCH" = "1" ]; then exit 1; fi
    exit 0
    ;;
  *) exit 0 ;;
esac
`;
    const stub = (log: string, code: number) =>
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${toShellPath(log)}"\nexit ${code}\n`;
    writeFileSync(join(fakeBin, "wal-g"), wal);
    writeFileSync(join(fakeBin, "chown"), stub(ownLog, 0));
    writeFileSync(join(fakeBin, "chmod"), stub(ownLog, 0));
    // Safety barrier: a regression that deletes must hit this stub, not the host.
    writeFileSync(join(fakeBin, "rm"), stub(rmLog, 1));
    for (const name of ["wal-g", "chown", "chmod", "rm"]) {
      chmodSync(join(fakeBin, name), 0o755);
    }
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function readLines(path: string): string[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
  }

  type RunOptions = {
    mount: string;
    pgdata?: string | null;
    confirm?: string | null;
    failFetch?: boolean;
  };

  function runRestore(options: RunOptions) {
    rmSync(walLog, { force: true });
    rmSync(ownLog, { force: true });
    rmSync(rmLog, { force: true });
    const env: Record<string, string> = {
      PATH: `${toShellPath(fakeBin)}:/usr/bin:/bin`,
      WALG_S3_PREFIX: "s3://synthetic-bucket/postgres",
      AWS_ACCESS_KEY_ID: "synthetic-key-id",
      AWS_SECRET_ACCESS_KEY: "synthetic-secret",
      PGDATA_MOUNT: toShellPath(options.mount),
      FAIL_FETCH: options.failFetch ? "1" : "0",
    };
    if (options.pgdata !== null) {
      env.PGDATA = toShellPath(options.pgdata ?? join(options.mount, "18", "docker"));
    }
    if (options.confirm !== null) env.RESTORE_CONFIRM = options.confirm ?? "empty-target";
    const result = spawnSync(resolveHostBash(), [toShellPath(RESTORE_SCRIPT)], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    return {
      status: result.status,
      spawnError: result.error?.message,
      wal: readLines(walLog),
      own: readLines(ownLog),
      rm: readLines(rmLog),
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  }

  function freshMount(label: string): string {
    const mount = join(tmpRoot, `mount-${label}`);
    mkdirSync(mount, { recursive: true });
    return mount;
  }

  it("fails before any storage call without the confirmation", () => {
    const mount = freshMount("no-confirm");
    const target = join(mount, "18", "docker");
    const { status, wal, rm, spawnError } = runRestore({ mount, confirm: null });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toEqual([]);
    expect(rm).toEqual([]);
    expect(existsSync(target)).toBe(false);
  });

  it("fails before any storage call with the wrong confirmation", () => {
    const mount = freshMount("wrong-confirm");
    const { status, wal, rm, spawnError } = runRestore({ mount, confirm: "yes" });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toEqual([]);
    expect(rm).toEqual([]);
  });

  it("refuses a populated target and leaves every byte, including dotfiles", () => {
    const mount = freshMount("populated");
    const target = join(mount, "18", "docker");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "data.bin"), "keep-me");
    writeFileSync(join(target, ".hidden"), "dot-keep");
    const { status, wal, rm, spawnError } = runRestore({ mount });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toEqual([]);
    expect(rm).toEqual([]);
    expect(readFileSync(join(target, "data.bin"), "utf8")).toBe("keep-me");
    expect(readFileSync(join(target, ".hidden"), "utf8")).toBe("dot-keep");
  });

  it("treats a dotfile-only target as nonempty", () => {
    const mount = freshMount("dot-only");
    const target = join(mount, "18", "docker");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, ".hidden"), "dot-keep");
    const { status, wal, rm, spawnError } = runRestore({ mount });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toEqual([]);
    expect(rm).toEqual([]);
    expect(readFileSync(join(target, ".hidden"), "utf8")).toBe("dot-keep");
  });

  it.each([
    ["the mount root", (mount: string) => mount],
    ["a relative path", () => "18/docker"],
    ["the filesystem root", () => "/"],
  ])("refuses %s without touching it", (label, pgdataFor) => {
    const mount = freshMount(`root-${label.replace(/\s+/g, "-")}`);
    writeFileSync(join(mount, "marker.txt"), "mount-keep");
    const { status, wal, rm, spawnError } = runRestore({ mount, pgdata: pgdataFor(mount) });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toEqual([]);
    // The fake rm records any deletion attempt; it must never appear.
    expect(rm).toEqual([]);
    expect(readFileSync(join(mount, "marker.txt"), "utf8")).toBe("mount-keep");
  });

  it("refuses a missing PGDATA instead of guessing a default", () => {
    const mount = freshMount("no-pgdata");
    const { status, wal, rm, spawnError } = runRestore({ mount, pgdata: null });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toEqual([]);
    expect(rm).toEqual([]);
  });

  itPosixPath("restores into an existing empty target and writes the recovery config", () => {
    const mount = freshMount("empty");
    const target = join(mount, "18", "docker");
    mkdirSync(target, { recursive: true });
    const { status, wal, own, rm, spawnError } = runRestore({ mount });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(0);
    expect(wal[0]).toBe("backup-list");
    expect(wal[1]).toMatch(/^backup-fetch .* LATEST$/);
    expect(rm).toEqual([]);
    expect(existsSync(join(target, "recovery.signal"))).toBe(true);
    const conf = readFileSync(join(target, "postgresql.auto.conf"), "utf8");
    expect(conf).toContain('restore_command = \'wal-g wal-fetch "%f" "%p"\'');
    expect(conf).toContain("recovery_target_action = 'promote'");
    expect(own.some((line) => line.startsWith("-R postgres:postgres "))).toBe(true);
    expect(own.some((line) => line.startsWith("700 "))).toBe(true);
  });

  itPosixPath("creates a missing target and restores into it", () => {
    const mount = freshMount("missing");
    const target = join(mount, "18", "docker");
    const { status, wal, spawnError } = runRestore({ mount });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(0);
    expect(wal).toHaveLength(2);
    expect(existsSync(join(target, "recovery.signal"))).toBe(true);
  });

  it("fails without recovery files when the download fails", () => {
    const mount = freshMount("fetch-fail");
    const target = join(mount, "18", "docker");
    mkdirSync(target, { recursive: true });
    const { status, own, rm, spawnError } = runRestore({ mount, failFetch: true });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(existsSync(join(target, "recovery.signal"))).toBe(false);
    expect(existsSync(join(target, "postgresql.auto.conf"))).toBe(false);
    expect(own).toEqual([]);
    expect(rm).toEqual([]);
  });
});

/** A targeted restore must go through the validated selector, never LATEST. */
function resolveHostPython(): string {
  const names =
    process.platform === "win32" ? ["python3.exe", "python.exe"] : ["python3", "python"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (process.platform === "win32" && /system32/i.test(candidate)) continue;
      if (existsSync(candidate)) return candidate;
    }
  }
  // The test run's child PATH is deliberately narrow (no MSYS bin dir), so
  // fall back to the conventional interpreter locations for the host platform.
  const fallbacks: string[] = [];
  if (process.platform === "win32") {
    const drive = process.env.SystemDrive ?? "C:";
    const msystem = (process.env.MSYSTEM ?? "UCRT64").toLowerCase();
    fallbacks.push(
      `${drive}/msys64/${msystem}/bin/python3.exe`,
      `${drive}/msys64/ucrt64/bin/python3.exe`,
      `${drive}/msys64/mingw64/bin/python3.exe`,
    );
  } else {
    fallbacks.push("/usr/bin/python3", "/usr/local/bin/python3");
  }
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no Python found on the host PATH or conventional locations");
}

describe("Targeted restore: wiring and selector use (static)", () => {
  it("passes BACKUP_NAME into the restore service and documents targeted use", async () => {
    const compose = parse(await readFile(COMPOSE_PATH, "utf8")) as RehearsalCompose;
    expect(compose.services.restore?.environment?.BACKUP_NAME).toBe("${BACKUP_NAME:-}");
    const raw = await readFile(COMPOSE_PATH, "utf8");
    expect(raw).toContain("BACKUP_NAME=base_");
    expect(raw).toContain("TARGET_TS");
  });

  it("invokes the parser explicitly and fetches metadata read-only before the fetch", async () => {
    const text = await readFile(RESTORE_SCRIPT, "utf8");
    expect(text).toContain("wal-g backup-list --json --detail");
    expect(text).toContain(
      'wal-g st cat "basebackups_005/${BACKUP_NAME}_backup_stop_sentinel.json"',
    );
    expect(text).toContain('python3 "$(dirname "$0")/select-backup.py"');
    expect(text).not.toContain("<(");
    expect(text.indexOf("select-backup.py")).toBeLessThan(text.indexOf("backup-fetch"));
  });

  it("keeps temporary metadata private and removes it on exit", async () => {
    const text = await readFile(RESTORE_SCRIPT, "utf8");
    expect(text).toContain('chmod 700 "$META_DIR"');
    expect(text).toContain("trap cleanup EXIT");
    expect(text).toContain('rm -f "$META_DIR/backup-list.json"');
  });
});

describe("Targeted restore: executable selector gate", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "restore-selector-"));
  const fakeBin = join(tmpRoot, "bin");
  const walLog = join(tmpRoot, "wal.log");
  const ownLog = join(tmpRoot, "own.log");
  const rmLog = join(tmpRoot, "rm.log");
  const pythonLog = join(tmpRoot, "python.log");
  const tempRoot = join(tmpRoot, "tmp");
  const fixtures = join(tmpRoot, "fixtures");
  const listPath = join(fixtures, "list.json");
  const sentinelPath = join(fixtures, "sentinel.json");

  const NAME = "base_000000010000000000000002";
  const OTHER = "base_000000010000000000000003";
  const TARGET = "2026-10-08T21:00:00Z";
  // PostgreSQL rejects the "Z" suffix in recovery_target_time at server start;
  // the selector's normalized output uses a numeric +00:00 offset.
  const NORMALIZED_TARGET = "2026-10-08T21:00:00.000000+00:00";
  const START = "2026-10-08T20:00:00Z";
  const FINISH = "2026-10-08T20:05:00Z";
  const fullEntry = {
    backup_name: NAME,
    start_time: START,
    finish_time: FINISH,
    is_permanent: false,
  };
  const fullSentinel = { StartTime: START, FinishTime: FINISH };
  const hostPython = resolveHostPython();

  beforeAll(() => {
    mkdirSync(fakeBin);
    mkdirSync(fixtures);
    mkdirSync(tempRoot);

    const wal = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${toShellPath(walLog)}"
case "$1" in
  backup-list)
    if [ "$LIST_FAIL" = "1" ]; then exit 1; fi
    if [ "$LIST_MODE" = "malformed" ]; then printf '{not json\n'; exit 0; fi
    cat "${toShellPath(listPath)}"
    ;;
  st)
    if [ "$SENTINEL_FAIL" = "1" ]; then exit 1; fi
    cat "${toShellPath(sentinelPath)}"
    ;;
  backup-fetch)
    if [ "$FAIL_FETCH" = "1" ]; then exit 1; fi
    exit 0
    ;;
  *) exit 0 ;;
esac
`;
    const stub = (log: string, code: number) =>
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${toShellPath(log)}"\nexit ${code}\n`;
    const python = `#!/usr/bin/env bash
printf '%s\n' "$4" >> "${toShellPath(pythonLog)}"
if [ "$FAKE_SELECT" = "bad-name" ]; then
  printf '%s\n' "../evil"
  printf '%s\n' "${NORMALIZED_TARGET}"
  exit 0
fi
exec "${toShellPath(hostPython)}" "$@"
`;
    // rm is legitimate ONLY for the script's own metadata under TMPDIR; any
    // recursive flag or foreign path is blocked and recorded.
    const guardedRm = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${toShellPath(rmLog)}"
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    "$TMPDIR"/*) ;;
    *) exit 1 ;;
  esac
done
exec /usr/bin/rm "$@"
`;
    writeFileSync(join(fakeBin, "wal-g"), wal);
    writeFileSync(join(fakeBin, "python3"), python);
    writeFileSync(join(fakeBin, "chown"), stub(ownLog, 0));
    writeFileSync(join(fakeBin, "chmod"), stub(ownLog, 0));
    writeFileSync(join(fakeBin, "rm"), guardedRm);
    for (const name of ["wal-g", "python3", "chown", "chmod", "rm"]) {
      chmodSync(join(fakeBin, name), 0o755);
    }
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  type RunOptions = {
    name?: string | null;
    target?: string | null;
    list?: unknown[];
    sentinel?: Record<string, unknown>;
    listFail?: boolean;
    sentinelFail?: boolean;
    listMode?: "malformed";
    failFetch?: boolean;
    fakeSelect?: "bad-name";
  };

  function readLines(path: string): string[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
  }

  function runRestore(options: RunOptions) {
    writeFileSync(listPath, JSON.stringify(options.list ?? [fullEntry]));
    writeFileSync(sentinelPath, JSON.stringify(options.sentinel ?? fullSentinel));
    for (const log of [walLog, ownLog, rmLog, pythonLog]) rmSync(log, { force: true });
    const mount = join(tmpRoot, `mount-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(mount, "18", "docker"), { recursive: true });
    const env: Record<string, string> = {
      PATH: `${toShellPath(fakeBin)}:/usr/bin:/bin`,
      TMPDIR: toShellPath(tempRoot),
      WALG_S3_PREFIX: "s3://synthetic-bucket/postgres",
      AWS_ACCESS_KEY_ID: "synthetic-key-id",
      AWS_SECRET_ACCESS_KEY: "synthetic-secret",
      PGDATA_MOUNT: toShellPath(mount),
      PGDATA: toShellPath(join(mount, "18", "docker")),
      RESTORE_CONFIRM: "empty-target",
      LIST_JSON: toShellPath(listPath),
      SENTINEL_JSON: toShellPath(sentinelPath),
      LIST_FAIL: options.listFail ? "1" : "0",
      SENTINEL_FAIL: options.sentinelFail ? "1" : "0",
      LIST_MODE: options.listMode ?? "",
      FAIL_FETCH: options.failFetch ? "1" : "0",
      FAKE_SELECT: options.fakeSelect ?? "",
    };
    if (options.name !== null) env.BACKUP_NAME = options.name ?? NAME;
    if (options.target !== null) env.TARGET_TS = options.target ?? TARGET;
    const result = spawnSync(resolveHostBash(), [toShellPath(RESTORE_SCRIPT)], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    return {
      status: result.status,
      spawnError: result.error?.message,
      wal: readLines(walLog),
      own: readLines(ownLog),
      rm: readLines(rmLog),
      python: readLines(pythonLog),
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      target: join(mount, "18", "docker"),
      tempRootEmpty: readdirSync(tempRoot).length === 0,
    };
  }

  it("requires BACKUP_NAME when TARGET_TS is set", () => {
    const { status, wal, spawnError } = runRestore({ name: null });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toEqual([]);
  });

  it("refuses BACKUP_NAME without TARGET_TS instead of silently using LATEST", () => {
    const { status, wal, spawnError } = runRestore({ target: null });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toEqual([]);
  });

  it.each([["LATEST"], ["../base_000000010000000000000002"], [`${NAME}_D_20261008T200000Z`]])(
    "refuses unsafe backup name %s before any storage call",
    (name) => {
      const { status, wal, spawnError } = runRestore({ name });
      expect(spawnError, "bash must run").toBeUndefined();
      expect(status).toBe(1);
      expect(wal).toEqual([]);
    },
  );

  itPosixPath("fetches a valid older base by exact name and normalizes the target", () => {
    const { status, wal, rm, python, target, tempRootEmpty, spawnError } = runRestore({
      target: "2026-10-08T23:00:00+02:00",
    });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(0);
    expect(wal[0]).toBe("backup-list --json --detail");
    expect(wal[1]).toBe(`st cat basebackups_005/${NAME}_backup_stop_sentinel.json`);
    expect(wal[2]).toMatch(new RegExp(`^backup-fetch .* ${NAME}$`));
    expect(wal.join("\n")).not.toContain("LATEST");
    // Metadata cleanup may use rm -f under TMPDIR; recursive/foreign rm never.
    expect(rm.filter((line) => /(^|\s)-[a-zA-Z]*r/.test(line))).toEqual([]);
    expect(rm.every((line) => line.includes(toShellPath(tempRoot)))).toBe(true);
    expect(python).toHaveLength(1);
    expect(python[0]).toContain(toShellPath(tempRoot));
    expect(tempRootEmpty).toBe(true);
    expect(readFileSync(join(target, "postgresql.auto.conf"), "utf8")).toContain(
      `recovery_target_time = '${NORMALIZED_TARGET}'`,
    );
  });

  it("refuses a base that finished after the target before fetching", () => {
    const { status, wal, own, target, tempRootEmpty, spawnError } = runRestore({
      target: "2026-10-08T20:04:00Z",
    });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toHaveLength(2);
    expect(wal.some((line) => line.startsWith("backup-fetch"))).toBe(false);
    expect(own.filter((line) => line.startsWith("-R postgres:postgres"))).toEqual([]);
    expect(existsSync(join(target, "recovery.signal"))).toBe(false);
    expect(tempRootEmpty).toBe(true);
  });

  it("refuses a missing backup name entry before fetching", () => {
    const { status, wal, spawnError } = runRestore({
      list: [{ ...fullEntry, backup_name: OTHER }],
    });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal.some((line) => line.startsWith("backup-fetch"))).toBe(false);
  });

  it("fails when the backup list cannot be fetched", () => {
    const { status, wal, spawnError } = runRestore({ listFail: true });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toHaveLength(1);
    expect(wal[0]).toBe("backup-list --json --detail");
  });

  it("fails when the sentinel cannot be fetched", () => {
    const { status, wal, spawnError } = runRestore({ sentinelFail: true });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toHaveLength(2);
    expect(wal.some((line) => line.startsWith("backup-fetch"))).toBe(false);
  });

  it("fails on malformed list JSON before fetching", () => {
    const { status, wal, spawnError } = runRestore({ listMode: "malformed" });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal.some((line) => line.startsWith("backup-fetch"))).toBe(false);
  });

  it("re-validates the parser's output name before using it", () => {
    const { status, wal, spawnError } = runRestore({ fakeSelect: "bad-name" });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toHaveLength(2);
    expect(wal.some((line) => line.startsWith("backup-fetch"))).toBe(false);
  });
});

/**
 * The drill must be honest, private and non-root. Static invariants plus an
 * executable harness with stub pg tools: no PostgreSQL server, no S3, no Docker.
 */
describe("Drill: honest, private, non-root (static)", () => {
  it("uses a unique private temp root with cleanup installed immediately", async () => {
    const text = await readFile(RESTORE_DRILL_SCRIPT, "utf8");
    expect(text).toContain("mktemp -d");
    expect(text).toContain("jiangtang-restore-drill.XXXXXX");
    expect(text).toContain("trap cleanup EXIT");
    expect(text).not.toMatch(/DRILL_PGDATA="\/tmp\//);
    expect(text).toContain('rm -rf -- "$DRILL_ROOT"');
  });

  it("reuses the guarded restore.sh for both latest and targeted recovery", async () => {
    const text = await readFile(RESTORE_DRILL_SCRIPT, "utf8");
    expect(text).toContain('PGDATA_MOUNT="$DRILL_ROOT"');
    expect(text).toContain('PGDATA="$DRILL_PGDATA"');
    expect(text).toContain("RESTORE_CONFIRM=empty-target");
    expect(text).toContain('bash "$(dirname "$0")/restore.sh"');
    expect(text).toContain('TARGET_TS="$TARGET_TS"');
    expect(text).toContain('BACKUP_NAME="$BACKUP_NAME"');
  });

  it("requires the database identity and the postgres toolchain before working", async () => {
    const text = await readFile(RESTORE_DRILL_SCRIPT, "utf8");
    expect(text).toContain(': "${PGDATABASE:?');
    expect(text).toContain(': "${PGUSER:?');
    expect(text).toContain(': "${PGPASSWORD:?');
    // Assert the actual required-tool list, not a repeated literal: removing a
    // tool from the script's loop must fail this check.
    expect(text).toContain("for tool in gosu pg_ctl pg_isready psql; do");
    expect(text).toContain('command -v "$tool"');
    expect(text).toContain("pg_isready -h 127.0.0.1");
  });

  it("starts as postgres, loopback-only, with archiving off and ON_ERROR_STOP invariants", async () => {
    const text = await readFile(RESTORE_DRILL_SCRIPT, "utf8");
    expect(text).toContain("gosu postgres pg_ctl");
    expect(text).toContain("listen_addresses=127.0.0.1");
    expect(text).toContain("archive_mode=off");
    expect(text).toContain("ON_ERROR_STOP=1");
    expect(text).toContain("verify-invariants.sql");
    expect(text).toContain("pg_is_in_recovery()");
    expect(text).toContain("restore/query/invariant smoke check passed");
    expect(text).not.toContain("row counts match");
  });

  it("passes PGDATABASE to the backup sidecar and marks success only inside success", async () => {
    const raw = await readFile(COMPOSE_PATH, "utf8");
    expect(raw).toContain("PGDATABASE: ${POSTGRES_DB:-jiangtang}");
    expect(raw).toMatch(/if bash \/ops\/restore-drill\.sh; then\s*\n\s*touch/);
    expect(raw).not.toMatch(/restore-drill\.sh \|\| true\s*\n\s*touch/);
    expect(
      await readFile(fileURLToPath(new URL("../.env.production.example", import.meta.url)), "utf8"),
    ).toContain("SMOKE CHECK");
  });
});

describe("Drill: executable control flow with stub pg tools", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "drill-"));
  const fakeBin = join(tmpRoot, "bin");
  const tempRoot = join(tmpRoot, "tmp");
  const fixtures = join(tmpRoot, "fixtures");
  const walLog = join(tmpRoot, "wal.log");
  const ctlLog = join(tmpRoot, "pgctl.log");
  const gosuLog = join(tmpRoot, "gosu.log");
  const psqlLog = join(tmpRoot, "psql.log");
  const rmLog = join(tmpRoot, "rm.log");
  const otherLog = join(tmpRoot, "other.log");
  const listPath = join(fixtures, "list.json");
  const sentinelPath = join(fixtures, "sentinel.json");

  const NAME = "base_000000010000000000000002";
  const START = "2026-10-08T20:00:00Z";
  const FINISH = "2026-10-08T20:05:00Z";
  const TARGET = "2026-10-08T21:00:00Z";
  const hostPython = resolveHostPython();

  beforeAll(() => {
    mkdirSync(fakeBin);
    mkdirSync(fixtures);
    mkdirSync(tempRoot);
    writeFileSync(
      listPath,
      JSON.stringify([
        { backup_name: NAME, start_time: START, finish_time: FINISH, is_permanent: false },
      ]),
    );
    writeFileSync(sentinelPath, JSON.stringify({ StartTime: START, FinishTime: FINISH }));

    const wal = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${toShellPath(walLog)}"
case "$1" in
  backup-list)
    if [ "$LIST_MODE" = "json" ]; then cat "${toShellPath(listPath)}"; fi
    ;;
  st) cat "${toShellPath(sentinelPath)}" ;;
  backup-fetch) exit 0 ;;
esac
exit 0
`;
    const logStub = (log: string, code: number) =>
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${toShellPath(log)}"\nexit ${code}\n`;
    const gosu = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${toShellPath(gosuLog)}"
shift
exec "$@"
`;
    const pgIsReady = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${toShellPath(otherLog)}"
if [ "$OCCUPIED" = "1" ]; then exit 0; fi
exit 1
`;
    const psql = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${toShellPath(psqlLog)}"
case "$*" in
  *pg_is_in_recovery*) printf 'f\\n'; exit 0 ;;
esac
case "$*" in
  *" -f "*) if [ "$FAIL_INVARIANTS" = "1" ]; then exit 1; fi; exit 0 ;;
esac
exit 0
`;
    const guardedRm = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${toShellPath(rmLog)}"
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    "$TMPDIR"/*) ;;
    *) exit 1 ;;
  esac
done
exec /usr/bin/rm "$@"
`;
    writeFileSync(join(fakeBin, "wal-g"), wal);
    writeFileSync(join(fakeBin, "gosu"), gosu);
    writeFileSync(join(fakeBin, "pg_ctl"), logStub(ctlLog, 0));
    writeFileSync(join(fakeBin, "pg_isready"), pgIsReady);
    writeFileSync(join(fakeBin, "psql"), psql);
    writeFileSync(join(fakeBin, "id"), logStub(otherLog, 0));
    writeFileSync(join(fakeBin, "chown"), logStub(otherLog, 0));
    writeFileSync(join(fakeBin, "chmod"), logStub(otherLog, 0));
    writeFileSync(join(fakeBin, "rm"), guardedRm);
    writeFileSync(
      join(fakeBin, "python3"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${toShellPath(otherLog)}"\nexec "${toShellPath(hostPython)}" "$@"\n`,
    );
    for (const name of [
      "wal-g",
      "gosu",
      "pg_ctl",
      "pg_isready",
      "psql",
      "id",
      "chown",
      "chmod",
      "rm",
      "python3",
    ]) {
      chmodSync(join(fakeBin, name), 0o755);
    }
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function readLines(path: string): string[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
  }

  type DrillOptions = {
    pgDatabase?: string | null;
    target?: string | null;
    name?: string | null;
    occupied?: boolean;
    failInvariants?: boolean;
  };

  function runDrill(options: DrillOptions) {
    writeFileSync(
      listPath,
      JSON.stringify([
        { backup_name: NAME, start_time: START, finish_time: FINISH, is_permanent: false },
      ]),
    );
    writeFileSync(sentinelPath, JSON.stringify({ StartTime: START, FinishTime: FINISH }));
    for (const log of [walLog, ctlLog, gosuLog, psqlLog, rmLog, otherLog]) {
      rmSync(log, { force: true });
    }
    const env: Record<string, string> = {
      PATH: `${toShellPath(fakeBin)}:/usr/bin:/bin`,
      TMPDIR: toShellPath(tempRoot),
      WALG_S3_PREFIX: "s3://synthetic-bucket/postgres",
      AWS_ACCESS_KEY_ID: "synthetic-key-id",
      AWS_SECRET_ACCESS_KEY: "synthetic-secret",
      PGUSER: "synthetic-user",
      PGPASSWORD: "synthetic-password",
      DRILL_PORT: "55433",
      OCCUPIED: options.occupied ? "1" : "0",
      FAIL_INVARIANTS: options.failInvariants ? "1" : "0",
      LIST_MODE: options.target !== null ? "json" : "",
    };
    if (options.pgDatabase !== null) env.PGDATABASE = options.pgDatabase ?? "jiangtang";
    if (options.target !== undefined && options.target !== null) env.TARGET_TS = options.target;
    if (options.name !== undefined && options.name !== null) env.BACKUP_NAME = options.name;
    const result = spawnSync(resolveHostBash(), [toShellPath(RESTORE_DRILL_SCRIPT)], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    return {
      status: result.status,
      spawnError: result.error?.message,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      wal: readLines(walLog),
      ctl: readLines(ctlLog),
      gosu: readLines(gosuLog),
      psql: readLines(psqlLog),
      rm: readLines(rmLog),
      tempEmpty: readdirSync(tempRoot).length === 0,
    };
  }

  itPosixPath(
    "runs the latest-available path as postgres and cleans up its own root",
    () => {
      const { status, output, wal, ctl, gosu, psql, rm, tempEmpty, spawnError } = runDrill({});
      expect(spawnError, "bash must run").toBeUndefined();
      expect(status).toBe(0);
      expect(output).toContain("restore/query/invariant smoke check passed");
      expect(output).toContain("does NOT prove source-data equality");
      expect(wal.some((line) => line.startsWith("backup-fetch"))).toBe(true);
      expect(wal.join("\n")).toContain("LATEST"); // documented latest-available path
      expect(gosu.some((line) => line.startsWith("postgres pg_ctl"))).toBe(true);
      expect(ctl.some((line) => line.includes(" start"))).toBe(true);
      expect(ctl.some((line) => line.includes(" stop"))).toBe(true);
      expect(psql.some((line) => line.includes("ON_ERROR_STOP=1"))).toBe(true);
      expect(psql.some((line) => line.includes("verify-invariants.sql"))).toBe(true);
      expect(rm.every((line) => line.includes(toShellPath(tempRoot)))).toBe(true);
      expect(tempEmpty).toBe(true);
    },
    30_000,
  );

  itPosixPath(
    "refuses an occupied port before restoring",
    () => {
      const { status, output, wal, tempEmpty, spawnError } = runDrill({ occupied: true });
      expect(spawnError, "bash must run").toBeUndefined();
      expect(status).toBe(1);
      expect(output).toContain("already serving PostgreSQL");
      expect(wal).toEqual([]);
      expect(tempEmpty).toBe(true);
    },
    30_000,
  );

  it("requires PGDATABASE before doing any work", () => {
    const { status, wal, tempEmpty, spawnError } = runDrill({ pgDatabase: null });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toEqual([]);
    expect(tempEmpty).toBe(true);
  }, 30_000);

  itPosixPath(
    "fails and leaves no PASS when an invariant query fails",
    () => {
      const { status, output, rm, tempEmpty, spawnError } = runDrill({ failInvariants: true });
      expect(spawnError, "bash must run").toBeUndefined();
      expect(status).toBe(1);
      expect(output).not.toContain("restore/query/invariant smoke check passed");
      expect(rm.some((line) => line.includes("jiangtang-restore-drill."))).toBe(true);
      expect(tempEmpty).toBe(true);
    },
    30_000,
  );

  itPosixPath(
    "passes TARGET_TS and BACKUP_NAME through the same validated path",
    () => {
      const { status, output, wal, spawnError } = runDrill({ target: TARGET, name: NAME });
      expect(spawnError, "bash must run").toBeUndefined();
      expect(status).toBe(0);
      expect(wal[0]).toBe("backup-list --json --detail");
      expect(wal[1]).toBe(`st cat basebackups_005/${NAME}_backup_stop_sentinel.json`);
      expect(wal.some((line) => line.includes(`backup-fetch`) && line.includes(NAME))).toBe(true);
      expect(wal.join("\n")).not.toContain("LATEST");
      expect(output).toContain("restore/query/invariant smoke check passed");
    },
    30_000,
  );

  it("refuses BACKUP_NAME without TARGET_TS", () => {
    const { status, wal, spawnError } = runDrill({ name: NAME });
    expect(spawnError, "bash must run").toBeUndefined();
    expect(status).toBe(1);
    expect(wal).toEqual([]);
  }, 30_000);
});

/**
 * the in-image restore guard and selector must be WIRED INTO CI.
 *
 * Why this parses the workflow: `ops/postgres/test-restore-guards.sh` documents
 * the container invocation in its own header, and the "ships the in-image guard
 * run" assertion above reads that script's TEXT. A text mention proves nothing
 * about what CI executes: a guard can be documented in a script and never wired
 * into the workflow. These assertions
 * parse `.github/workflows/ci.yml` and inspect only executable `run` steps and
 * their structured keys, so a YAML comment or a script comment cannot satisfy
 * them.
 *
 * Static only: this package may not run `docker build` or `docker run`, so
 * nothing here shows that the image builds or that the in-image suites pass on
 * linux/amd64. Wiring is not execution.
 */

const CI_WORKFLOW_PATH = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));

const IMAGE_BUILD =
  /^docker build --platform linux\/amd64 -f ops\/postgres\/Dockerfile\.walg -t (jiangtang-postgres-walg:\S+) ops\/postgres$/;
const IMAGE_MOUNT = '-v "$PWD/ops/postgres:/ops:ro"';
const DOCKER_RUN_PREFIX = `docker run --rm --network none ${IMAGE_MOUNT} `;
const RUN_TAG = /^docker run --rm --network none -v "\$PWD\/ops\/postgres:\/ops:ro" (\S+) /;
const RESTORE_ARGV = "bash /ops/test-restore-guards.sh";
const SELECTOR_ARGV = "python3 -m unittest discover -s /ops -p test_select_backup.py";
const RUNNER_SELECTOR_ARGV =
  "python3 -m unittest discover -s ops/postgres -p test_select_backup.py";
const APP_BUILD = /^docker build --platform linux\/amd64 -t (\S+) \.$/;
const DB_DEPLOY_COMMAND = "pnpm db:deploy";
const INVARIANTS_FILE = "ops/postgres/verify-invariants.sql";
const INVARIANTS_COMMAND = `pnpm exec prisma db execute --file ${INVARIANTS_FILE}`;
const INVARIANTS_STEP = "Verify database invariants";
const INVARIANTS_NEGATIVE_STEP = "Verify the invariant check fails when an invariant is missing";
const SMOKE_STEP = "Smoke-test the application image";
const APP_BUILD_STEP = "Build the application image";
const SMOKE_DATABASE = "jiangtang_smoke";
// Integrations the smoke container starts with blank, so nothing outside is called.
const SMOKE_BLANK_VARIABLES = [
  "EMBEDDING_BASE_URL",
  "RERANK_BASE_URL",
  "GENERATION_BASE_URL",
  "GLITCHTIP_DSN",
  "CALDAV_URL",
  "CALDAV_USERNAME",
  "CALDAV_PASSWORD",
];
// The only lines of the smoke step's cleanup() allowed to end in `|| true`: a failed log dump or an
// already-removed container must not replace the exit status that triggered the trap.
const SMOKE_CLEANUP_TOLERATED = [
  "docker logs jiangtang-smoke || true",
  "docker rm -f jiangtang-smoke > /dev/null 2>&1 || true",
];

type CIStep = {
  name?: string;
  run?: string;
  uses?: string;
  if?: unknown;
  "continue-on-error"?: unknown;
  env?: Record<string, unknown>;
};

type CIWorkflow = {
  on?: unknown;
  permissions?: unknown;
  jobs?: Record<
    string,
    { permissions?: unknown; if?: unknown; "continue-on-error"?: unknown; steps?: CIStep[] }
  >;
};

type CIRunStep = { index: number; name: string; run: string; step: CIStep };
type BuildRef = { step: CIRunStep; command: string; tag: string | undefined };

/**
 * One step's executable commands: YAML comments never reach this function,
 * shell comment lines are dropped, and `&&`, `||` and `;` split the remainder.
 * A swallowed exit therefore shows up as its own command ("true", "exit 0"),
 * and a commented-out command disappears entirely.
 */
function shellCommands(script: string): string[] {
  return script
    .split(/\r?\n/)
    .flatMap((line) => line.split(/&&|\|\||;/))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function parseWorkflow(text: string): ParallelWorkflow {
  return parse(text) as ParallelWorkflow;
}

type ParallelWorkflow = Omit<CIWorkflow, "jobs"> & {
  defaults?: unknown;
  jobs?: Record<
    string,
    NonNullable<CIWorkflow["jobs"]>[string] & {
      name?: string;
      needs?: string[];
      strategy?: unknown;
      defaults?: unknown;
      steps?: Array<CIStep & { shell?: unknown }>;
    }
  >;
};

function ciRunSteps(workflow: CIWorkflow, jobId = "checks"): CIRunStep[] {
  const steps = workflow.jobs?.[jobId]?.steps ?? [];
  const out: CIRunStep[] = [];
  steps.forEach((step, index) => {
    if (typeof step.run !== "string" || step.run.trim() === "") return;
    out.push({ index, name: typeof step.name === "string" ? step.name : "", run: step.run, step });
  });
  return out;
}

function stepLabel(step: CIRunStep): string {
  return step.name === "" ? `#${step.index} (unnamed)` : `"${step.name}"`;
}

/** Structured ways a required step could be skipped or its failure swallowed. */
function unconditionalDefects(step: CIRunStep): string[] {
  const defects: string[] = [];
  if (step.name === "") defects.push(`step ${stepLabel(step)} has no name`);
  if (step.step.if !== undefined) {
    defects.push(
      `step ${stepLabel(step)} is gated by if: ${String(step.step.if)} and could be skipped`,
    );
  }
  if (step.step["continue-on-error"] !== undefined) {
    defects.push(
      `step ${stepLabel(step)} sets continue-on-error: ${String(step.step["continue-on-error"])}`,
    );
  }
  if (/\bset\s+\+e\b/.test(step.run)) {
    defects.push(`step ${stepLabel(step)} disables errexit with set +e`);
  }
  for (const command of shellCommands(step.run)) {
    if (/^(true|:|exit 0|\/bin\/true)$/.test(command)) {
      defects.push(`step ${stepLabel(step)} swallows a nonzero exit: command "${command}"`);
    }
  }
  return defects;
}

/** Every step that executes `docker run ... <argv>` (argv must sit on one command). */
function inImageSteps(workflow: CIWorkflow, argv: string): CIRunStep[] {
  return ciRunSteps(workflow).filter((step) =>
    shellCommands(step.run).some(
      (command) => command.startsWith("docker run ") && command.includes(argv),
    ),
  );
}

/** Every `docker build` that targets the WAL-G image. The application image has its own step. */
function buildCommands(workflow: CIWorkflow): BuildRef[] {
  return ciRunSteps(workflow).flatMap((step) =>
    shellCommands(step.run)
      .filter((command) => isWalgBuild(command))
      .map((command) => ({ step, command, tag: IMAGE_BUILD.exec(command)?.[1] })),
  );
}

function isWalgBuild(command: string): boolean {
  return command.startsWith("docker build ") && /\bops\/postgres\b|Dockerfile\.walg/.test(command);
}

/**
 * Joins backslash-continued lines into one command, so a publication spread over several lines
 * is matched whole. Comment lines go first: a backslash at the end of a comment continues nothing.
 */
function joinContinuedLines(script: string): string {
  return script
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .replace(/[ \t]*\\\n[ \t]*/g, " ");
}

/**
 * The publication forms this guard recognises: a registry push (docker, podman, buildah, crane,
 * oras, skopeo), a manifest or tag publication (`docker manifest push`, `buildx imagetools
 * create`), a compose build or push that pushes (`docker compose build --push`, `docker compose
 * push`, and the same with compose global options such as `-f` or `--profile` before the
 * subcommand), a buildx build or bake that pushes (`--push`, or an output to the registry), and a
 * build-push action. A publishing tool outside this list needs its own pattern.
 */
const IMAGE_PUBLISH =
  /\bdocker\s+(push|image\s+push|manifest\s+push)\b|\bdocker\s+buildx\s+imagetools\s+create\b|\bbuildx\s+(build|bake)\b.*(\s--push(=\S+)?(\s|$)|(--output|\s-o)[= ]?\S*(type=registry|push=true))|\bcompose\b(?:\s+(?:-[fp]|--(?:file|project-name|profile|env-file|project-directory|ansi|parallel|progress))(?:=|\s+)\S+|\s+--(?!(?:file|project-name|profile|env-file|project-directory|ansi|parallel|progress)(?:=|\s))\S+)*\s+(?:build\b.*\s--push(\s|$)|push\b)|\b(crane|oras)\s+(push|copy|tag)\b|\bskopeo\s+copy\b|\b(podman|buildah)\s+((image|manifest)\s+)?push\b/;

/**
 * Every image publication in the workflow that IMAGE_PUBLISH recognises, in any job, plus every
 * build-push action. Scanning every job means a publication added to a new job fails the same
 * check as one added to `ci`.
 */
function imagePublicationSites(workflow: CIWorkflow): string[] {
  const sites: string[] = [];
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.uses === "string" && step.uses.startsWith("docker/build-push-action")) {
        sites.push(`${jobId}: uses ${step.uses}`);
      }
      if (typeof step.run !== "string") continue;
      for (const command of shellCommands(joinContinuedLines(step.run))) {
        if (IMAGE_PUBLISH.test(command)) sites.push(`${jobId}: ${command}`);
      }
    }
  }
  return sites;
}

/** The publication sites of one run block, as a single-step `ci` job. */
function publicationsIn(run: string): string[] {
  return imagePublicationSites({ jobs: { ci: { steps: [{ name: "Fixture", run }] } } });
}

/**
 * Every wiring problem in a workflow text. Pure over the text so the negative
 * controls below run the SAME assertions over a mutated fixture.
 */
function ciWiringProblems(text: string): string[] {
  const problems: string[] = [];
  let workflow: ParallelWorkflow;
  try {
    workflow = parseWorkflow(text);
  } catch (error) {
    return [`workflow is not valid YAML: ${String(error)}`];
  }

  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read" })) {
    problems.push(
      `permissions must stay exactly { contents: read }; got ${JSON.stringify(workflow.permissions)}`,
    );
  }
  if (
    JSON.stringify(workflow.on) !==
    JSON.stringify({ push: { branches: ["main"] }, pull_request: null })
  ) {
    problems.push(
      `on: must stay push:main-only + pull_request; got ${JSON.stringify(workflow.on)}`,
    );
  }
  for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
    if (job.permissions !== undefined)
      problems.push(`job "${id}" declares its own permissions block`);
    if (id === "ci" ? job.if !== "always()" : job.if !== undefined) {
      if (id === "ci") problems.push('job "ci" must use if: always()');
      else problems.push(`job "${id}" is gated by if: ${String(job.if)} and could be skipped`);
    }
    if (job["continue-on-error"] !== undefined) {
      problems.push(`job "${id}" sets continue-on-error: ${String(job["continue-on-error"])}`);
    }
  }

  problems.push(...aggregateProblems(workflow));
  if (
    JSON.stringify(workflow.jobs?.e2e?.strategy) !==
    JSON.stringify({ "fail-fast": false, matrix: { shard: [1, 2] } })
  ) {
    problems.push('job "e2e" must run exactly shards 1 and 2 without fail-fast');
  }
  const steps = ciRunSteps(workflow);

  // (1) The image build. `docker build` has no `--platform` default, so the
  // exact command is pinned: linux/amd64 is the release target.
  const builds = buildCommands(workflow);
  if (builds.length !== 1) {
    problems.push(
      `expected exactly one executable step running the pinned image build ("docker build --platform linux/amd64 -f ops/postgres/Dockerfile.walg -t <tag> ops/postgres"), found ${builds.length}`,
    );
  }
  const build = builds[0];
  let buildTag: string | undefined;
  if (build !== undefined) {
    buildTag = build.tag;
    problems.push(...unconditionalDefects(build.step));
    if (build.tag === undefined) {
      problems.push(
        `image build command is not the pinned form "docker build --platform linux/amd64 -f ops/postgres/Dockerfile.walg -t <tag> ops/postgres"; got: ${build.command}`,
      );
    }
  }

  // (2)+(3) The two in-image runs, on identical terms and the same image tag.
  const checkInImage = (argv: string): void => {
    const owners = inImageSteps(workflow, argv);
    if (owners.length === 0) {
      problems.push(
        `no executable workflow step runs \`${argv}\` inside the built image (a comment or an unexecuted text mention does not satisfy this)`,
      );
      return;
    }
    if (owners.length > 1) {
      problems.push(`${owners.length} steps run \`${argv}\` in-image; expected exactly one`);
    }
    const owner = owners[0];
    if (owner === undefined) return;
    if (build !== undefined && owner.index < build.step.index) {
      problems.push(`step ${stepLabel(owner)} must run after the WAL-G image build`);
    }
    problems.push(...unconditionalDefects(owner));
    const commands = shellCommands(owner.run).filter((command) => command.includes(argv));
    for (const command of commands) {
      const expected = `${DOCKER_RUN_PREFIX}${buildTag ?? "<same image tag as the build>"} ${argv}`;
      if (buildTag === undefined || command !== expected) {
        problems.push(
          `in-image \`${argv}\` invocation must be "docker run --rm --network none -v \\"$PWD/ops/postgres:/ops:ro\\" <same image tag as the build> ${argv}"; got: ${command}`,
        );
      }
      const runTag = RUN_TAG.exec(command)?.[1];
      if (buildTag !== undefined && runTag !== buildTag) {
        problems.push(
          `image tag mismatch for \`${argv}\`: build "${buildTag}", run "${runTag ?? "unparsed"}"`,
        );
      }
    }
  };
  checkInImage(RESTORE_ARGV);
  checkInImage(SELECTOR_ARGV);

  // (4) Every pre-existing check survives, including the RUNNER-level selector
  // suite, which tests host Python rather than the image's own Python.
  const browserSteps = ciRunSteps(workflow, "e2e");
  const browserGates = browserSteps.filter((step) => step.run.startsWith("pnpm test:e2e"));
  if (browserGates.length !== 1) problems.push('job "e2e" must run exactly one browser gate');
  for (const gate of browserGates) problems.push(...unconditionalDefects(gate));
  const runLines = [...steps, ...browserSteps].flatMap((step) =>
    step.run.split(/\r?\n/).map((line) => line.trim()),
  );
  const required: Array<[string, RegExp]> = [
    ["pnpm install --frozen-lockfile", /^pnpm install --frozen-lockfile$/],
    ["bash scripts/guards.sh", /^bash scripts\/guards\.sh$/],
    ["bash scripts/guards.sh --self-test", /^bash scripts\/guards\.sh --self-test$/],
    [
      RUNNER_SELECTOR_ARGV,
      /^python3 -m unittest discover -s ops\/postgres -p test_select_backup\.py$/,
    ],
    ["pnpm db:generate", /^pnpm db:generate$/],
    ["pnpm db:deploy", /^pnpm db:deploy$/],
    ["pnpm typecheck", /^pnpm typecheck$/],
    ["pnpm lint", /^pnpm lint$/],
    ["pnpm test", /^pnpm test$/],
    ["pnpm build", /^pnpm build$/],
    ["pnpm db:seed (E2E migrate-and-seed)", /^pnpm db:seed$/],
    [
      "pnpm test:e2e (browser gate)",
      /^pnpm test:e2e --shard=\$\{\{ matrix.shard \}\}\/2 --retries=\$\{\{ github.event_name == 'push' && github.ref == 'refs\/heads\/main' && 1 \|\| 0 \}\}$/,
    ],
  ];
  for (const [label, pattern] of required) {
    if (!runLines.some((line) => pattern.test(line))) {
      problems.push(`pre-existing CI check is missing: ${label}`);
    }
  }
  if (!browserSteps.some((step) => step.run.includes("CREATE DATABASE"))) {
    problems.push("pre-existing CI check is missing: the isolated E2E database creation");
  }
  const runnerSelector = steps.filter((step) =>
    shellCommands(step.run).includes(RUNNER_SELECTOR_ARGV),
  );
  if (runnerSelector.length !== 1) {
    problems.push(
      `expected exactly one runner-level selector step, found ${runnerSelector.length}`,
    );
  } else if (runnerSelector.some((step) => step.run.includes("docker run"))) {
    problems.push(
      "the runner-level selector suite must stay on the runner, not only inside the image",
    );
  }

  // (4b) The application image and the two production gates built on it: the
  // database-invariant check (with a negative control) and the image smoke test.
  const appBuilds = steps.flatMap((step) =>
    shellCommands(step.run)
      .filter((command) => command.startsWith("docker build ") && !isWalgBuild(command))
      .map((command) => ({ step, tag: APP_BUILD.exec(command)?.[1] })),
  );
  const appBuild = appBuilds[0];
  if (appBuilds.length !== 1 || appBuild?.tag === undefined) {
    problems.push(
      `expected exactly one executable step running the pinned application image build ("docker build --platform linux/amd64 -t <tag> ."), found ${appBuilds.length}`,
    );
  } else {
    problems.push(...unconditionalDefects(appBuild.step));
  }
  const deployStep = steps.find((step) => shellCommands(step.run).includes(DB_DEPLOY_COMMAND));
  const namedStep = (name: string): CIRunStep | undefined => {
    const found = steps.filter((step) => step.name === name);
    if (found.length !== 1) {
      problems.push(`expected exactly one executable step named "${name}", found ${found.length}`);
    }
    return found[0];
  };
  const requireAfter = (step: CIRunStep, anchor: CIRunStep | undefined, label: string): void => {
    if (anchor !== undefined && step.index < anchor.index) {
      problems.push(`step ${stepLabel(step)} must run after ${label}`);
    }
  };
  const requireContent = (step: CIRunStep, checks: Array<[string, boolean]>): void => {
    for (const [what, present] of checks) {
      if (!present) problems.push(`step ${stepLabel(step)} lacks ${what}`);
    }
  };

  const invariants = namedStep(INVARIANTS_STEP);
  if (invariants !== undefined) {
    problems.push(...unconditionalDefects(invariants));
    requireAfter(invariants, deployStep, DB_DEPLOY_COMMAND);
    requireContent(invariants, [
      [
        `the command \`${INVARIANTS_COMMAND}\``,
        shellCommands(invariants.run).includes(INVARIANTS_COMMAND),
      ],
    ]);
    // A `||`, `;` or pipe after the command (`|| echo skipped`) turns its failure into success
    // without matching a swallowed-exit pattern, so the command must stand alone on its line.
    if (shellCommands(invariants.run).includes(INVARIANTS_COMMAND)) {
      requireContent(invariants, [
        [
          `the command \`${INVARIANTS_COMMAND}\` alone on its line, with nothing after it that could mask a failure`,
          joinContinuedLines(invariants.run)
            .split("\n")
            .some((line) => line.trim() === INVARIANTS_COMMAND),
        ],
      ]);
    }
  }

  // The negative control is only meaningful if the broken script is the real one
  // with a checked constraint dropped, the job fails when that script passes, and
  // the only accepted failure is the script's own marker.
  const control = namedStep(INVARIANTS_NEGATIVE_STEP);
  if (control !== undefined) {
    problems.push(...unconditionalDefects(control));
    requireAfter(control, deployStep, DB_DEPLOY_COMMAND);
    const script = joinContinuedLines(control.run);
    const commands = shellCommands(control.run);
    const dropConstraint =
      "echo 'ALTER TABLE \"EventRoomBooking\" DROP CONSTRAINT event_room_no_overlap;'";
    const sequence = [
      "echo 'BEGIN;'",
      dropConstraint,
      `cat ${INVARIANTS_FILE}`,
      "echo 'ROLLBACK;'",
    ].map((part) => script.indexOf(part));
    requireContent(control, [
      ["the transaction opened with BEGIN", script.includes("echo 'BEGIN;'")],
      ["the dropped EXCLUDE constraint", script.includes(dropConstraint)],
      ["the real invariant script appended", script.includes(`cat ${INVARIANTS_FILE}`)],
      ["the trailing ROLLBACK", script.includes("echo 'ROLLBACK;'")],
      [
        "the order BEGIN, drop, real script, ROLLBACK",
        sequence.includes(-1) || sequence.every((p, i) => p > (sequence[i - 1] ?? -1)),
      ],
      [
        "the failure of the job when the broken script passes",
        /if output=\$\(pnpm exec prisma db execute --file "\$RUNNER_TEMP\/invariants-negative\.sql" 2>&1\); then\n\s*echo "::error::[^\n]*"\n\s*exit 1\n\s*fi\n/.test(
          script,
        ),
      ],
      [
        "the 'invariant check FAILED' marker check that fails the job",
        /grep -q 'invariant check FAILED' <<<"\$output" \|\| \{[^}\n]*exit 1; \}/.test(script),
      ],
      [
        "the final re-run of the real check, which proves the rollback",
        commands[commands.length - 1] === INVARIANTS_COMMAND,
      ],
    ]);
  }

  // The smoke step's cleanup() tolerates a failed log dump and an already-removed container with
  // `|| true` on those two lines only. Everything else in it is scanned like the rest of the step:
  // an `exit 0` or `return` in an EXIT trap replaces the status of the probe that failed.
  const smoke = namedStep(SMOKE_STEP);
  if (smoke !== undefined) {
    const cleanupFunction = /^cleanup\(\) \{\n[\s\S]*?\n\}$/m;
    // Comment lines are dropped first, so a commented-out `docker rm -f` is not a cleanup.
    const live = smoke.run
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    const cleanup = cleanupFunction.exec(live)?.[0] ?? "";
    const tolerated = cleanup
      .split("\n")
      .map((line) =>
        SMOKE_CLEANUP_TOLERATED.includes(line.trim()) ? line.replace(/ \|\| true$/, "") : line,
      )
      .join("\n");
    problems.push(
      ...unconditionalDefects({
        ...smoke,
        run: cleanup === "" ? live : live.replace(cleanup, () => tolerated),
      }),
    );
    for (const command of shellCommands(cleanup)) {
      if (/^(exit|return)\b/.test(command)) {
        problems.push(
          `step ${stepLabel(smoke)} cleanup() uses "${command}", which replaces the exit status of the failed step`,
        );
      }
    }
    const database = ((): string | undefined => {
      const url = smoke.step.env?.SMOKE_DATABASE_URL;
      try {
        return typeof url === "string" ? new URL(url).pathname.slice(1) : undefined;
      } catch {
        return undefined;
      }
    })();
    requireContent(smoke, [
      [
        `SMOKE_DATABASE_URL pointing at the database ${SMOKE_DATABASE}`,
        database === SMOKE_DATABASE,
      ],
    ]);
    requireAfter(smoke, appBuild?.step, "the application image build");
    const script = joinContinuedLines(smoke.run);
    const lines = script.split("\n");
    const tag = appBuild?.tag;
    if (tag !== undefined) {
      const migrate = lines.find(
        (line) => line.startsWith("docker run --rm ") && line.includes(" sh -c "),
      );
      const start = lines.find((line) => line.startsWith("docker run -d --name jiangtang-smoke "));
      const healthzLine = lines.find((line) => /\bcurl\b.*:3000\/healthz/.test(line));
      const loginLine = lines.find((line) => /\bcurl\b.*:3000\/login/.test(line));
      const order = [
        migrate === undefined ? -1 : script.indexOf(migrate),
        start === undefined ? -1 : script.indexOf(start),
        healthzLine === undefined ? -1 : script.indexOf(healthzLine),
        loginLine === undefined ? -1 : script.indexOf(loginLine),
      ];
      // A probe must not wait forever on a server that accepts the connection and never answers.
      const timeouts = (line: string): boolean =>
        /--connect-timeout [1-9]\d*(\s|$)/.test(line) && /--max-time [1-9]\d*(\s|$)/.test(line);
      // Isolation: each container shares the host network and uses only the job's own database.
      const isolated = (what: string, line: string | undefined): Array<[string, boolean]> =>
        line === undefined
          ? []
          : [
              [`--network host on ${what}`, / --network host /.test(line)],
              [
                `-e DATABASE_URL="$SMOKE_DATABASE_URL" on ${what}`,
                line.includes(' -e DATABASE_URL="$SMOKE_DATABASE_URL" '),
              ],
            ];
      requireContent(smoke, [
        [
          "the migrate job: `docker run --rm` of the application image with /ops mounted read-only",
          migrate !== undefined && migrate.includes(`${IMAGE_MOUNT} ${tag} sh -c `),
        ],
        [
          "`prisma migrate deploy` followed by the invariant check in the migrate job",
          migrate !== undefined &&
            /sh -c "\.\/node_modules\/\.bin\/prisma migrate deploy && \.\/node_modules\/\.bin\/prisma db execute --file \/ops\/verify-invariants\.sql"/.test(
              migrate,
            ),
        ],
        ...(migrate === undefined
          ? []
          : ([
              [
                "the migrate job as the end of its command, with nothing after it that could mask a failure",
                /sh -c "[^"]*"$/.test(migrate),
              ],
            ] as Array<[string, boolean]>)),
        ...isolated("the migrate job", migrate),
        [
          "the detached application container started in production mode from the application image",
          start !== undefined &&
            start.includes(" -e NODE_ENV=production ") &&
            start.endsWith(` ${tag}`),
        ],
        ...isolated("the application container", start),
        ...(start === undefined
          ? []
          : SMOKE_BLANK_VARIABLES.map((name): [string, boolean] => [
              `${name}= set blank on the application container`,
              new RegExp(`(^| )-e ${name}=( |$)`).test(start),
            ])),
        ["the /healthz probe", healthzLine !== undefined],
        ...(healthzLine === undefined
          ? []
          : ([
              [
                "a /healthz probe that is ready only on exactly HTTP 200",
                /^\s*if \[ "\$\(curl [^)]*-w '%\{http_code\}'[^)]* http:\/\/127\.0\.0\.1:3000\/healthz[^)]*\)" = 200 \]; then$/.test(
                  healthzLine,
                ),
              ],
              ["--connect-timeout and --max-time on the /healthz probe", timeouts(healthzLine)],
            ] as Array<[string, boolean]>)),
        [
          "the failure of the job when /healthz never answers",
          /\[ "\$\{ready:-\}" = 1 \] \|\| \{[^}\n]*exit 1; \}/.test(script),
        ],
        ["the /login probe", loginLine !== undefined],
        ...(loginLine === undefined
          ? []
          : ([
              ["--connect-timeout and --max-time on the /login probe", timeouts(loginLine)],
              [
                "a /login probe whose transport failure reaches the guard as code=000",
                /^code="\$\(curl [^)]*\)" \|\| code=000$/.test(loginLine.trim()),
              ],
              [
                "the HTTP status of the /login probe captured with -w '%{http_code}'",
                loginLine.includes("-w '%{http_code}'"),
              ],
            ] as Array<[string, boolean]>)),
        [
          "the failure of the job when /login does not return 200",
          /\[ "\$code" = 200 \] \|\| \{[^}\n]*exit 1; \}/.test(script),
        ],
        [
          "the order: migrate job, application start, /healthz, /login",
          order.every((position, index) => position !== -1 && position > (order[index - 1] ?? -1)),
        ],
        [
          "the EXIT trap that removes the container",
          /^trap cleanup EXIT$/m.test(script) &&
            shellCommands(cleanup).some((command) =>
              command.startsWith("docker rm -f jiangtang-smoke"),
            ),
        ],
      ]);
    }
  }

  // (5) Least privilege, no secrets, no publication of any artifact type.
  const stepDefs = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  const uses = stepDefs.map((step) => step.uses ?? "");
  if (!uses.some((ref) => /^actions\/upload-artifact@v\d+$/.test(ref))) {
    problems.push("pre-existing CI check is missing: the Playwright failure-diagnostics upload");
  }
  const executableText = [...stepDefs.map((step) => step.run ?? ""), ...uses].join("\n");
  const publishing: Array<[string, RegExp]> = [
    ["docker push", /^[ \t]*docker[ \t]+push\b/m],
    ["docker login", /^[ \t]*docker[ \t]+login\b/m],
    ["docker tag", /^[ \t]*docker[ \t]+tag\b/m],
    ["docker/build-push-action", /docker\/build-push-action/],
    ["npm or pnpm publish", /^[ \t]*(npm|pnpm)[ \t]+publish\b/m],
    ["gh release", /^[ \t]*gh[ \t]+release\b/m],
    ["upload-pages-artifact", /upload-pages-artifact/],
    ["gh-action-pypi-publish", /gh-action-pypi-publish/],
    ["softprops/action-gh-release", /softprops\/action-gh-release/],
  ];
  for (const [label, pattern] of publishing) {
    if (pattern.test(executableText)) problems.push(`workflow publishes an artifact: ${label}`);
  }
  problems.push(
    ...imagePublicationSites(workflow).map((site) => `workflow publishes an image: ${site}`),
  );
  if (/\$\{\{\s*secrets\./.test(text)) problems.push("workflow references repository secrets");

  return problems;
}

function aggregateProblems(workflow: ParallelWorkflow): string[] {
  const aggregate = workflow.jobs?.ci;
  const dependencies = Object.keys(workflow.jobs ?? {})
    .filter((id) => id !== "ci")
    .sort();
  if (aggregate?.name !== "ci" || dependencies.some((id) => workflow.jobs?.[id]?.name === "ci")) {
    return ['only the aggregate job may be named "ci"'];
  }
  if (
    !aggregate ||
    JSON.stringify([...(aggregate.needs ?? [])].sort()) !== JSON.stringify(dependencies)
  ) {
    return ['job "ci" must need every other job exactly once'];
  }
  const steps = aggregate.steps ?? [];
  const step = steps[0];
  if (
    steps.length !== 1 ||
    !step?.run ||
    step.uses ||
    step.if !== undefined ||
    step["continue-on-error"] !== undefined
  ) {
    return ['job "ci" must have one unconditional aggregate run step'];
  }
  const results = ["success", "failure", "cancelled", "skipped"];
  if (
    workflow.defaults !== undefined ||
    aggregate.defaults !== undefined ||
    (step.shell !== undefined && step.shell !== "bash") ||
    /GITHUB_|github\./.test(step.run)
  ) {
    return ['job "ci" must use the standard bash shell and only bound result inputs'];
  }
  const combinations = dependencies.reduce<string[][]>(
    (rows) => rows.flatMap((row) => results.map((result) => [...row, result])),
    [[]],
  );
  for (const combination of combinations) {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    for (const [key, value] of Object.entries(step.env ?? {})) {
      const dependency = /^\$\{\{ needs\.([\w-]+)\.result \}\}$/.exec(String(value))?.[1];
      if (!dependency || !dependencies.includes(dependency))
        return ['job "ci" has an invalid result binding'];
      env[key] = combination[dependencies.indexOf(dependency)] as string;
    }
    const result = spawnSync(
      resolveHostBash(),
      [
        "--noprofile",
        "--norc",
        "-e",
        ...(step.shell === "bash" ? ["-o", "pipefail"] : []),
        "-c",
        step.run,
      ],
      {
        env,
        timeout: 1_000,
      },
    );
    if ((result.status === 0) !== combination.every((value) => value === "success")) {
      return [`job "ci" accepts the wrong result for ${combination.join("/")}`];
    }
  }
  return [];
}

/** Text fixture helpers. Each throws if its anchor is absent, so a no-op mutation cannot pass. */
function withoutLine(text: string, needle: string): string {
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => !line.includes(needle));
  if (kept.length !== lines.length - 1) {
    throw new Error(`fixture anchor must appear on exactly one line: ${needle}`);
  }
  return kept.join("\n");
}

function withLineSuffix(text: string, needle: string, suffix: string): string {
  const lines = text.split(/\r?\n/);
  let hits = 0;
  const out = lines.map((line) => {
    if (!line.includes(needle)) return line;
    hits += 1;
    return `${line} ${suffix}`;
  });
  if (hits !== 1) throw new Error(`fixture anchor must appear once, found ${hits}: ${needle}`);
  return out.join("\n");
}

function withCommentedLine(text: string, needle: string): string {
  const lines = text.split(/\r?\n/);
  let hits = 0;
  const out = lines.map((line) => {
    if (!line.includes(needle)) return line;
    hits += 1;
    return `# ${line}`;
  });
  if (hits !== 1) throw new Error(`fixture anchor must appear once, found ${hits}: ${needle}`);
  return out.join("\n");
}

function withJobKey(text: string, jobId: string, key: string): string {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((line) => line === `  ${jobId}:`);
  if (header === -1) throw new Error(`fixture anchor job not found: ${jobId}`);
  lines.splice(header + 1, 0, `    ${key}`);
  return lines.join("\n");
}

function withStepKey(text: string, stepName: string, key: string): string {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (header === -1) throw new Error(`fixture anchor step not found: ${stepName}`);
  lines.splice(header + 1, 0, `        ${key}`);
  return lines.join("\n");
}

/** One step's line range, from its header (`- name: X` or `- run: X`) up to the next step or comment. */
function stepRange(lines: string[], header: string): [number, number] {
  const starts = lines.flatMap((line, index) =>
    line.trim() === header && /^ {6}- /.test(line) ? [index] : [],
  );
  if (starts.length !== 1) {
    throw new Error(`fixture anchor step must appear once, found ${starts.length}: ${header}`);
  }
  const start = starts[0] as number;
  const next = lines.findIndex((line, index) => index > start && /^ {6}(- |#)/.test(line));
  return [start, next === -1 ? lines.length : next];
}

function withoutStep(text: string, stepName: string): string {
  const lines = text.split(/\r?\n/);
  const [start, end] = stepRange(lines, `- name: ${stepName}`);
  lines.splice(start, end - start);
  return lines.join("\n");
}

function withStepDuplicated(text: string, stepName: string): string {
  const lines = text.split(/\r?\n/);
  const [start, end] = stepRange(lines, `- name: ${stepName}`);
  lines.splice(end, 0, ...lines.slice(start, end));
  return lines.join("\n");
}

function withStepMovedBefore(text: string, stepName: string, anchorHeader: string): string {
  const lines = text.split(/\r?\n/);
  const [start, end] = stepRange(lines, `- name: ${stepName}`);
  const block = lines.splice(start, end - start);
  const [anchor] = stepRange(lines, anchorHeader);
  lines.splice(anchor, 0, ...block);
  return lines.join("\n");
}

function withReplacedOnce(text: string, from: string, to: string): string {
  const parts = text.split(from);
  if (parts.length !== 2) {
    throw new Error(`fixture anchor must appear once, found ${parts.length - 1}: ${from}`);
  }
  return parts.join(to);
}

describe("CI: in-image restore guards are wired", () => {
  it("rejects build-push actions outright in every job", async () => {
    const workflow = parseWorkflow(await readFile(CI_WORKFLOW_PATH, "utf8"));
    for (const job of Object.values(workflow.jobs ?? {})) {
      job.steps = [...(job.steps ?? []), { uses: "docker/build-push-action@v7" }];
    }
    expect(imagePublicationSites(workflow)).toHaveLength(Object.keys(workflow.jobs ?? {}).length);
  });

  for (const matrix of ["[1]", "[1, 3]", "[1, 2, 3]"]) {
    it(`rejects an incomplete or unexpected browser shard matrix: ${matrix}`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      expect(
        ciWiringProblems(withReplacedOnce(live, "shard: [1, 2]", `shard: ${matrix}`)),
      ).toContain('job "e2e" must run exactly shards 1 and 2 without fail-fast');
    });
  }

  for (const alteration of ["exclude: [{ shard: 1 }]", "include: [{ shard: 3 }]"]) {
    it(`rejects browser matrix filtering: ${alteration}`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      expect(
        ciWiringProblems(
          withReplacedOnce(live, "shard: [1, 2]", `shard: [1, 2]\n        ${alteration}`),
        ),
      ).toContain('job "e2e" must run exactly shards 1 and 2 without fail-fast');
    });
  }

  for (const shell of ['"true {0}"', '"bash {0}"', "sh"]) {
    it(`rejects aggregate shell semantics that differ from the simulation: ${shell}`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      expect(ciWiringProblems(withReplacedOnce(live, "shell: bash", `shell: ${shell}`))).toContain(
        'job "ci" must use the standard bash shell and only bound result inputs',
      );
    });
  }

  it("rejects aggregate behavior that depends on the GitHub event", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      'echo "checks=$CHECKS_RESULT, e2e=$E2E_RESULT"',
      '[ "$GITHUB_EVENT_NAME" = push ] && exit 0',
    );
    expect(ciWiringProblems(fixture)).toContain(
      'job "ci" must use the standard bash shell and only bound result inputs',
    );
  });

  it("rejects workflow and aggregate shell defaults", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    for (const fixture of [
      withReplacedOnce(live, "jobs:\n", 'defaults: { run: { shell: "true {0}" } }\njobs:\n'),
      withJobKey(live, "ci", 'defaults: { run: { shell: "true {0}" } }'),
    ]) {
      expect(ciWiringProblems(fixture)).toContain(
        'job "ci" must use the standard bash shell and only bound result inputs',
      );
    }
  });

  for (const key of ["if: false", "continue-on-error: true"]) {
    it(`rejects ${key} on the browser gate`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      expect(
        ciWiringProblems(withStepKey(live, "E2E browser gate (loopback :3100)", key)).length,
      ).toBeGreaterThan(0);
    });
  }

  it("executes the aggregate shell against all 16 needed result combinations", async () => {
    expect(aggregateProblems(parseWorkflow(await readFile(CI_WORKFLOW_PATH, "utf8")))).toEqual([]);
  });

  it("rejects an aggregate that leaves a job out of needs", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    expect(
      ciWiringProblems(withReplacedOnce(live, "needs: [checks, e2e]", "needs: [checks]")),
    ).toContain('job "ci" must need every other job exactly once');
  });

  it("rejects an aggregate that tolerates a skipped shard result", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      '"$E2E_RESULT" == success ]]',
      '( "$E2E_RESULT" == success || "$E2E_RESULT" == skipped ) ]]',
    );
    expect(ciWiringProblems(fixture)).toContain(
      'job "ci" accepts the wrong result for success/skipped',
    );
  });

  for (const condition of [undefined, "success()", "failure()"]) {
    it(`rejects the aggregate without its exact always() condition: ${String(condition)}`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      const fixture =
        condition === undefined
          ? withoutLine(live, "if: always()")
          : withReplacedOnce(live, "if: always()", `if: ${condition}`);
      expect(ciWiringProblems(fixture)).toContain('job "ci" must use if: always()');
    });
  }

  for (const job of ["checks", "e2e"]) {
    it(`rejects a job-level if on ${job}`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      expect(ciWiringProblems(withJobKey(live, job, "if: false"))).toContain(
        `job "${job}" is gated by if: false and could be skipped`,
      );
    });

    it(`rejects job-level continue-on-error on ${job}`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      expect(ciWiringProblems(withJobKey(live, job, "continue-on-error: true"))).toContain(
        `job "${job}" sets continue-on-error: true`,
      );
    });
  }

  for (const name of ["Build the WALG PostgreSQL image", APP_BUILD_STEP]) {
    it(`rejects a duplicated ${name}`, async () => {
      expect(
        ciWiringProblems(withStepDuplicated(await readFile(CI_WORKFLOW_PATH, "utf8"), name)).length,
      ).toBeGreaterThan(0);
    });

    for (const key of ["if: false", "continue-on-error: true"]) {
      it(`rejects ${key} on ${name}`, async () => {
        expect(
          ciWiringProblems(withStepKey(await readFile(CI_WORKFLOW_PATH, "utf8"), name, key)).length,
        ).toBeGreaterThan(0);
      });
    }
  }

  it("rejects restore guards ordered before their image build", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    expect(
      ciWiringProblems(
        withStepMovedBefore(
          live,
          "In-image restore guard suite",
          "- name: Build the WALG PostgreSQL image",
        ),
      ),
    ).toContain('step "In-image restore guard suite" must run after the WAL-G image build');
  });

  it("rejects an application smoke test ordered before its image build", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    expect(
      ciWiringProblems(withStepMovedBefore(live, SMOKE_STEP, `- name: ${APP_BUILD_STEP}`)),
    ).toContain(`step "${SMOKE_STEP}" must run after the application image build`);
  });

  it("parses the workflow with zero wiring problems", async () => {
    const problems = ciWiringProblems(await readFile(CI_WORKFLOW_PATH, "utf8"));
    expect(problems).toEqual([]);
  });

  it("builds the pinned linux/amd64 WAL-G image in a named, unconditional step", async () => {
    const workflow = parseWorkflow(await readFile(CI_WORKFLOW_PATH, "utf8"));
    const builds = buildCommands(workflow);
    expect(builds).toHaveLength(1);
    const build = builds[0] as BuildRef;
    expect(build.tag).toBe("jiangtang-postgres-walg:ci");
    expect(build.command).toBe(
      "docker build --platform linux/amd64 -f ops/postgres/Dockerfile.walg -t jiangtang-postgres-walg:ci ops/postgres",
    );
    expect(build.step.name).not.toBe("");
    expect(build.step.step.if).toBeUndefined();
    expect(build.step.step["continue-on-error"]).toBeUndefined();
    expect(unconditionalDefects(build.step)).toEqual([]);
  });

  it("builds the application image once, in a named, unconditional step, and never pushes it", async () => {
    const workflow = parseWorkflow(await readFile(CI_WORKFLOW_PATH, "utf8"));
    const appBuilds = ciRunSteps(workflow).flatMap((step) =>
      shellCommands(step.run)
        .filter((command) => command.startsWith("docker build ") && !isWalgBuild(command))
        .map((command) => ({ step, command })),
    );
    expect(appBuilds.map((build) => build.command)).toEqual([
      "docker build --platform linux/amd64 -t jiangtang:ci .",
    ]);
    const app = appBuilds[0] as (typeof appBuilds)[number];
    expect(app.step.name).not.toBe("");
    expect(app.step.step.if).toBeUndefined();
    expect(app.step.step["continue-on-error"]).toBeUndefined();
    expect(unconditionalDefects(app.step)).toEqual([]);
    expect(imagePublicationSites(workflow)).toEqual([]);
  });

  it("runs the restore guards inside the built image, offline and read-only", async () => {
    const workflow = parseWorkflow(await readFile(CI_WORKFLOW_PATH, "utf8"));
    const buildTag = (buildCommands(workflow)[0] as BuildRef | undefined)?.tag;
    expect(buildTag).toBe("jiangtang-postgres-walg:ci");
    const owners = inImageSteps(workflow, RESTORE_ARGV);
    expect(owners).toHaveLength(1);
    const owner = owners[0] as CIRunStep;
    expect(owner.name).not.toBe("");
    expect(owner.step.if).toBeUndefined();
    expect(owner.step["continue-on-error"]).toBeUndefined();
    expect(unconditionalDefects(owner)).toEqual([]);
    const matches = shellCommands(owner.run).filter((command) => command.includes(RESTORE_ARGV));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(`${DOCKER_RUN_PREFIX}${buildTag} ${RESTORE_ARGV}`);
    expect(matches[0]).toContain("--rm");
    expect(matches[0]).toContain("--network none");
    expect(matches[0]).toContain(IMAGE_MOUNT);
  });

  it("runs the selector discovery inside the same image on the same terms", async () => {
    const workflow = parseWorkflow(await readFile(CI_WORKFLOW_PATH, "utf8"));
    const buildTag = (buildCommands(workflow)[0] as BuildRef | undefined)?.tag;
    expect(buildTag).toBe("jiangtang-postgres-walg:ci");
    const owners = inImageSteps(workflow, SELECTOR_ARGV);
    expect(owners).toHaveLength(1);
    const owner = owners[0] as CIRunStep;
    expect(owner.name).not.toBe("");
    expect(owner.step.if).toBeUndefined();
    expect(owner.step["continue-on-error"]).toBeUndefined();
    expect(unconditionalDefects(owner)).toEqual([]);
    const matches = shellCommands(owner.run).filter((command) => command.includes(SELECTOR_ARGV));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(`${DOCKER_RUN_PREFIX}${buildTag} ${SELECTOR_ARGV}`);
    expect(matches[0]).toContain("--rm");
    expect(matches[0]).toContain("--network none");
    expect(matches[0]).toContain(IMAGE_MOUNT);
  });

  it("keeps least privilege, the existing triggers and no publication", async () => {
    const text = await readFile(CI_WORKFLOW_PATH, "utf8");
    const workflow = parseWorkflow(text);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on).toEqual({ push: { branches: ["main"] }, pull_request: null });
    expect(text).not.toMatch(/\$\{\{\s*secrets\./);
    expect(text).not.toMatch(/^[ \t]*docker[ \t]+(push|login|tag)\b/m);
    expect(text).not.toMatch(/(npm|pnpm)[ \t]+publish\b/);
  });

  it("keeps every pre-existing runner check alongside the in-image runs", async () => {
    const workflow = parseWorkflow(await readFile(CI_WORKFLOW_PATH, "utf8"));
    const lines = [...ciRunSteps(workflow), ...ciRunSteps(workflow, "e2e")].flatMap((step) =>
      shellCommands(step.run),
    );
    for (const command of [
      "pnpm install --frozen-lockfile",
      "bash scripts/guards.sh",
      "bash scripts/guards.sh --self-test",
      RUNNER_SELECTOR_ARGV,
      "pnpm db:generate",
      "pnpm db:deploy",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test",
      "pnpm build",
      "pnpm db:seed",
    ]) {
      expect(lines, command).toContain(command);
    }
    expect(ciRunSteps(workflow, "e2e").some((step) => step.run.includes("CREATE DATABASE"))).toBe(
      true,
    );
    expect(
      ciRunSteps(workflow, "e2e").find((step) => step.run.startsWith("pnpm test:e2e"))?.run,
    ).toBe(
      "pnpm test:e2e --shard=${{ matrix.shard }}/2 --retries=${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 1 || 0 }}",
    );
  });

  it("rejects a docker push added to the application build step", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withLineSuffix(
      live,
      "run: docker build --platform linux/amd64 -t jiangtang:ci .",
      "&& docker push jiangtang:ci",
    );
    expect(fixture).toContain("docker push jiangtang:ci");
    expect(imagePublicationSites(parseWorkflow(fixture))).toEqual([
      "checks: docker push jiangtang:ci",
    ]);
  });

  it("rejects an image publication in a job other than ci", async () => {
    const workflow = parseWorkflow(await readFile(CI_WORKFLOW_PATH, "utf8"));
    expect(imagePublicationSites(workflow)).toEqual([]);
    workflow.jobs = {
      ...workflow.jobs,
      publish: { steps: [{ name: "Publish", run: "docker push jiangtang:ci" }] },
    };
    expect(imagePublicationSites(workflow)).toEqual(["publish: docker push jiangtang:ci"]);
  });

  it("rejects a buildx build that pushes when its flags are backslash-continued", () => {
    expect(
      publicationsIn(
        "docker buildx build \\\n  --platform linux/amd64 \\\n  --push \\\n  -t jiangtang:ci .",
      ),
    ).toEqual(["ci: docker buildx build --platform linux/amd64 --push -t jiangtang:ci ."]);
    expect(
      publicationsIn(
        "docker buildx build \\\n  --platform linux/amd64 \\\n  --output type=registry \\\n  -t jiangtang:ci .",
      ),
    ).toEqual([
      "ci: docker buildx build --platform linux/amd64 --output type=registry -t jiangtang:ci .",
    ]);
  });

  it("rejects publications outside docker push, including compose, manifests, imagetools, bake and other tools", () => {
    for (const run of [
      "docker manifest push jiangtang:ci",
      "docker buildx imagetools create -t registry.example.org/jiangtang:ci jiangtang:ci",
      "docker buildx bake --push app",
      "docker buildx build --output type=image,name=registry.example.org/jiangtang,push=true .",
      "docker compose build --push",
      "docker compose build app --push",
      "docker-compose build --push app",
      "docker compose push app",
      "podman push jiangtang:ci",
      "podman image push jiangtang:ci",
      "podman manifest push jiangtang:ci",
      "buildah push jiangtang:ci",
      "buildah manifest push jiangtang:ci",
      "crane push image.tar registry.example.org/jiangtang:ci",
      "oras push registry.example.org/jiangtang:ci app.tar",
      "skopeo copy docker-archive:image.tar docker://registry.example.org/jiangtang:ci",
    ]) {
      expect(publicationsIn(run), run).toEqual([`ci: ${run}`]);
    }
  });

  it("rejects compose publications with global options before the subcommand", () => {
    for (const run of [
      "docker compose -f docker-compose.prod.yml build --push",
      "docker compose --profile x push app",
      "docker compose -p jt -f compose.yml push",
      "docker compose --project-name=jt --file=compose.yml build app --push",
      "docker compose --env-file .env.prod --project-directory ops build --push",
      "docker compose --progress plain build --push app",
      "docker-compose -f compose.yml push app",
    ]) {
      expect(publicationsIn(run), run).toEqual([`ci: ${run}`]);
    }
  });

  it("does not flag builds, pulls or runs that do not publish, in compose, podman or buildah", () => {
    for (const run of [
      "docker compose build app",
      "docker compose build",
      "docker compose build --no-cache app",
      "docker compose build app --progress=plain",
      "docker-compose build app",
      "docker compose up --build -d",
      "docker compose -f x.yml build app",
      "docker compose --profile p up -d",
      "docker compose --file push",
      "docker compose --project-name push",
      "docker compose --profile push",
      "docker compose --env-file push",
      "docker compose --project-directory push",
      "docker compose --ansi push",
      "docker compose --parallel push",
      "docker compose --progress push",
      "docker compose --project-name=jt --file=compose.yml build --no-cache app",
      "docker build -t x .",
      "podman build -t x .",
      "buildah bud -t x .",
      "buildah from alpine",
      "podman pull alpine",
      "podman images",
      "podman run --rm jiangtang:ci push",
    ]) {
      expect(publicationsIn(run), run).toEqual([]);
    }
  });

  it("does not flag a local build, and a comment's trailing backslash does not hide a push", () => {
    expect(publicationsIn("docker buildx build --output type=local,dest=out .")).toEqual([]);
    expect(
      publicationsIn("docker buildx build \\\n  --output type=local,dest=out \\\n  ."),
    ).toEqual([]);
    expect(publicationsIn("# keep the push disabled \\\ndocker push jiangtang:ci")).toEqual([
      "ci: docker push jiangtang:ci",
    ]);
  });

  // ── Negative controls. Each runs the SAME checker over a mutated copy of the
  // workflow. A control that passed here would mean the check cannot fail.
  it("rejects a workflow with the in-image restore invocation removed", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    expect(live).toContain(RESTORE_ARGV);
    const fixture = withoutLine(live, RESTORE_ARGV);
    expect(fixture).not.toContain(RESTORE_ARGV);
    // The fixture's complete problem list: exactly the missing-restore failure.
    expect(ciWiringProblems(fixture)).toEqual([
      `no executable workflow step runs \`${RESTORE_ARGV}\` inside the built image (a comment or an unexecuted text mention does not satisfy this)`,
    ]);
  });

  it("rejects a workflow where the restore invocation is made non-blocking with || true", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withLineSuffix(live, RESTORE_ARGV, "|| true");
    expect(fixture).toContain(`${RESTORE_ARGV} || true`);
    // The fixture's complete problem list: exactly the swallowed-exit failure.
    expect(ciWiringProblems(fixture)).toEqual([
      `step "In-image restore guard suite" swallows a nonzero exit: command "true"`,
    ]);
  });

  it("rejects continue-on-error on the in-image restore step", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withStepKey(live, "In-image restore guard suite", "continue-on-error: true");
    // The fixture's complete problem list: exactly the continue-on-error failure.
    expect(ciWiringProblems(fixture)).toEqual([
      `step "In-image restore guard suite" sets continue-on-error: true`,
    ]);
  });

  it("rejects continue-on-error on the whole job", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withJobKey(live, "ci", "continue-on-error: true");
    // The fixture's complete problem list: exactly the job-level failure.
    expect(ciWiringProblems(fixture)).toEqual(['job "ci" sets continue-on-error: true']);
  });

  it("does not accept a commented-out restore invocation", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withCommentedLine(live, RESTORE_ARGV);
    // The text is still there — a text search would pass — but it is not executable.
    expect(fixture).toContain(RESTORE_ARGV);
    expect(ciWiringProblems(fixture)).toEqual([
      `no executable workflow step runs \`${RESTORE_ARGV}\` inside the built image (a comment or an unexecuted text mention does not satisfy this)`,
    ]);
  });

  // ── The invariant check, its negative control and the image smoke test.
  const gated = "if: github.event_name == 'push'";
  const gatedMessage = (name: string): string =>
    `step "${name}" is gated by if: github.event_name == 'push' and could be skipped`;
  const migrateLacks = `step "${SMOKE_STEP}" lacks the migrate job: \`docker run --rm\` of the application image with /ops mounted read-only`;
  const migrateChainLacks = `step "${SMOKE_STEP}" lacks \`prisma migrate deploy\` followed by the invariant check in the migrate job`;
  const INVARIANT_RUN_LINE = `run: ${INVARIANTS_COMMAND}`;
  const invariantsMasked = `step "${INVARIANTS_STEP}" lacks the command \`${INVARIANTS_COMMAND}\` alone on its line, with nothing after it that could mask a failure`;
  const migrateMasked = `step "${SMOKE_STEP}" lacks the migrate job as the end of its command, with nothing after it that could mask a failure`;
  const smokeLacks = (what: string): string => `step "${SMOKE_STEP}" lacks ${what}`;

  it("verifies the database invariants once the migrations are applied, then proves the check can fail", async () => {
    const workflow = parseWorkflow(await readFile(CI_WORKFLOW_PATH, "utf8"));
    const steps = ciRunSteps(workflow);
    const deploy = steps.find((step) => shellCommands(step.run).includes(DB_DEPLOY_COMMAND));
    const check = steps.filter((step) => step.name === INVARIANTS_STEP);
    const control = steps.filter((step) => step.name === INVARIANTS_NEGATIVE_STEP);
    expect(deploy).toBeDefined();
    expect(check).toHaveLength(1);
    expect(control).toHaveLength(1);
    expect((check[0] as CIRunStep).index).toBeGreaterThan((deploy as CIRunStep).index);
    expect((control[0] as CIRunStep).index).toBeGreaterThan((deploy as CIRunStep).index);
    expect(unconditionalDefects(check[0] as CIRunStep)).toEqual([]);
    expect(unconditionalDefects(control[0] as CIRunStep)).toEqual([]);
    expect(shellCommands((check[0] as CIRunStep).run)).toContain(INVARIANTS_COMMAND);
  });

  it("drops a constraint and expects a failure marker that verify-invariants.sql really has", () => {
    const sql = readFileSync(
      fileURLToPath(new URL(`../${INVARIANTS_FILE}`, import.meta.url)),
      "utf8",
    );
    expect(sql).toContain("conname = 'event_room_no_overlap'");
    expect(sql).toContain("invariant check FAILED");
  });

  it("smoke-tests the application image with the same migrate command as production", async () => {
    const workflow = parseWorkflow(await readFile(CI_WORKFLOW_PATH, "utf8"));
    const smoke = ciRunSteps(workflow).filter((step) => step.name === SMOKE_STEP);
    expect(smoke).toHaveLength(1);
    const script = joinContinuedLines((smoke[0] as CIRunStep).run);
    const compose = parse(await readFile(COMPOSE_PATH, "utf8")) as Compose;
    const migrate = compose.services.migrate?.command;
    expect(Array.isArray(migrate)).toBe(true);
    const [shell, flag, command] = migrate as string[];
    expect(script).toContain(`jiangtang:ci ${shell} ${flag} "${command}"`);
    expect(script).toContain(IMAGE_MOUNT);
  });

  for (const name of [INVARIANTS_STEP, INVARIANTS_NEGATIVE_STEP, SMOKE_STEP]) {
    it(`rejects a workflow with the "${name}" step removed`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      const fixture = withoutStep(live, name);
      expect(fixture).not.toContain(`- name: ${name}`);
      expect(ciWiringProblems(fixture)).toEqual([
        `expected exactly one executable step named "${name}", found 0`,
      ]);
    });

    it(`rejects a workflow with the "${name}" step duplicated`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      expect(ciWiringProblems(withStepDuplicated(live, name))).toEqual([
        `expected exactly one executable step named "${name}", found 2`,
      ]);
    });

    it(`rejects an if: gate on the "${name}" step`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      expect(ciWiringProblems(withStepKey(live, name, gated))).toEqual([gatedMessage(name)]);
    });

    it(`rejects continue-on-error on the "${name}" step`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      const fixture = withStepKey(live, name, "continue-on-error: true");
      expect(ciWiringProblems(fixture)).toEqual([`step "${name}" sets continue-on-error: true`]);
    });
  }

  it("rejects an invariant check that no longer runs verify-invariants.sql", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, INVARIANT_RUN_LINE, "run: pnpm exec prisma validate");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_STEP}" lacks the command \`${INVARIANTS_COMMAND}\``,
    ]);
  });

  it("rejects an invariant check made non-blocking with || true", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withLineSuffix(live, INVARIANT_RUN_LINE, "|| true");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_STEP}" swallows a nonzero exit: command "true"`,
      invariantsMasked,
    ]);
  });

  // None of these match a swallowed-exit pattern, yet each makes the gate pass on failure.
  for (const suffix of ["|| echo skipped", "|| echo skipped >&2"]) {
    it(`rejects an invariant check followed by "${suffix}"`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      const fixture = withLineSuffix(live, INVARIANT_RUN_LINE, suffix);
      expect(ciWiringProblems(fixture)).toEqual([invariantsMasked]);
    });
  }

  for (const suffix of ["| cat", "&"]) {
    it(`rejects an invariant check that is piped or backgrounded with "${suffix}"`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      const fixture = withLineSuffix(live, INVARIANT_RUN_LINE, suffix);
      expect(ciWiringProblems(fixture)).toEqual([
        `step "${INVARIANTS_STEP}" lacks the command \`${INVARIANTS_COMMAND}\``,
      ]);
    });
  }

  it("rejects an invariant check followed by ; true", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, INVARIANT_RUN_LINE, `${INVARIANT_RUN_LINE}; true`);
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_STEP}" swallows a nonzero exit: command "true"`,
      invariantsMasked,
    ]);
  });

  it("rejects a negative control whose final re-run of the real check is made non-blocking", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      `exit 1; }\n          ${INVARIANTS_COMMAND}\n`,
      `exit 1; }\n          ${INVARIANTS_COMMAND} || echo skipped\n`,
    );
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_NEGATIVE_STEP}" lacks the final re-run of the real check, which proves the rollback`,
    ]);
  });

  it("rejects an invariant check ordered before the migrations are applied", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withStepMovedBefore(live, INVARIANTS_STEP, `- run: ${DB_DEPLOY_COMMAND}`);
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_STEP}" must run after ${DB_DEPLOY_COMMAND}`,
    ]);
  });

  it("rejects an invariant negative control ordered before the migrations are applied", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withStepMovedBefore(
      live,
      INVARIANTS_NEGATIVE_STEP,
      `- run: ${DB_DEPLOY_COMMAND}`,
    );
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_NEGATIVE_STEP}" must run after ${DB_DEPLOY_COMMAND}`,
    ]);
  });

  it("rejects a negative control that no longer opens a transaction", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withoutLine(live, "echo 'BEGIN;'");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_NEGATIVE_STEP}" lacks the transaction opened with BEGIN`,
    ]);
  });

  it("rejects a negative control that no longer drops a checked constraint", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withoutLine(live, "DROP CONSTRAINT event_room_no_overlap");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_NEGATIVE_STEP}" lacks the dropped EXCLUDE constraint`,
    ]);
  });

  it("rejects a negative control that no longer appends the real invariant script", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withoutLine(live, `cat ${INVARIANTS_FILE}`);
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_NEGATIVE_STEP}" lacks the real invariant script appended`,
    ]);
  });

  it("rejects a negative control that no longer rolls back", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withoutLine(live, "echo 'ROLLBACK;'");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_NEGATIVE_STEP}" lacks the trailing ROLLBACK`,
    ]);
  });

  it("rejects a negative control that drops the constraint after the real script", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const drop = `echo 'ALTER TABLE "EventRoomBooking" DROP CONSTRAINT event_room_no_overlap;'`;
    const cat = `cat ${INVARIANTS_FILE}`;
    const fixture = withReplacedOnce(
      live,
      `${drop}
            ${cat}
`,
      `${cat}
            ${drop}
`,
    );
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_NEGATIVE_STEP}" lacks the order BEGIN, drop, real script, ROLLBACK`,
    ]);
  });

  it("rejects a negative control that no longer fails the job when the broken script passes", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      'dropped"\n            exit 1\n          fi',
      'dropped"\n          fi',
    );
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_NEGATIVE_STEP}" lacks the failure of the job when the broken script passes`,
    ]);
  });

  it("rejects a negative control that no longer requires the invariant failure marker", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withoutLine(live, "grep -q 'invariant check FAILED'");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_NEGATIVE_STEP}" lacks the 'invariant check FAILED' marker check that fails the job`,
    ]);
  });

  it("rejects a negative control whose marker check is made non-blocking with || true", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withLineSuffix(live, "grep -q 'invariant check FAILED'", "|| true");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_NEGATIVE_STEP}" swallows a nonzero exit: command "true"`,
    ]);
  });

  it("rejects a negative control whose marker check exits 0", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      'not through the invariant check"; exit 1; }',
      'not through the invariant check"; exit 0; }',
    );
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_NEGATIVE_STEP}" swallows a nonzero exit: command "exit 0"`,
      `step "${INVARIANTS_NEGATIVE_STEP}" lacks the 'invariant check FAILED' marker check that fails the job`,
    ]);
  });

  it("rejects a negative control that no longer re-runs the real check after the rollback", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      `exit 1; }\n          ${INVARIANTS_COMMAND}\n`,
      "exit 1; }\n",
    );
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${INVARIANTS_NEGATIVE_STEP}" lacks the final re-run of the real check, which proves the rollback`,
    ]);
  });

  it("rejects a smoke test ordered before the application image build", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withStepMovedBefore(live, SMOKE_STEP, `- name: ${APP_BUILD_STEP}`);
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" must run after the application image build`,
    ]);
  });

  it("rejects a smoke test whose migrate job runs in another image", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      `${IMAGE_MOUNT} jiangtang:ci`,
      `${IMAGE_MOUNT} jiangtang-postgres-walg:ci`,
    );
    expect(ciWiringProblems(fixture)).toEqual([migrateLacks]);
  });

  it("rejects a smoke test whose migrate job lacks the read-only /ops mount", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, `${IMAGE_MOUNT} jiangtang:ci`, "jiangtang:ci");
    expect(ciWiringProblems(fixture)).toEqual([migrateLacks]);
  });

  it("rejects a smoke test that no longer migrates", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, "prisma migrate deploy && ", "");
    expect(ciWiringProblems(fixture)).toEqual([migrateChainLacks]);
  });

  it("rejects a smoke test whose migrate job no longer checks the invariants", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      " && ./node_modules/.bin/prisma db execute --file /ops/verify-invariants.sql",
      "",
    );
    expect(ciWiringProblems(fixture)).toEqual([migrateChainLacks]);
  });

  it("rejects a smoke test whose migrate job is made non-blocking with || true", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      '/ops/verify-invariants.sql"\n',
      '/ops/verify-invariants.sql" || true\n',
    );
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" swallows a nonzero exit: command "true"`,
      migrateMasked,
    ]);
  });

  for (const suffix of ["|| echo skipped", "; echo skipped", "| cat"]) {
    it(`rejects a smoke test whose migrate job is followed by "${suffix}"`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      const fixture = withReplacedOnce(
        live,
        '/ops/verify-invariants.sql"\n',
        `/ops/verify-invariants.sql" ${suffix}\n`,
      );
      expect(ciWiringProblems(fixture)).toEqual([migrateMasked]);
    });
  }

  it("rejects a smoke test that no longer starts the application in production mode", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withoutLine(live, "-e NODE_ENV=production");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" lacks the detached application container started in production mode from the application image`,
    ]);
  });

  it("rejects a smoke test that no longer probes /healthz", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withoutLine(live, "3000/healthz");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" lacks the /healthz probe`,
      `step "${SMOKE_STEP}" lacks the order: migrate job, application start, /healthz, /login`,
    ]);
  });

  it("rejects a smoke test whose /healthz timeout exits 0", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      'did not return 200 within 45 tries"; exit 1; }',
      'did not return 200 within 45 tries"; exit 0; }',
    );
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" swallows a nonzero exit: command "exit 0"`,
      `step "${SMOKE_STEP}" lacks the failure of the job when /healthz never answers`,
    ]);
  });

  it("rejects a smoke test that no longer probes /login", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withoutLine(live, "3000/login");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" lacks the /login probe`,
      `step "${SMOKE_STEP}" lacks the order: migrate job, application start, /healthz, /login`,
    ]);
  });

  const loginFallback = smokeLacks(
    "a /login probe whose transport failure reaches the guard as code=000",
  );

  it("rejects a /login probe without the code=000 fallback, which would abort before the guard", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, ')" || code=000', ')"');
    expect(ciWiringProblems(fixture)).toEqual([loginFallback]);
  });

  it("rejects a /login probe whose fallback reports a healthy status", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, ')" || code=000', ')" || code=200');
    expect(ciWiringProblems(fixture)).toEqual([loginFallback]);
  });

  it("rejects a /login probe whose transport failure is swallowed with || true", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, ')" || code=000', ')" || true');
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" swallows a nonzero exit: command "true"`,
      loginFallback,
    ]);
  });

  it("rejects a smoke test whose /login check is made non-blocking with || true", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withLineSuffix(live, '[ "$code" = 200 ]', "|| true");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" swallows a nonzero exit: command "true"`,
    ]);
  });

  it("rejects a smoke test that no longer requires a 200 from /login", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withoutLine(live, '[ "$code" = 200 ]');
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" lacks the failure of the job when /login does not return 200`,
    ]);
  });

  it("rejects a smoke test that no longer cleans up its container", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withoutLine(live, "trap cleanup EXIT");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" lacks the EXIT trap that removes the container`,
    ]);
  });

  it("rejects a smoke test whose cleanup no longer removes the container", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withoutLine(live, "docker rm -f jiangtang-smoke");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" lacks the EXIT trap that removes the container`,
    ]);
  });

  // ── /healthz readiness and probe timeouts.
  const healthzExact = smokeLacks("a /healthz probe that is ready only on exactly HTTP 200");
  const healthzTimeouts = smokeLacks("--connect-timeout and --max-time on the /healthz probe");
  const loginTimeouts = smokeLacks("--connect-timeout and --max-time on the /login probe");

  it("rejects a /healthz readiness probe that accepts any non-error status, including a redirect", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      `if [ "$(curl -s --connect-timeout 1 --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/healthz 2> /dev/null)" = 200 ]; then`,
      "if curl -fsS --connect-timeout 1 --max-time 2 -o /dev/null http://127.0.0.1:3000/healthz 2> /dev/null; then",
    );
    expect(ciWiringProblems(fixture)).toEqual([healthzExact]);
  });

  it("rejects a /healthz readiness probe that no longer compares the status with 200", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, ')" = 200 ]; then', ')" != 000 ]; then');
    expect(ciWiringProblems(fixture)).toEqual([healthzExact]);
  });

  it("rejects a /healthz probe without --connect-timeout", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, "--connect-timeout 1 ", "");
    expect(ciWiringProblems(fixture)).toEqual([healthzTimeouts]);
  });

  it("rejects a /healthz probe without --max-time", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, "--max-time 2 ", "");
    expect(ciWiringProblems(fixture)).toEqual([healthzTimeouts]);
  });

  it("rejects a /login probe without --connect-timeout", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, "--connect-timeout 2 ", "");
    expect(ciWiringProblems(fixture)).toEqual([loginTimeouts]);
  });

  it("rejects a /login probe without --max-time", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, "--max-time 10 ", "");
    expect(ciWiringProblems(fixture)).toEqual([loginTimeouts]);
  });

  it("rejects a /login probe that no longer captures the HTTP status", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      "-w '%{http_code}' http://127.0.0.1:3000/login",
      "http://127.0.0.1:3000/login",
    );
    expect(ciWiringProblems(fixture)).toEqual([
      smokeLacks("the HTTP status of the /login probe captured with -w '%{http_code}'"),
    ]);
  });

  // ── The cleanup() trap must not change the status of the step.
  const CLEANUP_LAST = "docker rm -f jiangtang-smoke > /dev/null 2>&1 || true\n";
  const cleanupUses = (command: string): string =>
    `step "${SMOKE_STEP}" cleanup() uses "${command}", which replaces the exit status of the failed step`;

  it("rejects a smoke cleanup that ends in exit 0", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, CLEANUP_LAST, `${CLEANUP_LAST}            exit 0\n`);
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" swallows a nonzero exit: command "exit 0"`,
      cleanupUses("exit 0"),
    ]);
  });

  it("rejects a smoke cleanup that returns early", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, CLEANUP_LAST, `${CLEANUP_LAST}            return 0\n`);
    expect(ciWiringProblems(fixture)).toEqual([cleanupUses("return 0")]);
  });

  it("rejects a smoke cleanup that ends in exit with a nonzero code", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, CLEANUP_LAST, `${CLEANUP_LAST}            exit 1\n`);
    expect(ciWiringProblems(fixture)).toEqual([cleanupUses("exit 1")]);
  });

  it("rejects a smoke cleanup whose log dump is followed by || exit 0", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      "docker logs jiangtang-smoke || true",
      "docker logs jiangtang-smoke || exit 0",
    );
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" swallows a nonzero exit: command "exit 0"`,
      cleanupUses("exit 0"),
    ]);
  });

  it("rejects a smoke cleanup that tolerates a failure on a line other than the two known ones", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withLineSuffix(live, 'echo "::endgroup::"', "|| true");
    expect(ciWiringProblems(fixture)).toEqual([
      `step "${SMOKE_STEP}" swallows a nonzero exit: command "true"`,
    ]);
  });

  it("rejects a smoke cleanup whose docker rm is only commented out", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    // Commenting in place keeps the indentation, which a column-0 `#` would not inside the block.
    const fixture = withReplacedOnce(
      live,
      "docker rm -f jiangtang-smoke > /dev/null 2>&1 || true",
      "# docker rm -f jiangtang-smoke > /dev/null 2>&1 || true",
    );
    expect(ciWiringProblems(fixture)).toEqual([
      smokeLacks("the EXIT trap that removes the container"),
    ]);
  });

  // ── The smoke test stays isolated: host network, its own database, no integrations.
  it("rejects a migrate job without --network host", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(live, "docker run --rm --network host ", "docker run --rm ");
    expect(ciWiringProblems(fixture)).toEqual([smokeLacks("--network host on the migrate job")]);
  });

  it("rejects an application container without --network host", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      "--name jiangtang-smoke --network host",
      "--name jiangtang-smoke",
    );
    expect(ciWiringProblems(fixture)).toEqual([
      smokeLacks("--network host on the application container"),
    ]);
  });

  it("rejects a migrate job that does not take its database from SMOKE_DATABASE_URL", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      '-e DATABASE_URL="$SMOKE_DATABASE_URL" -e TZ=Europe/Berlin',
      "-e DATABASE_URL -e TZ=Europe/Berlin",
    );
    expect(ciWiringProblems(fixture)).toEqual([
      smokeLacks('-e DATABASE_URL="$SMOKE_DATABASE_URL" on the migrate job'),
    ]);
  });

  it("rejects an application container that does not take its database from SMOKE_DATABASE_URL", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      '-e DATABASE_URL="$SMOKE_DATABASE_URL" \\\n            -e BETTER_AUTH_SECRET',
      "-e DATABASE_URL \\\n            -e BETTER_AUTH_SECRET",
    );
    expect(ciWiringProblems(fixture)).toEqual([
      smokeLacks('-e DATABASE_URL="$SMOKE_DATABASE_URL" on the application container'),
    ]);
  });

  it("rejects a SMOKE_DATABASE_URL that targets another database", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withReplacedOnce(
      live,
      "localhost:5432/jiangtang_smoke?schema",
      "localhost:5432/jiangtang?schema",
    );
    expect(ciWiringProblems(fixture)).toEqual([
      smokeLacks(`SMOKE_DATABASE_URL pointing at the database ${SMOKE_DATABASE}`),
    ]);
  });

  for (const name of SMOKE_BLANK_VARIABLES) {
    it(`rejects an application container that sets ${name} to a value`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      const fixture = withReplacedOnce(live, `-e ${name}=`, `-e ${name}=https://example.invalid`);
      expect(ciWiringProblems(fixture)).toEqual([
        smokeLacks(`${name}= set blank on the application container`),
      ]);
    });

    it(`rejects an application container that no longer sets ${name}`, async () => {
      const live = await readFile(CI_WORKFLOW_PATH, "utf8");
      const fixture = withReplacedOnce(live, `-e ${name}=`, "");
      expect(ciWiringProblems(fixture)).toEqual([
        smokeLacks(`${name}= set blank on the application container`),
      ]);
    });
  }

  it("rejects a workflow without the application image build the smoke test depends on", async () => {
    const live = await readFile(CI_WORKFLOW_PATH, "utf8");
    const fixture = withoutStep(live, APP_BUILD_STEP);
    expect(ciWiringProblems(fixture)).toEqual([
      `expected exactly one executable step running the pinned application image build ("docker build --platform linux/amd64 -t <tag> ."), found 0`,
    ]);
  });
});
