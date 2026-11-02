/**
 * The public documentation set keeps its own links true.
 *
 * The corpus is the frozen public set: the root entry point, the contributor and agent guides, the
 * security contract, the third-party notices and the architecture, operator and reference guides
 * under `docs/`.
 * `LICENSE` and `NOTICE` are not Markdown, so they are checked for presence and content instead
 * of being parsed for links.
 *
 * What makes this a rot check rather than a mirror of the filesystem:
 *
 *  1. Negative controls. Synthetic fixtures prove that a missing required document, an empty
 *     required document, a case-wrong link, a repository escape and an undeclared external link
 *     all produce findings. A checker that cannot report a finding always passes.
 *  2. Case-exact resolution. Resolved through directory listings, not `existsSync`, because
 *     case-insensitive filesystems accept a wrong-case name that GitHub's renderer and CI's
 *     case-sensitive filesystem reject.
 *  3. Corpus-bound, not directory-bound. Only the declared public documents are scanned, so the
 *     test does not depend on any Markdown file outside the declared corpus.
 *  4. Closed external set. Every external reference is declared with a reason; a new one fails,
 *     and a declaration that no document uses fails too.
 *
 * This file reads documents only: it imports no database, environment or application module.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The frozen public Markdown corpus. Every entry must exist, case-exactly, and be non-empty. */
const CORPUS = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/ARCHITECTURE.md",
  "docs/DEPLOY.md",
  "docs/BACKUP.md",
  "docs/GDPR.md",
  "docs/conventions.md",
] as const;

/** Not Markdown: checked for presence and content, never parsed for links. */
const LEGAL_FILES = ["LICENSE", "NOTICE"] as const;

/** A public document nobody links to is unreachable; the README is the entry point. */
const REQUIRED_README_LINKS = [
  "docs/ARCHITECTURE.md",
  "AGENTS.md",
  "docs/DEPLOY.md",
  "docs/BACKUP.md",
  "docs/GDPR.md",
  "docs/conventions.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
] as const;

type ExternalDeclaration = { from: string; target: string; why: string };

/**
 * Links that leave the repository. Unverifiable from inside it, so each one is declared here with
 * its reason. A new external link fails this test; so does a declaration that no document uses.
 * Loopback examples (`http://localhost:…`) are documentation of local commands, not external
 * references, and are excluded by host in `extractExternalReferences`.
 */
const ALLOWED_EXTERNAL_LINKS: ReadonlyArray<ExternalDeclaration> = [
  {
    from: "README.md",
    target: "https://github.com/nattiini45/jiangtang.git",
    why: "the documented clone URL for the approved public repository",
  },
  {
    from: "SECURITY.md",
    target: "https://github.com/nattiini45/jiangtang/security/advisories/new",
    why: "the repository's private advisory form, named as the reporting target",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://github.com/shadcn-ui/ui",
    why: "upstream source for the vendored shadcn/ui components",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://www.apache.org/licenses/LICENSE-2.0",
    why: "canonical Apache License 2.0 text",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://www.postgresql.org/about/licence/",
    why: "PostgreSQL License source for PostgreSQL and pgvector",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://github.com/wal-g/wal-g/blob/master/LICENSE.md",
    why: "WAL-G license source",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://github.com/caddyserver/caddy/blob/master/LICENSE",
    why: "Caddy license source",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://github.com/rustfs/rustfs/blob/main/LICENSE",
    why: "RustFS license source",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://github.com/aws/aws-cli/blob/develop/LICENSE.txt",
    why: "AWS CLI license source",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://github.com/nodejs/node/blob/main/LICENSE",
    why: "Node.js license source",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://alpinelinux.org/",
    why: "Alpine Linux project and package license entry point",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://curl.se/docs/copyright.html",
    why: "curl license source",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://www.debian.org/legal/licenses/",
    why: "Debian license source",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://github.com/feathericons/feather",
    why: "Feather upstream, whose LICENSE carries the MIT copyright line for the lucide-react icons",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://github.com/lovell/sharp-libvips",
    why: "sharp-libvips upstream, whose THIRD-PARTY-NOTICES and versions.properties list the bundled LGPL components",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://www.gnu.org/licenses/lgpl-3.0.txt",
    why: "LGPL-3.0 text that redistributors of the libvips shared object must ship",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://www.gnu.org/licenses/gpl-3.0.txt",
    why: "GPL-3.0 text that the LGPL-3.0 terms refer to",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://github.com/parcel-bundler/lightningcss",
    why: "lightningcss upstream, the source for the MPL-2.0 platform binaries in the runtime image",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://github.com/browserslist/caniuse-lite",
    why: "caniuse-lite repository, named by its package metadata as the CC-BY-4.0 source",
  },
  {
    from: "THIRD_PARTY_NOTICES.md",
    target: "https://creativecommons.org/licenses/by/4.0/legalcode",
    why: "CC-BY-4.0 legal code that the caniuse-lite data is licensed under",
  },
];

