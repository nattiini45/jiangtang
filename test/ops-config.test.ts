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
  const tmpRoot = mkdtempSync(join(tmpdir(), "b05-walg-fake-"));
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
  const tmpRoot = mkdtempSync(join(tmpdir(), "b06-aws-fake-"));
  const fakeBin = join(tmpRoot, "bin");
  const argvLog = join(tmpRoot, "argv.log");
  const scriptPath = join(tmpRoot, "minio-init.sh");
  const SECRET_SENTINEL = "b06-secret-sentinel-do-not-log";

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
  const tmpRoot = mkdtempSync(join(tmpdir(), "b07a-restore-"));
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
  const tmpRoot = mkdtempSync(join(tmpdir(), "b07c-restore-"));
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
  const tmpRoot = mkdtempSync(join(tmpdir(), "b10-drill-"));
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
 * about what CI executes — the plan's review history records exactly that
 * failure, a promised in-image guard that was never wired. These assertions
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

type CIStep = {
  name?: string;
  run?: string;
  uses?: string;
  if?: unknown;
  "continue-on-error"?: unknown;
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

function parseWorkflow(text: string): CIWorkflow {
  return parse(text) as CIWorkflow;
}

function ciRunSteps(workflow: CIWorkflow): CIRunStep[] {
  const steps = workflow.jobs?.ci?.steps ?? [];
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

function buildCommands(workflow: CIWorkflow): BuildRef[] {
  return ciRunSteps(workflow).flatMap((step) =>
    shellCommands(step.run)
      .filter((command) => command.startsWith("docker build "))
      .map((command) => ({ step, command, tag: IMAGE_BUILD.exec(command)?.[1] })),
  );
}

/**
 * Every wiring problem in a workflow text. Pure over the text so the negative
 * controls below run the SAME assertions over a mutated fixture.
 */
function ciWiringProblems(text: string): string[] {
  const problems: string[] = [];
  let workflow: CIWorkflow;
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
    if (job.if !== undefined) {
      problems.push(`job "${id}" is gated by if: ${String(job.if)} and could be skipped`);
    }
    if (job["continue-on-error"] !== undefined) {
      problems.push(`job "${id}" sets continue-on-error: ${String(job["continue-on-error"])}`);
    }
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
  const runLines = steps.flatMap((step) => step.run.split(/\r?\n/).map((line) => line.trim()));
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
    ["pnpm test:e2e (browser gate)", /^pnpm test:e2e$/],
  ];
  for (const [label, pattern] of required) {
    if (!runLines.some((line) => pattern.test(line))) {
      problems.push(`pre-existing CI check is missing: ${label}`);
    }
  }
  if (!steps.some((step) => step.run.includes("CREATE DATABASE"))) {
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

  // (5) Least privilege, no secrets, no publication of any artifact type.
  const stepDefs = workflow.jobs?.ci?.steps ?? [];
  const uses = stepDefs.map((step) => step.uses ?? "");
  if (!uses.includes("actions/upload-artifact@v4")) {
    problems.push("pre-existing CI check is missing: the Playwright failure-diagnostics upload");
  }
  const executableText = [...steps.map((step) => step.run), ...uses].join("\n");
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
  if (/\$\{\{\s*secrets\./.test(text)) problems.push("workflow references repository secrets");

  return problems;
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
  const runIndex = lines.findIndex(
    (line, index) => index > header && line.trim().startsWith("run:"),
  );
  if (runIndex === -1) throw new Error(`fixture anchor step has no run: line: ${stepName}`);
  lines.splice(runIndex, 0, `        ${key}`);
  return lines.join("\n");
}

describe("CI: in-image restore guards are wired", () => {
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
    const lines = ciRunSteps(workflow).flatMap((step) => shellCommands(step.run));
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
      "pnpm test:e2e",
    ]) {
      expect(lines, command).toContain(command);
    }
    expect(ciRunSteps(workflow).some((step) => step.run.includes("CREATE DATABASE"))).toBe(true);
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
});
