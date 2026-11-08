import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Backup and WAL-archive failures reach ALERT_WEBHOOK. The backup sidecar writes
 * one status file per failing check into a shared volume; the alerting sidecar,
 * which already pages on a failed healthcheck, reads that volume and posts. Each
 * script runs under the host Bash with stub `wal-g`, `psql` and `curl` as the
 * only reachable copies. No Docker, no database, no network.
 */

const root = (p: string): string => fileURLToPath(new URL(`../${p}`, import.meta.url));
const BACKUP_SCRIPT = root("ops/postgres/backup.sh");
const WAL_CHECK_SCRIPT = root("ops/postgres/check-wal-archive.sh");
const ALERT_SCRIPT = root("ops/alerting/backup-alert.sh");
const UPLOADS_SCRIPT = root("ops/postgres/uploads-backup.sh");
const COMPOSE_PATH = root("docker-compose.yml");

/** Host Bash by absolute path; System32\bash.exe is the WSL launcher, so it is skipped. */
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

const tmpRoot = mkdtempSync(join(tmpdir(), "backup-alerts-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

let caseNo = 0;
interface Sandbox {
  dir: string;
  bin: string;
  status: string;
  state: string;
  log: string;
  stub(name: string, body: string): void;
  run(script: string, env?: Record<string, string>): { status: number | null; out: string };
}

function sandbox(): Sandbox {
  caseNo += 1;
  const dir = join(tmpRoot, `case-${caseNo}`);
  const bin = join(dir, "bin");
  const status = join(dir, "status");
  const state = join(dir, "state");
  const log = join(dir, "calls.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(status);
  return {
    dir,
    bin,
    status,
    state,
    log,
    stub(name, body) {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    },
    run(script, env = {}) {
      const result = spawnSync(resolveHostBash(), [toShellPath(script)], {
        env: {
          PATH: `${toShellPath(bin)}:/usr/bin:/bin`,
          CALLS_LOG: toShellPath(log),
          ...env,
        },
        encoding: "utf8",
      });
      if (result.error) throw result.error;
      return { status: result.status, out: `${result.stdout}${result.stderr}` };
    },
  };
}

function calls(sb: Sandbox): string[] {
  return existsSync(sb.log) ? readFileSync(sb.log, "utf8").split("\n").filter(Boolean) : [];
}

describe("backup.sh records its outcome for the alerting sidecar", () => {
  function backupSandbox(walgExit: number): Sandbox {
    const sb = sandbox();
    const pgdata = join(sb.dir, "pgdata");
    mkdirSync(pgdata);
    writeFileSync(join(pgdata, "PG_VERSION"), "18\n");
    sb.stub("wal-g", `[ "$1" = backup-push ] && exit ${walgExit}\nexit 0`);
    return Object.assign(sb, { pgdata });
  }

  function env(sb: Sandbox & { pgdata?: string }): Record<string, string> {
    return {
      WALG_S3_PREFIX: "s3://synthetic-bucket/postgres",
      AWS_ACCESS_KEY_ID: "synthetic-key-id",
      AWS_SECRET_ACCESS_KEY: "synthetic-secret",
      WALG_RETENTION_COUNT: "7",
      PGDATA: toShellPath(join(sb.dir, "pgdata")),
      BACKUP_STATUS_DIR: toShellPath(sb.status),
    };
  }

  it("writes backup.failed with the exit code when the base backup fails", () => {
    const sb = backupSandbox(3);
    writeFileSync(join(sb.status, "backup.ok"), "2026-11-01T00:00:00Z\n");
    const { status } = sb.run(BACKUP_SCRIPT, env(sb));
    expect(status).toBe(3);
    const failed = readFileSync(join(sb.status, "backup.failed"), "utf8");
    expect(failed).toContain("base backup FAILED");
    expect(failed).toContain("exit 3");
    // The last success stays as it was, so its age keeps counting.
    expect(readFileSync(join(sb.status, "backup.ok"), "utf8")).toBe("2026-11-01T00:00:00Z\n");
  });

  it("clears backup.failed and stamps backup.ok after a successful run", () => {
    const sb = backupSandbox(0);
    writeFileSync(join(sb.status, "backup.failed"), "old failure\n");
    const { status } = sb.run(BACKUP_SCRIPT, env(sb));
    expect(status).toBe(0);
    expect(existsSync(join(sb.status, "backup.failed"))).toBe(false);
    expect(readFileSync(join(sb.status, "backup.ok"), "utf8")).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("records a refused configuration as a failure too", () => {
    const sb = backupSandbox(0);
    const { status } = sb.run(BACKUP_SCRIPT, { ...env(sb), WALG_RETENTION_COUNT: "0" });
    expect(status).toBe(1);
    expect(readFileSync(join(sb.status, "backup.failed"), "utf8")).toContain("exit 1");
  });

  it("reports a failed retention prune as such, keeping the backup counted as done", () => {
    const sb = backupSandbox(0);
    sb.stub("wal-g", '[ "$1" = delete ] && exit 4\nexit 0');
    const { status } = sb.run(BACKUP_SCRIPT, env(sb));
    expect(status).toBe(4);
    const failed = readFileSync(join(sb.status, "backup.failed"), "utf8");
    expect(failed).toContain("retention pruning FAILED");
    expect(failed).toContain("exit 4");
    expect(existsSync(join(sb.status, "backup.ok"))).toBe(true);
  });

  it("writes nothing when no status directory is configured", () => {
    const sb = backupSandbox(3);
    const { BACKUP_STATUS_DIR: _unused, ...rest } = env(sb);
    sb.run(BACKUP_SCRIPT, rest);
    expect(existsSync(join(sb.status, "backup.failed"))).toBe(false);
  });
});

describe("check-wal-archive.sh reads pg_stat_archiver", () => {
  function walSandbox(psqlBody: string): Sandbox {
    const sb = sandbox();
    sb.stub("psql", `printf 'psql %s\\n' "$*" >> "$CALLS_LOG"\n${psqlBody}`);
    return sb;
  }
  const env = (sb: Sandbox): Record<string, string> => ({
    WALG_S3_PREFIX: "s3://synthetic-bucket/postgres",
    BACKUP_STATUS_DIR: toShellPath(sb.status),
  });

  it("writes wal-archive.failed when the latest push failed after the last success", () => {
    const sb = walSandbox(
      "echo '4|000000010000000000000003|2026-11-05T10:00:00Z|2026-11-05T09:00:00Z|t'",
    );
    expect(sb.run(WAL_CHECK_SCRIPT, env(sb)).status).toBe(0);
    const failed = readFileSync(join(sb.status, "wal-archive.failed"), "utf8");
    expect(failed).toContain("WAL archiving is FAILING");
    expect(failed).toContain("000000010000000000000003");
    expect(failed).toContain("2026-11-05T09:00:00Z");
  });

  it("clears wal-archive.failed once a later push succeeded", () => {
    const sb = walSandbox(
      "echo '4|000000010000000000000003|2026-11-05T10:00:00Z|2026-11-05T10:01:00Z|f'",
    );
    writeFileSync(join(sb.status, "wal-archive.failed"), "old\n");
    expect(sb.run(WAL_CHECK_SCRIPT, env(sb)).status).toBe(0);
    expect(existsSync(join(sb.status, "wal-archive.failed"))).toBe(false);
  });

  it("reports a check that cannot reach the database", () => {
    const sb = walSandbox("echo 'connection refused' >&2; exit 2");
    sb.run(WAL_CHECK_SCRIPT, env(sb));
    expect(readFileSync(join(sb.status, "wal-archive.failed"), "utf8")).toContain(
      "could not read pg_stat_archiver",
    );
  });

  it("keeps a recorded failure when a restart has reset the archiver statistics", () => {
    const sb = walSandbox("echo '0|||never|f'");
    writeFileSync(join(sb.status, "wal-archive.failed"), "Jiangtang WAL archiving is FAILING\n");
    expect(sb.run(WAL_CHECK_SCRIPT, env(sb)).status).toBe(0);
    expect(readFileSync(join(sb.status, "wal-archive.failed"), "utf8")).toContain("FAILING");
  });

  it("puts the changing details below a stable first line", () => {
    const sb = walSandbox(
      "echo '4|000000010000000000000003|2026-11-05T10:00:00Z|2026-11-05T09:00:00Z|t'",
    );
    sb.run(WAL_CHECK_SCRIPT, env(sb));
    const [first, ...rest] = readFileSync(join(sb.status, "wal-archive.failed"), "utf8").split(
      "\n",
    );
    expect(first).toBe("Jiangtang WAL archiving is FAILING.");
    expect(rest.join("\n")).toContain("000000010000000000000003");
  });

  it("does nothing but clear the status when archiving is not configured", () => {
    const sb = walSandbox("exit 0");
    writeFileSync(join(sb.status, "wal-archive.failed"), "old\n");
    expect(sb.run(WAL_CHECK_SCRIPT, { BACKUP_STATUS_DIR: toShellPath(sb.status) }).status).toBe(0);
    expect(existsSync(join(sb.status, "wal-archive.failed"))).toBe(false);
    expect(calls(sb)).toEqual([]);
  });
});

describe("uploads-backup.sh archives the uploads volume to the S3 target", () => {
  const ARCHIVE = /^st put --no-compress --read-stdin uploads\/uploads_\d{8}T\d{6}Z\.tar$/;

  // The wal-g stub logs each call, keeps what "st put" receives on stdin and lists
  // the archives named in LS_NAMES; WALG_PUT_EXIT makes the upload fail.
  function uploadsSandbox(): Sandbox & { uploads: string; received: string } {
    const sb = sandbox();
    const uploads = join(sb.dir, "uploads");
    mkdirSync(join(uploads, "ab"), { recursive: true });
    writeFileSync(join(uploads, "ab", "ab12-synthetic.png"), "ciphertext");
    const received = join(sb.dir, "received.tar");
    sb.stub(
      "wal-g",
      [
        'printf \'%s\\n\' "$*" >> "$CALLS_LOG"',
        'if [ "$1 $2" = "st put" ]; then cat > "$RECEIVED"; exit "${WALG_PUT_EXIT:-0}"; fi',
        'if [ "$1 $2" = "st ls" ]; then',
        '  echo "type size last modified name"',
        '  for n in $LS_NAMES; do echo "obj 10 2026-11-01 00:00:00 +0000 UTC $n"; done',
        "fi",
        "exit 0",
      ].join("\n"),
    );
    return Object.assign(sb, { uploads, received });
  }

  const env = (
    sb: Sandbox & { uploads: string; received: string },
    extra: Record<string, string> = {},
  ): Record<string, string> => ({
    WALG_S3_PREFIX: "s3://synthetic-bucket/postgres",
    AWS_ACCESS_KEY_ID: "synthetic-key-id",
    AWS_SECRET_ACCESS_KEY: "synthetic-secret",
    UPLOADS_DIR: toShellPath(sb.uploads),
    BACKUP_STATUS_DIR: toShellPath(sb.status),
    RECEIVED: toShellPath(sb.received),
    LS_NAMES: "",
    ...extra,
  });

  it("is a no-op without an S3 target", () => {
    const sb = uploadsSandbox();
    const { WALG_S3_PREFIX: _unused, ...rest } = env(sb);
    expect(sb.run(UPLOADS_SCRIPT, rest).status).toBe(0);
    expect(calls(sb)).toEqual([]);
  });

  it("streams a tar of the volume into one new object and clears uploads.failed", () => {
    const sb = uploadsSandbox();
    writeFileSync(join(sb.status, "uploads.failed"), "old failure\n");
    expect(sb.run(UPLOADS_SCRIPT, env(sb)).status).toBe(0);
    expect(calls(sb)[0]).toMatch(ARCHIVE);
    const listing = spawnSync("tar", ["-tf", sb.received], { encoding: "utf8" }).stdout;
    expect(listing).toContain("./ab/ab12-synthetic.png");
    expect(existsSync(join(sb.status, "uploads.failed"))).toBe(false);
  });

  it("keeps the newest UPLOADS_RETENTION_COUNT archives and deletes only older ones", () => {
    const sb = uploadsSandbox();
    const names = [
      "uploads_20261103T000000Z.tar",
      "uploads_20261101T000000Z.tar",
      "uploads_20261102T000000Z.tar",
      "unrelated.tar",
    ];
    const run = sb.run(
      UPLOADS_SCRIPT,
      env(sb, { UPLOADS_RETENTION_COUNT: "2", LS_NAMES: names.join(" ") }),
    );
    expect(run.status).toBe(0);
    expect(calls(sb).filter((line) => line.startsWith("st rm"))).toEqual([
      "st rm uploads/uploads_20261101T000000Z.tar",
    ]);
  });

  it("records a failed upload, removes the partial object and deletes nothing else", () => {
    const sb = uploadsSandbox();
    const run = sb.run(
      UPLOADS_SCRIPT,
      env(sb, { WALG_PUT_EXIT: "5", LS_NAMES: "uploads_20261101T000000Z.tar" }),
    );
    expect(run.status).toBe(1);
    const failed = readFileSync(join(sb.status, "uploads.failed"), "utf8");
    expect(failed).toContain("uploads archive FAILED (exit 1)");
    const log = calls(sb);
    expect(log[0]).toMatch(ARCHIVE);
    expect(log[1]).toBe(log[0]!.replace("put --no-compress --read-stdin", "rm"));
    expect(log).toHaveLength(2);
  });

  it.each(["0", "", "07", "x"])("refuses UPLOADS_RETENTION_COUNT=%j before any upload", (value) => {
    const sb = uploadsSandbox();
    expect(sb.run(UPLOADS_SCRIPT, env(sb, { UPLOADS_RETENTION_COUNT: value })).status).toBe(1);
    expect(calls(sb)).toEqual([]);
    expect(existsSync(join(sb.status, "uploads.failed"))).toBe(true);
  });

  it("fails when the uploads volume is not mounted", () => {
    const sb = uploadsSandbox();
    const run = sb.run(UPLOADS_SCRIPT, env(sb, { UPLOADS_DIR: toShellPath(join(sb.dir, "none")) }));
    expect(run.status).toBe(1);
    expect(calls(sb)).toEqual([]);
  });
});

describe("backup-alert.sh posts status changes to ALERT_WEBHOOK", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = sandbox();
    // Records the JSON body (-d) of every post; CURL_FAIL=1 simulates a webhook error.
    sb.stub(
      "curl",
      [
        'body=""',
        'while [ $# -gt 0 ]; do [ "$1" = "-d" ] && { body="$2"; shift; }; shift; done',
        'printf \'%s\\n\' "$body" >> "$CALLS_LOG"',
        '[ "${CURL_FAIL:-0}" = 1 ] && exit 22',
        "exit 0",
      ].join("\n"),
    );
  });

  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    ALERT_WEBHOOK: "https://hooks.example.invalid/synthetic",
    BACKUP_STATUS_DIR: toShellPath(sb.status),
    ALERT_STATE_DIR: toShellPath(sb.state),
    ...extra,
  });
  const posts = (): string[] =>
    calls(sb).map((line) => (JSON.parse(line) as { text: string }).text);

  it("posts a failure once, not on every poll", () => {
    writeFileSync(
      join(sb.status, "backup.failed"),
      'Jiangtang base backup FAILED (exit 3) "quoted"\n',
    );
    expect(sb.run(ALERT_SCRIPT, env()).status).toBe(0);
    sb.run(ALERT_SCRIPT, env());
    expect(posts()).toEqual(['Jiangtang base backup FAILED (exit 3) "quoted"']);
  });

  it("posts again when the failure message changes", () => {
    writeFileSync(join(sb.status, "wal-archive.failed"), "WAL archiving is FAILING: 1 failed\n");
    sb.run(ALERT_SCRIPT, env());
    writeFileSync(join(sb.status, "wal-archive.failed"), "WAL archiving is FAILING: 9 failed\n");
    sb.run(ALERT_SCRIPT, env());
    expect(posts()).toHaveLength(2);
    expect(posts()[1]).toContain("9 failed");
  });

  it("does not repost when only the details below the first line change", () => {
    writeFileSync(
      join(sb.status, "wal-archive.failed"),
      "Jiangtang WAL archiving is FAILING.\n4 failed\n",
    );
    sb.run(ALERT_SCRIPT, env());
    writeFileSync(
      join(sb.status, "wal-archive.failed"),
      "Jiangtang WAL archiving is FAILING.\n5 failed\n",
    );
    sb.run(ALERT_SCRIPT, env());
    expect(posts()).toEqual(["Jiangtang WAL archiving is FAILING.\n4 failed"]);
  });

  it("repeats a persisting failure after the re-alert interval", () => {
    writeFileSync(join(sb.status, "backup.failed"), "Jiangtang base backup FAILED (exit 1)\n");
    sb.run(ALERT_SCRIPT, env({ REALERT_SECONDS: "0" }));
    sb.run(ALERT_SCRIPT, env({ REALERT_SECONDS: "0" }));
    expect(posts()).toHaveLength(2);
  });

  it("posts a recovery once the failure clears, then stays quiet", () => {
    writeFileSync(join(sb.status, "backup.failed"), "Jiangtang base backup FAILED (exit 1)\n");
    sb.run(ALERT_SCRIPT, env());
    rmSync(join(sb.status, "backup.failed"));
    sb.run(ALERT_SCRIPT, env());
    sb.run(ALERT_SCRIPT, env());
    expect(posts()).toHaveLength(2);
    expect(posts()[1]).toMatch(/recovered/i);
  });

  it("retries a post that the webhook rejected", () => {
    writeFileSync(join(sb.status, "backup.failed"), "Jiangtang base backup FAILED (exit 1)\n");
    sb.run(ALERT_SCRIPT, env({ CURL_FAIL: "1" }));
    sb.run(ALERT_SCRIPT, env());
    expect(posts()).toHaveLength(2);
  });

  it("alerts when the last successful base backup is too old", () => {
    writeFileSync(join(sb.status, "backup.ok"), "2026-11-01T00:00:00Z\n");
    spawnSync(resolveHostBash(), [
      "-c",
      `touch -d '40 hours ago' '${toShellPath(join(sb.status, "backup.ok"))}'`,
    ]);
    sb.run(ALERT_SCRIPT, env());
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toContain("No successful base backup since 2026-11-01T00:00:00Z");
  });

  it("posts a failed uploads archive and its recovery", () => {
    writeFileSync(
      join(sb.status, "uploads.failed"),
      "Jiangtang uploads archive FAILED (exit 1).\n",
    );
    sb.run(ALERT_SCRIPT, env());
    rmSync(join(sb.status, "uploads.failed"));
    sb.run(ALERT_SCRIPT, env());
    expect(posts()).toEqual([
      "Jiangtang uploads archive FAILED (exit 1).",
      "Jiangtang uploads archive recovered: the latest run succeeded.",
    ]);
  });

  it("stays quiet for a recent backup and when nothing has run yet", () => {
    sb.run(ALERT_SCRIPT, env());
    writeFileSync(join(sb.status, "backup.ok"), "2026-11-05T00:00:00Z\n");
    sb.run(ALERT_SCRIPT, env());
    expect(posts()).toEqual([]);
  });
});