type BrokenLink = {
  /** Repo-relative source document, POSIX separators. */
  from: string;
  /** The link exactly as written in the source. */
  target: string;
  /** Absolute resolved path, for a message a human can act on. */
  resolved: string;
  reason: "missing" | "case-mismatch" | "outside-repo";
  detail: string;
};

type ExternalUse = {
  /** Repo-relative source document, POSIX separators. */
  from: string;
  /** The external target exactly as written. */
  target: string;
  detail: string;
};

/** Markdown link targets, with code removed so an example in a fence is not a link. */
function extractTargets(markdown: string): string[] {
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");

  const targets: string[] = [];
  const link = /\[[^\]]*\]\(\s*<?([^)>\s]+)>?[^)]*\)/g;
  let match: RegExpExecArray | null;
  while ((match = link.exec(withoutCode)) !== null) {
    targets.push(match[1]);
  }
  return targets;
}

/** True for `http(s):`, `mailto:`, and any other scheme — none of which a repo-relative
 *  existence check can or should resolve. */
function isNonFileTarget(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

/** The file part of a link: no anchor, no query, percent-decoded. */
function targetPath(target: string): string {
  const bare = target.split("#")[0]?.split("?")[0] ?? "";
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

function isExternal(resolved: string, root: string): boolean {
  return resolved !== root && !resolved.startsWith(root + sep);
}

/**
 * Resolve `relativePath` segment by segment through directory listings, so the answer is
 * case-*exact* on every platform. Returns which kind of failure occurred, if any.
 */
function resolveExact(
  startDir: string,
  relativePath: string,
): { ok: true } | { ok: false; reason: "missing" | "case-mismatch"; detail: string } {
  let current = startDir;
  for (const segment of relativePath.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return { ok: false, reason: "missing", detail: `no such directory: ${current}` };
    }
    if (!entries.includes(segment)) {
      const actual = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
      return actual
        ? { ok: false, reason: "case-mismatch", detail: `on disk as \`${actual}\`` }
        : { ok: false, reason: "missing", detail: `no such file: ${join(current, segment)}` };
    }
    current = join(current, segment);
  }
  return { ok: true };
}

/**
 * Check one document. `root` is explicit rather than the module-level repository root so the
 * negative controls can drive this exact function over a fixture; a version that closed over
 * `REPO_ROOT` made every fixture link "outside the repository" and left the missing-file and
 * case-mismatch paths unexercised.
 */
function checkDocument(
  absolutePath: string,
  root: string = REPO_ROOT,
): { links: number; broken: BrokenLink[]; external: ExternalUse[] } {
  const markdown = readFileSync(absolutePath, "utf8");
  const fromDir = dirname(absolutePath);
  const from = relative(root, absolutePath).split(sep).join("/");

  const targets = extractTargets(markdown);
  const broken: BrokenLink[] = [];
  const external: ExternalUse[] = [];

  for (const target of targets) {
    // A bare `#anchor` stays inside the document; `/path` is site-absolute, not a repo file.
    if (target.startsWith("#") || target.startsWith("/")) continue;
    if (isNonFileTarget(target)) {
      external.push({ from, target, detail: "leaves the repository" });
      continue;
    }

    const path = targetPath(target);
    if (path === "") continue;

    const resolved = resolve(fromDir, path);
    if (isExternal(resolved, root)) {
      broken.push({
        from,
        target,
        resolved,
        reason: "outside-repo",
        detail: "resolves outside the repository root",
      });
      continue;
    }

    const outcome = resolveExact(fromDir, path);
    if (!outcome.ok) {
      broken.push({ from, target, resolved, reason: outcome.reason, detail: outcome.detail });
    }
  }

  return { links: targets.length, broken, external };
}

function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(hostname.toLowerCase());
}

/**
 * Every `http(s)` reference in a document, including URLs inside code fences: the documented
 * clone command is a real intended link even though it is fenced. Loopback hosts are local
 * command examples, not external references, so they are excluded.
 */
