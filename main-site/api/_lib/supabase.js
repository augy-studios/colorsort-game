// Supabase REST, server side only. SUPABASE_SERVICE_KEY bypasses RLS and
// must never reach a browser or a bot.

const TIMEOUT_MS = 8000;

export class UpstreamError extends Error {}

export function configured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

export async function rest(path, { method = "GET", body, prefer } = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
      method,
      signal: controller.signal,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new UpstreamError(`supabase ${res.status}: ${text.slice(0, 200)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export function rpc(name, args) {
  return rest(`rpc/${name}`, { method: "POST", body: args });
}