describe("compose wiring for backup alerts (static)", () => {
  type Service = {
    command?: string | string[];
    environment?: Record<string, string>;
    volumes?: string[];
  };
  type Compose = { services: Record<string, Service>; volumes?: Record<string, unknown> };
  const text = (cmd: string | string[] | undefined): string =>
    Array.isArray(cmd) ? cmd.join("\n") : (cmd ?? "");

  it("shares a status volume: written by backup, read-only for alerting", async () => {
    const compose = parse(await readFile(COMPOSE_PATH, "utf8")) as Compose;
    expect(compose.volumes).toHaveProperty("backup-status");
    const backup = compose.services.backup!;
    const alerting = compose.services.alerting!;
    expect(backup.volumes).toContain("backup-status:/status");
    expect(backup.environment?.BACKUP_STATUS_DIR).toBe("/status");
    expect(alerting.volumes).toContain("backup-status:/backup-status:ro");
    expect(alerting.environment?.BACKUP_STATUS_DIR).toBe("/backup-status");
  });

  it("checks WAL archiving from the backup loop and posts from the alerting loop", async () => {
    const compose = parse(await readFile(COMPOSE_PATH, "utf8")) as Compose;
    const backupLines = text(compose.services.backup!.command)
      .split("\n")
      .map((l) => l.trim());
    expect(backupLines).toContain("bash /ops/check-wal-archive.sh || true");
    // The uploads archive runs right after each base backup: at start and daily.
    expect(backupLines.filter((l) => l === "bash /ops/uploads-backup.sh || true")).toHaveLength(2);
    const backup = compose.services.backup!;
    expect(backup.volumes).toContain("uploads:/uploads:ro");
    expect(backup.environment?.UPLOADS_DIR).toBe("/uploads");
    const alertingLines = text(compose.services.alerting!.command);
    expect(alertingLines).toContain("bash /ops/backup-alert.sh || true");
    expect(alertingLines).toContain("bash /ops/healthcheck-alert.sh || true");
    // Both thresholds can be tuned from the deployment's environment.
    const alertingEnv = compose.services.alerting!.environment ?? {};
    expect(alertingEnv.BACKUP_MAX_AGE_SECONDS).toBe("${BACKUP_MAX_AGE_SECONDS:-129600}");
    expect(alertingEnv.REALERT_SECONDS).toBe("${REALERT_SECONDS:-21600}");
  });
});
