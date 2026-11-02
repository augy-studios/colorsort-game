// Request plumbing shared by every endpoint: input checks and replies.

import { configured, UpstreamError } from "./supabase.js";

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// The random id a browser generates once and keeps in local storage.
export function clientKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) throw new HttpError(400, "bad_client_key");
  return key;
}

// A uuid, as runs and plays are keyed.
export function uuid(value, code = "bad_id") {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new HttpError(400, code);
  }
  return id;
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new HttpError(400, "bad_json");
    }
  }
  return {};
}

// Wraps a handler: method check, no caching of anything personal, and one
// shape for every error.
export function endpoint(method, handler) {
  return async (req, res) => {
    if (req.method !== method) {
      res.setHeader("Allow", method);
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    if (!configured()) {
      res.status(503).json({ error: "not_configured" });
      return;
    }
    if (method !== "GET") res.setHeader("Cache-Control", "no-store");

    try {
      const result = await handler({ req, res, body: body(req) });
      if (!res.headersSent) res.status(200).json(result);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.code, message: err.message !== err.code ? err.message : undefined, ...err.extra });
        return;
      }
      console.error(err);
      const upstream = err instanceof UpstreamError || err.name === "AbortError";
      res.status(upstream ? 502 : 500).json({ error: upstream ? "upstream" : "server" });
    }
  };
}