function extractExternalReferences(markdown: string): string[] {
  const found: string[] = [];
  const pattern = /https?:\/\/[^\s<>()[\]"'`]+/gi;
  for (const match of markdown.matchAll(pattern)) {
    const target = (match[0] ?? "").replace(/[.,;:!?]+$/, "");
    if (target === "") continue;
    try {
      if (isLoopbackHost(new URL(target).hostname)) continue;
    } catch {
      // An unparseable URL remains in the inventory: it must be declared or removed.
    }
    found.push(target);
  }
  return [...new Set(found)];
}

/** Which required public documents are absent, or present but empty. */
function requiredDocumentFindings(root: string): { missing: string[]; empty: string[] } {
  const missing: string[] = [];
  const empty: string[] = [];

  for (const document of [...CORPUS, ...LEGAL_FILES]) {
    const outcome = resolveExact(root, document);
    if (!outcome.ok) {
      missing.push(document);
      continue;
    }
    const absolute = resolve(root, document);
    try {
      if (!statSync(absolute).isFile()) {
        missing.push(document);
        continue;
      }
      if (readFileSync(absolute, "utf8").trim() === "") {
        empty.push(document);
      }
    } catch {
      missing.push(document);
    }
  }

  return { missing, empty };
}

type CorpusScan = {
  documents: number;
  missing: string[];
  links: number;
  broken: BrokenLink[];
  external: ExternalUse[];
  references: ExternalUse[];
};

/** Scan exactly the declared public corpus. Missing documents are reported, never skipped. */
function scanCorpus(root: string): CorpusScan {
  const missing: string[] = [];
  const broken: BrokenLink[] = [];
  const external: ExternalUse[] = [];
  const references: ExternalUse[] = [];
  let links = 0;
  let documents = 0;

  for (const document of CORPUS) {
    const outcome = resolveExact(root, document);
    if (!outcome.ok) {
      missing.push(document);
      continue;
    }
    const absolute = resolve(root, document);
    const result = checkDocument(absolute, root);
    documents += 1;
    links += result.links;
    broken.push(...result.broken);
    external.push(...result.external);
    for (const reference of extractExternalReferences(readFileSync(absolute, "utf8"))) {
      references.push({ from: document, target: reference, detail: "bare reference" });
    }
  }

  return { documents, missing, links, broken, external, references };
}

function externalKey(use: { from: string; target: string }): string {
  return `${use.from} -> ${use.target}`;
}

/** External uses that no declaration covers. Empty means every external reference is approved. */
function undeclaredExternal(
  uses: ReadonlyArray<{ from: string; target: string }>,
  declarations: ReadonlyArray<ExternalDeclaration>,
): string[] {
  const declared = new Set(declarations.map(externalKey));
  return [...new Set(uses.map(externalKey))].filter((key) => !declared.has(key)).sort();
}

function describeBroken(broken: BrokenLink[]): string {
  return broken.map((f) => `  ${f.from} -> ${f.target}\n      ${f.reason}: ${f.detail}`).join("\n");
}

function describeKeys(keys: string[]): string {
  return keys.map((key) => `  ${key}`).join("\n");
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

describe("public documentation links", () => {
  it("declares the frozen public corpus and the legal files", () => {
    expect(CORPUS).toEqual([
      "README.md",
      "CONTRIBUTING.md",
      "AGENTS.md",
      "SECURITY.md",
      "THIRD_PARTY_NOTICES.md",
      "docs/ARCHITECTURE.md",
      "docs/DEPLOY.md",
      "docs/BACKUP.md",
      "docs/GDPR.md",
      "docs/conventions.md",
    ]);
    expect(LEGAL_FILES).toEqual(["LICENSE", "NOTICE"]);
    expect(REQUIRED_README_LINKS).toHaveLength(CORPUS.length - 1 + LEGAL_FILES.length);
  });

  it("every required public document exists case-exactly and is non-empty", () => {
    const { missing, empty } = requiredDocumentFindings(REPO_ROOT);
    expect(missing, `missing public documents:\n${describeKeys(missing)}`).toEqual([]);
    expect(empty, `empty public documents:\n${describeKeys(empty)}`).toEqual([]);
  });

  it("every relative link in the public corpus resolves case-exactly", () => {
    const scan = scanCorpus(REPO_ROOT);
    expect(scan.missing, `missing public documents:\n${describeKeys(scan.missing)}`).toEqual([]);
    expect(scan.documents).toBe(CORPUS.length);
    // If the extractor ever stops matching, this is what notices — not a green run over zero
    // links.
    expect(scan.links).toBeGreaterThan(0);
    expect(scan.broken, `unresolved links:\n${describeBroken(scan.broken)}`).toEqual([]);
  });

  it("README links to every public guide, license and notice", () => {
    const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");
    const targets = new Set(extractTargets(readme));
    expect(targets.size).toBeGreaterThan(0);
    const missing = REQUIRED_README_LINKS.filter((link) => !targets.has(link));
    expect(missing, `README does not link to:\n${describeKeys(missing)}`).toEqual([]);
  });

  it("every external reference is declared and every declaration is used", () => {
    const scan = scanCorpus(REPO_ROOT);
    const used = new Set([...scan.external, ...scan.references].map(externalKey));
    const declared = new Set(ALLOWED_EXTERNAL_LINKS.map(externalKey));

    const undeclared = [...used].filter((key) => !declared.has(key)).sort();
    const stale = [...declared].filter((key) => !used.has(key)).sort();

    expect(undeclared, `undeclared external links:\n${describeKeys(undeclared)}`).toEqual([]);
    expect(stale, `declared external links no document uses:\n${describeKeys(stale)}`).toEqual([]);
    expect(
      ALLOWED_EXTERNAL_LINKS.every((entry) => entry.why.trim().length > 0),
      "every external declaration needs a reason",
    ).toBe(true);
  });

  it("fails when a required document is missing or case-wrong (negative control)", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "doc-corpus-missing-"));
    try {
      for (const document of CORPUS) {
        if (document === "SECURITY.md") continue;
        writeFixture(fixtureRoot, document, `# ${document}\n`);
      }
      // A case-insensitive filesystem would resolve this name for `SECURITY.md`; the directory
      // listing must not.
      writeFixture(fixtureRoot, "security.md", "# lower-case impostor\n");
      for (const legal of LEGAL_FILES) writeFixture(fixtureRoot, legal, "fixture\n");

      const { missing, empty } = requiredDocumentFindings(fixtureRoot);
      expect(missing).toEqual(["SECURITY.md"]);
      expect(empty).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails when a required document is empty (negative control)", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "doc-corpus-empty-"));
    try {
      for (const document of CORPUS) {
        writeFixture(
          fixtureRoot,
          document,
          document === "docs/GDPR.md" ? " \n\t\n" : `# ${document}\n`,
        );
      }
      for (const legal of LEGAL_FILES) writeFixture(fixtureRoot, legal, "fixture\n");

      const { missing, empty } = requiredDocumentFindings(fixtureRoot);
      expect(missing).toEqual([]);
      expect(empty).toEqual(["docs/GDPR.md"]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails on missing, case-wrong and escaping links, and ignores code (negative control)", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "doc-links-"));
    try {
      const source = join(fixtureRoot, "source.md");
      writeFixture(fixtureRoot, "sibling.md", "# present\n");
      writeFileSync(
        source,
        [
          "# fixture",
          "",
          "A real link: [sibling](sibling.md)",
          "A missing one: [gone](does-not-exist.md)",
          "A case-mismatched one: [cased](Sibling.MD)",
          "A repository escape: [up](../../outside.md)",
          "Not a link, inside a fence:",
          "",
          "```md",
          "[fenced](also-missing.md)",
          "```",
          "",
          "Not a link, inline: `[inline](nope.md)`",
          "An external URL: [x](https://example.com/nope.md)",
          "A bare anchor: [self](#top)",
        ].join("\n"),
      );

      const { broken, external } = checkDocument(source, fixtureRoot);
      const byTarget = new Map(broken.map((finding) => [finding.target, finding.reason]));

      expect(byTarget.get("does-not-exist.md")).toBe("missing");
      expect(byTarget.get("Sibling.MD")).toBe("case-mismatch");
      expect(byTarget.get("../../outside.md")).toBe("outside-repo");
      // The fenced and inline examples must not become findings — an extractor that counts code
      // as links is a different kind of broken.
      expect(broken.map((finding) => finding.target).sort()).toEqual([
        "../../outside.md",
        "Sibling.MD",
        "does-not-exist.md",
      ]);
      expect(external.map((use) => use.target)).toEqual(["https://example.com/nope.md"]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails on an undeclared external link and passes when declared (negative control)", () => {
    const use = {
      from: "source.md",
      target: "https://example.com/nope.md",
      detail: "fixture",
    };

    expect(undeclaredExternal([use], [])).toEqual(["source.md -> https://example.com/nope.md"]);
    expect(
      undeclaredExternal(
        [use],
        [{ from: "source.md", target: "https://example.com/nope.md", why: "fixture declaration" }],
      ),
    ).toEqual([]);
  });
});
