import { CONFIG_REGISTRY, readRawConfig } from "~/lib/config.server";

export const ENVIRONMENT_VARIABLES = CONFIG_REGISTRY.filter((variable) => variable.about).map(
  ({ name, group, expectedUnset }) => ({ name, group, expectedUnset }),
);

export function environmentStatus() {
  return ENVIRONMENT_VARIABLES.map((variable) => ({
    ...variable,
    set: Boolean(readRawConfig(variable.name)),
  }));
}
