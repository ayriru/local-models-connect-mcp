import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { config, type ModelProfile, type ProviderConfig } from "./config.js";

async function request(
  provider: ProviderConfig,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...provider.headers,
  };
  if (provider.protocol === "anthropic") {
    if (!provider.apiKey) {
      throw new Error(`[${provider.name}] Anthropic API key not configured`);
    }
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider.apiKey) {
    headers["authorization"] = `Bearer ${provider.apiKey}`;
  }
  try {
    const res = await fetch(`${provider.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`[${provider.name}] ${res.status} ${res.statusText}: ${body}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function listModels(provider: ProviderConfig) {
  return provider.protocol === "anthropic"
    ? request(provider, "/v1/models")
    : request(provider, "/models");
}

const loadedCache = new Map<string, { ts: number; loadedIds: Set<string> }>();
const LOADED_CACHE_TTL_MS = 30_000;

export async function getLoadedModelIds(provider: ProviderConfig): Promise<Set<string> | null> {
  const cached = loadedCache.get(provider.name);
  if (cached && Date.now() - cached.ts < LOADED_CACHE_TTL_MS) return cached.loadedIds;
  try {
    const raw = await listModels(provider);
    const data = (raw as { data?: { id: string; loaded?: boolean }[] } | null)?.data;
    if (!Array.isArray(data)) return null;
    const loadedIds = new Set(data.filter((m) => m.loaded).map((m) => m.id));
    loadedCache.set(provider.name, { ts: Date.now(), loadedIds });
    return loadedIds;
  } catch {
    return null;
  }
}

const ANTHROPIC_PARAMS = new Set(["temperature", "top_p", "top_k", "max_tokens"]);

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function toDataUrl(path: string): string {
  const expanded = expandHome(path);
  const resolved = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
  const mime = MIME_BY_EXT[extname(resolved).toLowerCase()] ?? "image/jpeg";
  let b64: string;
  try {
    b64 = readFileSync(resolved).toString("base64");
  } catch {
    throw new Error(
      `image file not found: ${resolved} (from "${path}"${
        expanded !== path ? `, ~ expanded to ${homedir()}` : ""
      }; relative paths resolve against cwd ${process.cwd()}). ` +
        "Pass an absolute path, a data: URL or an http(s) URL.",
    );
  }
  return `data:${mime};base64,${b64}`;
}

function normalizeImageUrl(url: string): string {
  if (url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return toDataUrl(url);
}

type ChatMessage = { role: string; content: string | unknown[] };

function isGroupedProfile(layer: Record<string, unknown> | undefined): boolean {
  if (!layer) return false;
  const entries = Object.entries(layer);
  return (
    entries.length > 0 &&
    entries.every(
      ([, v]) => v !== null && typeof v === "object" && !Array.isArray(v),
    )
  );
}

function hasImage(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as { type?: string }[]).some(
        (part) => part && (part.type === "image_url" || part.type === "image"),
      ),
  );
}

function pickProfileLayer(
  layer: Record<string, unknown> | undefined,
  profileKey: string | undefined,
  hasImageMsg: boolean,
): Record<string, unknown> {
  if (!layer) return {};
  if (!isGroupedProfile(layer)) return layer;
  if (profileKey && layer[profileKey]) return layer[profileKey] as Record<string, unknown>;
  const autoKey = hasImageMsg ? "vision" : "chat";
  if (layer[autoKey]) return layer[autoKey] as Record<string, unknown>;
  const first = Object.keys(layer)[0];
  if (first) return layer[first] as Record<string, unknown>;
  return {};
}

async function normalizeMessages(provider: ProviderConfig, messages: ChatMessage[]) {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push(m);
      continue;
    }
    const parts: Record<string, unknown>[] = [];
    for (const p of m.content as { type: string; text?: string; image_url?: { url: string } }[]) {
      if (p.type === "text") {
        parts.push({ type: "text", text: p.text });
      } else if (p.type === "image_url") {
        const url = normalizeImageUrl(p.image_url!.url);
        if (provider.protocol === "anthropic") {
          const match = url.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
          parts.push({
            type: "image",
            source: {
              type: "base64",
              media_type: match ? match[1] : "image/jpeg",
              data: match ? match[2] : url,
            },
          });
        } else {
          parts.push({ type: "image_url", image_url: { url } });
        }
      }
    }
    out.push({ role: m.role, content: parts });
  }
  return out;
}

