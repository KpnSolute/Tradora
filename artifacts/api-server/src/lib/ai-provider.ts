/**
 * OpenAI-compatible chat client for the AI rule builder.
 *
 * Four providers speak the same wire format, so the draft pipeline is identical
 * for all of them; only the base URL, the key env var and the model allowlist
 * differ:
 *
 *   openrouter (default)  OPENROUTER_API_KEY   https://openrouter.ai/api/v1
 *   openai                OPENAI_API_KEY       https://api.openai.com/v1
 *   freebuff              OPENAI_API_KEY       https://freebuff.com/api/v1/paid
 *   mock                  MOCK_MODEL_API_KEY   http://127.0.0.1:4319/v1  (scripts/mock-model-server.mjs)
 *
 * This module is deliberately dependency-free (no express, db or logger) so the
 * keyless test harness in scripts/test-rule-builder.mjs can import it directly.
 */

export type ProviderName = "openrouter" | "openai" | "freebuff" | "mock";

export const PROVIDER_NAMES: ProviderName[] = ["openrouter", "openai", "freebuff", "mock"];

interface ProviderSpec {
  /** Env var holding a base-URL override (e.g. a proxy or a self-hosted gateway). */
  baseUrlEnv: string;
  defaultBaseUrl: string;
  /** Env vars checked, in order, for the API key. */
  keyEnvs: string[];
  defaultModel: string;
  /** Server-side allowlist — the browser can never choose a model. */
  allowedModels: string[];
  /** Extra headers some gateways require for attribution/rate limits. */
  headers?: (env: Env) => Record<string, string>;
}

type Env = Record<string, string | undefined>;

const SPECS: Record<ProviderName, ProviderSpec> = {
  openrouter: {
    baseUrlEnv: "OPENROUTER_BASE_URL",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    keyEnvs: ["OPENROUTER_API_KEY"],
    defaultModel: "openai/gpt-4o-mini",
    allowedModels: [
      "openai/gpt-4o-mini",
      "openai/gpt-4.1-mini",
      "anthropic/claude-3.5-haiku",
      "google/gemini-2.0-flash-001",
    ],
    // OpenRouter attributes traffic by referer/title; these are public values.
    headers: (env) => ({
      "HTTP-Referer": env.OPENROUTER_SITE_URL ?? env.APP_ORIGIN ?? "https://tradora.kpnsolute.com",
      "X-Title": "Tradora",
    }),
  },
  openai: {
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyEnvs: ["OPENAI_API_KEY"],
    defaultModel: "gpt-4o-mini",
    allowedModels: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"],
  },
  freebuff: {
    // Historical default. Kept so an existing deployment that only sets
    // OPENAI_API_KEY keeps working without new configuration.
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://freebuff.com/api/v1/paid",
    keyEnvs: ["OPENAI_API_KEY"],
    defaultModel: "gpt-4o-mini",
    allowedModels: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"],
  },
  mock: {
    baseUrlEnv: "MOCK_MODEL_BASE_URL",
    defaultBaseUrl: "http://127.0.0.1:4319/v1",
    keyEnvs: ["MOCK_MODEL_API_KEY"],
    defaultModel: "mock/rule-draft",
    allowedModels: ["mock/rule-draft"],
  },
};

export interface ResolvedProvider {
  name: ProviderName;
  /** Full chat-completions URL. */
  chatUrl: string;
  /** Host + path only — safe to log and safe to return to the browser. */
  endpoint: string;
  apiKey: string;
  /** Name of the env var the key comes from (never the value). */
  keyEnv: string;
  configured: boolean;
  model: string;
  extraHeaders: Record<string, string>;
}

function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, "");
}

/** Provider selection: explicit env var, else inferred from which key is present. */
export function resolveProviderName(env: Env = process.env): ProviderName {
  const explicit = (env.RULE_BUILDER_PROVIDER ?? "").trim().toLowerCase();
  if ((PROVIDER_NAMES as string[]).includes(explicit)) return explicit as ProviderName;

  if (env.OPENROUTER_API_KEY) return "openrouter";
  if (env.OPENAI_API_KEY) {
    const base = (env.OPENAI_BASE_URL ?? "").toLowerCase();
    if (base.includes("freebuff.com")) return "freebuff";
    // Any other custom base URL is an OpenAI-compatible endpoint; name it openai.
    return "openai";
  }
  if (env.MOCK_MODEL_BASE_URL) return "mock";
  return "openrouter";
}

