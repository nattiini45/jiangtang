import packageJson from "../../package.json";

export const buildInfo = {
  version: packageJson.version,
  commit: process.env.APP_COMMIT || "unknown",
};
