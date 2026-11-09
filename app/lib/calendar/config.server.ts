export interface CalDavConfig {
  url: string;
  username: string;
  password: string;
}

export function getCalDavConfig(): CalDavConfig | null {
  const url = process.env.CALDAV_URL?.trim();
  const username = process.env.CALDAV_USERNAME?.trim();
  const password = process.env.CALDAV_PASSWORD;
  if (!url || !username || !password) return null;
  return { url, username, password };
}

export function isCalendarConfigured(): boolean {
  return getCalDavConfig() !== null;
}