/**
 * `OPENAI_CHAT_PATH` predates the multi-provider support and stays honoured so
 * an existing deployment's configuration is not silently ignored.
 */
function resolveChatPath(env: Env): string {
  const raw = env.RULE_BUILDER_CHAT_PATH ?? env.OPENAI_CHAT_PATH;
  if (raw === "") return "";
  const path = raw ?? "/chat/completions";
  return path.startsWith("/") ? path : `/${path}`;
}

export function resolveChatUrl(name: ProviderName, env: Env = process.env): string {
  const spec = SPECS[name];
  const base = normalizeBase(env[spec.baseUrlEnv] || spec.defaultBaseUrl);
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}${resolveChatPath(env)}`;
}

function endpointLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "invalid base URL";
  }
}

export function resolveProvider(env: Env = process.env, forced?: ProviderName): ResolvedProvider {
  const name = forced ?? resolveProviderName(env);
  const spec = SPECS[name];
  const keyEnv = spec.keyEnvs[0];
  const apiKey = spec.keyEnvs.map(k => env[k]).find(v => Boolean(v && v.trim()))?.trim() ?? "";
  const requested = (env.RULE_BUILDER_MODEL ?? "").trim();
  const model = spec.allowedModels.includes(requested) ? requested : spec.defaultModel;
  const chatUrl = resolveChatUrl(name, env);

  return {
    name,
    chatUrl,
    endpoint: endpointLabel(chatUrl),
    apiKey,
    keyEnv,
    configured: apiKey !== "",
    model,
    extraHeaders: spec.headers?.(env) ?? {},
  };
}

// ─── Upstream transport ──────────────────────────────────────────────────────

export interface UpstreamResult {
  ok: boolean;
  status: number;
  body: any;
  timedOut?: boolean;
  networkError?: string;
  streamed?: boolean;
}

/** Accept the response shapes OpenAI-compatible gateways actually return. */
export function extractContent(body: any): string | null {
  const message = body?.choices?.[0]?.message;
  if (typeof message?.content === "string" && message.content.trim() !== "") return message.content;
  if (Array.isArray(message?.content)) {
    const joined = message.content
      .map((part: any) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
    if (joined.trim() !== "") return joined;
  }
  if (typeof body?.output_text === "string" && body.output_text.trim() !== "") return body.output_text;
  return null;
}

/** Pull a human-readable reason out of an OpenAI-compatible error envelope. */
export function upstreamMessage(body: any): string {
  const msg =
    body?.error?.message ??
    body?.message ??
    body?.error?.code ??
    (typeof body === "string" ? body : "");
  return String(msg ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Some gateways stream regardless of `stream: false`. Fold an SSE body back into
 * a single chat-completions shape so the caller sees one code path.
 */
export function foldSse(raw: string): any | null {
  const chunks = raw.split(/\r?\n/).filter(line => line.startsWith("data:"));
  if (chunks.length === 0) return null;

  let content = "";
  let sawJson = false;
  for (const line of chunks) {
    const payload = line.replace(/^data:\s*/, "").trim();
    if (payload === "" || payload === "[DONE]") continue;
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    sawJson = true;
    const piece = event?.choices?.[0]?.delta?.content ?? event?.choices?.[0]?.message?.content;
    if (typeof piece === "string") content += piece;
  }
  if (!sawJson) return null;
  return { choices: [{ message: { content } }], streamed: true };
}

/** Models often wrap JSON in a markdown fence; strip it before parsing. */
export function parseDraftJson(content: string): any {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

export async function callChat(
  provider: ResolvedProvider,
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<UpstreamResult> {
  try {
    const res = await fetch(provider.chatUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${provider.apiKey}`,
        ...provider.extraHeaders,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text().catch(() => "");

    let body: any = null;
    let streamed = false;
    if (contentType.includes("text/event-stream") || raw.trimStart().startsWith("data:")) {
      body = foldSse(raw);
      streamed = body !== null;
    } else if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw.slice(0, 400);
      }
    }

    return { ok: res.ok, status: res.status, body, streamed };
  } catch (err: any) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, status: timedOut ? 504 : 502, body: null, timedOut, networkError: err?.message };
  }
}
