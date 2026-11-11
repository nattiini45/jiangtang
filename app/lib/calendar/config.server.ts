import { readConfig } from "~/lib/config.server";

export interface CalDavConfig {
  url: string;
  username: string;
  password: string;
}

export function getCalDavConfig(): CalDavConfig | null {
  const url = readConfig("CALDAV_URL");
  const username = readConfig("CALDAV_USERNAME");
  const password = readConfig("CALDAV_PASSWORD");
  if (!url || !username || !password) return null;
  return { url, username, password };
}

export function isCalendarConfigured(): boolean {
  return getCalDavConfig() !== null;
}
