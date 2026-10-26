// Calls to the server's HTTP API that are not about note content.

export class ApiError extends Error {
  constructor(
    public status: number,
    // Seconds to wait when rate limited.
    public retryAfter = 0,
  ) {
    super(`HTTP ${status}`);
  }
}

export interface DeviceCredentials {
  id: string;
  name: string;
  token: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

export async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  throw new ApiError(res.status, Number(res.headers.get("retry-after") ?? 0));
}

function json(token: string, body?: unknown): RequestInit {
  return {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export async function registerDevice(serverUrl: string, registrationToken: string, name: string): Promise<DeviceCredentials> {
  const res = await fetch(`${serverUrl}/api/devices`, { method: "POST", ...json(registrationToken, { name }) });
  return (await check(res)).json();
}

export async function listDevices(serverUrl: string, token: string): Promise<DeviceInfo[]> {
  return (await check(await fetch(`${serverUrl}/api/devices`, json(token)))).json();
}

export async function renameThisDevice(serverUrl: string, token: string, name: string): Promise<void> {
  await check(await fetch(`${serverUrl}/api/devices/current`, { method: "PATCH", ...json(token, { name }) }));
}

export async function revokeDevice(serverUrl: string, token: string, id: string): Promise<void> {
  await check(await fetch(`${serverUrl}/api/devices/${id}`, { method: "DELETE", ...json(token) }));
}
