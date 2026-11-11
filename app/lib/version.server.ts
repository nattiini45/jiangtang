import packageJson from "../../package.json";
import { readConfig } from "~/lib/config.server";

export const buildInfo = {
  version: packageJson.version,
  commit: readConfig("APP_COMMIT"),
};
