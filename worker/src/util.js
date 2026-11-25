export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { "content-type": "application/json", ...headers } });

export const now = () => Math.floor(Date.now() / 1000);

export function newId() {
  const rand = crypto.getRandomValues(new Uint8Array(4));
  return Date.now().toString(36) + [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(data) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const SHA = /^[0-9a-f]{64}$/;
export const PROJECT = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function bearer(request) {
  const h = request.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

export async function body(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(env) {
  if (!env.SECRETS_KEY) throw new HttpError(500, "SECRETS_KEY is not set on the Tidegate worker");
  return crypto.subtle.importKey("raw", unb64(env.SECRETS_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), new TextEncoder().encode(text)));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function decrypt(env, stored) {
  const [iv, ct] = stored.split(".").map(unb64);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await key(env), ct));
}

/** Error lines in a run log, with numbers and quoted values blanked so the same failure groups across runs. */
export function problemLines(log) {
  const seen = new Set();
  for (const line of log.split("\n")) {
    // The exception line says what went wrong; the "Traceback (most recent call last):" header does not.
    if (/^\s*Traceback \(most recent call last\)/.test(line)) continue;
    if (!/(error|exception|failed|timed out|\b[45]\d\d\b.*(too many|forbidden|not found|unavailable))/i.test(line)) continue;
    seen.add(line.trim().slice(0, 300));
    if (seen.size >= 50) break;
  }
  return [...seen];
}

export const pattern = (line) => line.replace(/\b(?![45]\d\d\b)\d+(\.\d+)?\b/g, "#").replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").trim();
