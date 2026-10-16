/** Ask Jirani's API for its clock, time zone and resident name (GET /api/now next to /mcp). */
export async function fetchClock(
  mcpUrl: string,
  apiToken?: string,
): Promise<{ now: string; timeZone: string; residentName: string }> {
  const url = new URL('api/now', mcpUrl.replace(/mcp\/?$/, ''));
  const res = await fetch(url, apiToken ? { headers: { authorization: `Bearer ${apiToken}` } } : {});
  if (!res.ok) throw new Error(`GET ${url.pathname} failed: ${res.status}`);
  return (await res.json()) as { now: string; timeZone: string; residentName: string };
}
