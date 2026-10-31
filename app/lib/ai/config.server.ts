/**
 * `readAiConfig(env)` — pure env → per-capability resolution.
 *
 * Resolution keys on the **base URL**, not the key — a keyless self-hosted
 * endpoint (vLLM/Ollama) is a valid `api` configuration. A base URL without a
 * model is `misconfigured`; nothing set is `none`. The dense column is
 * `vector(1024)` for the life of the database, so `EMBEDDING_DIMENSIONS` has a
 * default and exactly one other legal value: none.
 */
import { tr } from "~/i18n/request-locale.server";
import type { CapabilityStatus } from "./types";

export const EMBEDDING_DIMENSIONS = 1024;
export const DEFAULT_QUERY_TEMPLATE = "Instruct: {instruction}\nQuery:{text}";
/** Deploy-time constant; English on purpose. */
export const DEFAULT_QUERY_INSTRUCTION =
  "Given a search query in an AV and facility management workspace, retrieve the records that answer the query";
export const DEFAULT_PASSAGE_TEMPLATE = "{text}";
export const DEFAULT_GENERATION_MAX_TOKENS = 800;

type Env = Record<string, string | undefined>;

export interface EmbeddingConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
  dimensions: number;
  sendDimensions: boolean;
  queryTemplate: string;
  queryInstruction: string;
  passageTemplate: string;
}

export interface RerankerConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export type GenerationSystemRole = "system" | "merge";

export interface GenerationConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
  maxTokens: number;
  systemRole: GenerationSystemRole;
}

/** `api` carries the resolved config; the other two states carry why-not. */
export type CapabilityResolution<T> =
  | { state: "api"; config: T }
  | { state: "none" }
  | { state: "misconfigured"; detail: string };

export interface AiConfig {
  embedding: CapabilityResolution<EmbeddingConfig>;
  reranker: CapabilityResolution<RerankerConfig>;
  generation: CapabilityResolution<GenerationConfig>;
  statuses: CapabilityStatus[];
}

/** Env booleans: unset → default; "0"/"false"/"off"/"no" (any case) → false. */
function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

/** Host only — a base URL may carry credentials the logs must never print. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

/** Normalise a base URL: trims, requires http(s), strips trailing slashes. */
function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Shared shape of the rule: base URL present → needs a valid URL and a model;
 * base URL absent but other keys set → also misconfigured (a half-specified
 * capability); nothing set → none.
 */
function resolveEndpoint<T>(
  env: Env,
  prefix: string,
  extraKeys: string[],
  build: (base: { model: string; baseUrl: string; apiKey?: string }) => T | string,
): CapabilityResolution<T> {
  const rawBase = env[`${prefix}_BASE_URL`]?.trim();
  const model = env[`${prefix}_MODEL`]?.trim();
  const apiKey = env[`${prefix}_API_KEY`]?.trim() || undefined;
  const anySet = rawBase || model || apiKey || extraKeys.some((k) => env[k]?.trim());
  if (!anySet) return { state: "none" };
  if (!rawBase)
    return { state: "misconfigured", detail: tr("places.err.ai.baseUrlMissing", { prefix }) };
  const baseUrl = normalizeBaseUrl(rawBase);
  if (!baseUrl)
    return { state: "misconfigured", detail: tr("places.err.ai.baseUrlInvalid", { prefix }) };
  if (!model)
    return { state: "misconfigured", detail: tr("places.err.ai.modelMissing", { prefix }) };
  const built = build({ model, baseUrl, apiKey });
  if (typeof built === "string") return { state: "misconfigured", detail: built };
  return { state: "api", config: built };
}

function resolveEmbedding(env: Env): CapabilityResolution<EmbeddingConfig> {
  return resolveEndpoint(
    env,
    "EMBEDDING",
    ["EMBEDDING_DIMENSIONS", "EMBEDDING_SEND_DIMENSIONS"],
    (base) => {
      const rawDimensions = env.EMBEDDING_DIMENSIONS?.trim();
      const dimensions =
        rawDimensions === undefined || rawDimensions === ""
          ? EMBEDDING_DIMENSIONS
          : Number(rawDimensions);
      if (dimensions !== EMBEDDING_DIMENSIONS) {
        return tr("places.err.ai.dimensionsMismatch", { dimensions: EMBEDDING_DIMENSIONS });
      }
      const queryTemplate = env.EMBEDDING_QUERY_TEMPLATE?.trim() || DEFAULT_QUERY_TEMPLATE;
      const passageTemplate = env.EMBEDDING_PASSAGE_TEMPLATE?.trim() || DEFAULT_PASSAGE_TEMPLATE;
      for (const [name, tpl] of [
        ["EMBEDDING_QUERY_TEMPLATE", queryTemplate],
        ["EMBEDDING_PASSAGE_TEMPLATE", passageTemplate],
      ] as const) {
        if (!tpl.includes("{text}")) return tr("places.err.ai.templatePlaceholder", { name });
      }
      return {
        ...base,
        dimensions,
        sendDimensions: envBool(env.EMBEDDING_SEND_DIMENSIONS, true),
        queryTemplate,
        queryInstruction: env.EMBEDDING_QUERY_INSTRUCTION?.trim() || DEFAULT_QUERY_INSTRUCTION,
        passageTemplate,
      } satisfies EmbeddingConfig;
    },
  );
}

function resolveReranker(env: Env): CapabilityResolution<RerankerConfig> {
  return resolveEndpoint(env, "RERANK", [], (base) => base);
}

function resolveGeneration(env: Env): CapabilityResolution<GenerationConfig> {
  return resolveEndpoint(
    env,
    "GENERATION",
    ["GENERATION_MAX_TOKENS", "GENERATION_SYSTEM_ROLE"],
    (base) => {
      const rawMax = env.GENERATION_MAX_TOKENS?.trim();
      const maxTokens =
        rawMax === undefined || rawMax === "" ? DEFAULT_GENERATION_MAX_TOKENS : Number(rawMax);
      if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
        return "GENERATION_MAX_TOKENS ist keine positive Ganzzahl";
      }
      const rawRole = env.GENERATION_SYSTEM_ROLE?.trim().toLowerCase() || "system";
      if (rawRole !== "system" && rawRole !== "merge") {
        return tr("places.err.ai.systemRole");
      }
      return { ...base, maxTokens, systemRole: rawRole } satisfies GenerationConfig;
    },
  );
}

function statusOf<T>(
  capability: CapabilityStatus["capability"],
  r: CapabilityResolution<T>,
): CapabilityStatus {
  if (r.state !== "api")
    return {
      capability,
      state: r.state,
      detail: r.state === "misconfigured" ? r.detail : undefined,
    };
  const c = r.config as { model: string; baseUrl: string };
  return { capability, state: "api", model: c.model, host: hostOf(c.baseUrl) };
}

export function readAiConfig(env: Env): AiConfig {
  const embedding = resolveEmbedding(env);
  const reranker = resolveReranker(env);
  const generation = resolveGeneration(env);
  return {
    embedding,
    reranker,
    generation,
    statuses: [
      statusOf("embedding", embedding),
      statusOf("reranker", reranker),
      statusOf("generation", generation),
    ],
  };
}
