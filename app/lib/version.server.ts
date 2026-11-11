import { readConfig } from "~/lib/config.server";
import packageJson from "../../package.json";

export const buildInfo = {
  version: packageJson.version,
  commit: readConfig("APP_COMMIT"),
};