function stripReasoning(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripReasoning);
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (key === "reasoning" || key === "reasoning_content" || key === "chain_of_thought") continue;
    out[key] = stripReasoning(v);
  }
  if (Array.isArray(out.content)) {
    out.content = out.content.filter((b: unknown) => (b as { type?: string } | null)?.type !== "thinking");
  }
  if (Array.isArray(out.output)) {
    out.output = out.output.filter((it: unknown) => (it as { type?: string } | null)?.type !== "reasoning");
  }
  return out;
}

function emptyAssistantContent(raw: unknown): boolean {
  const any = raw as {
    choices?: { message?: { content?: unknown } }[];
    output?: { type?: string; content?: unknown }[];
    type?: string;
    content?: unknown;
  };
  if (any?.choices?.length) {
    const c = any.choices[0].message?.content;
    return c === undefined || c === null || c === "" || (Array.isArray(c) && c.length === 0);
  }
  if (Array.isArray(any?.output)) {
    const msgs = any.output.filter((o) => o?.type === "message");
    if (msgs.length === 0) return true;
    const c = msgs[0].content;
    return c === undefined || c === null || c === "" || (Array.isArray(c) && c.length === 0);
  }
  if (any?.type === "message") {
    const c = any.content;
    return c === undefined || c === null || c === "" || (Array.isArray(c) && c.length === 0);
  }
  return false;
}

async function retryDirectAnswer(
  provider: ProviderConfig,
  model: ModelProfile,
  msgs: ChatMessage[],
  genProfile: Record<string, unknown>,
): Promise<unknown | null> {
  const maxTokens = Math.max(Number(genProfile.max_tokens ?? 1024), 512);
  try {
    if (provider.protocol === "anthropic") {
      const body: Record<string, unknown> = {
        model: model.id,
        messages: msgs,
        max_tokens: maxTokens,
        stream: false,
        thinking: { type: "disabled" },
      };
      const systemMsgs = msgs.filter((m) => m.role === "system");
      if (systemMsgs.length > 0) body.system = systemMsgs.map((m) => m.content).join("\n");
      return await request(provider, "/v1/messages", { method: "POST", body: JSON.stringify(body) });
    }
    if (provider.protocol === "openai-responses") {
      return await request(provider, "/responses", {
        method: "POST",
        body: JSON.stringify({
          model: model.id,
          input: msgs,
          ...genProfile,
          enable_thinking: false,
          max_tokens: maxTokens,
          stream: false,
        }),
      });
    }
    return await request(provider, "/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: model.id,
        messages: msgs,
        ...genProfile,
        enable_thinking: false,
        max_tokens: maxTokens,
        stream: false,
      }),
    });
  } catch {
    return null;
  }
}

export async function chat(
  provider: ProviderConfig,
  model: ModelProfile,
  messages: ChatMessage[],
  callProfile: Record<string, unknown>,
  profileKey?: string,
) {
  const hasImageMsg = hasImage(messages);
  const providerProfile = pickProfileLayer(provider.profile, profileKey, hasImageMsg);
  const modelProfile = pickProfileLayer(model.profile, profileKey, hasImageMsg);
  const profile = { ...providerProfile, ...modelProfile, ...callProfile };
  const { include_reasoning, ...genProfile } = profile;
  const msgs = await normalizeMessages(provider, messages);
  let result: unknown;
  if (provider.protocol === "anthropic") {
    const systemMsgs = msgs.filter((m) => m.role === "system");
    const chatMsgs = msgs
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model: model.id,
      messages: chatMsgs,
      max_tokens: Number(genProfile.max_tokens ?? 1024),
      stream: false,
    };
    if (systemMsgs.length > 0) body.system = systemMsgs.map((m) => m.content).join("\n");
    for (const key of ANTHROPIC_PARAMS) {
      if (key in genProfile) body[key] = genProfile[key];
    }
    result = await request(provider, "/v1/messages", { method: "POST", body: JSON.stringify(body) });
  } else if (provider.protocol === "openai-responses") {
    result = await request(provider, "/responses", {
      method: "POST",
      body: JSON.stringify({ model: model.id, input: msgs, ...genProfile, stream: false }),
    });
  } else {
    result = await request(provider, "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: model.id, messages: msgs, ...genProfile, stream: false }),
    });
  }
  if (include_reasoning) return result;
  if (!emptyAssistantContent(result)) return stripReasoning(result);
  const retried = await retryDirectAnswer(provider, model, msgs, genProfile);
  if (retried) return stripReasoning(retried);
  return {
    ...(stripReasoning(result) as object),
    warning:
      "模型未输出最终内容（思考链可能耗尽了生成预算，或模型不支持 enable_thinking 参数）。" +
      "可手动传入 profile = { enable_thinking = false } 或提高 max_tokens。",
  };
}
