/**
 * Runtime mode for the Express entry point. Only the exact value "development" gets
 * development behaviour (the Vite dev server, the dev admin seed, raw error messages,
 * the insecure dev storage key). Anything else, including an unset NODE_ENV, is
 * production. The caller writes `nodeEnv` back to the environment so every module
 * reads the same answer.
 *
 * Pure: it reads the environment it is given and changes nothing.
 */

export interface RuntimeMode {
  development: boolean;
  /** The value NODE_ENV holds for the rest of the process. */
  nodeEnv: "development" | "production";
  /** The Express `trust proxy` setting, or false to leave it unset. */
  trustProxy: number | false;
}

export function resolveRuntimeMode(env: NodeJS.ProcessEnv): RuntimeMode {
  if (env.NODE_ENV === "development") {
    return { development: true, nodeEnv: "development", trustProxy: false };
  }
  // Trust exactly one proxy hop: the Caddy container in front of the app. `true`
  // would trust every X-Forwarded-For entry a client supplies.
  return { development: false, nodeEnv: "production", trustProxy: 1 };
}
