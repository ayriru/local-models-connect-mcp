import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export type Protocol = "openai-chat" | "openai-responses" | "anthropic";

export interface ModelProfile {
  id: string;
  name: string;
  capabilities?: string[];
  hint?: string;
  priority?: number;
  profile: Record<string, unknown>;
  messages?: { role: string; content: string }[];
}

export interface ProviderConfig {
  name: string;
  enable: boolean;
  description?: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
  profile: Record<string, unknown>;
  autoSelectLoaded?: boolean;
  models: Record<string, ModelProfile>;
}

export interface Config {
  configPath: string;
  configFileLoaded: boolean;
  configError?: string;
  providers: Record<string, ProviderConfig>;
  requestTimeoutMs: number;
}

const PROTOCOLS: Record<string, Protocol> = {
  "openai-responses": "openai-responses",
  "openai-chat": "openai-chat",
  anthropic: "anthropic",
};

function toBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["true", "yes", "1", "on"].includes(v.toLowerCase());
  return fallback;
}

function resolveApiKey(value: string): string | undefined {
  if (value.startsWith("file:")) {
    try {
      return readFileSync(value.slice("file:".length), "utf8").trim();
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("env:")) return process.env[value.slice("env:".length)];
  return value || undefined;
}

function interpolateEnv(value: string): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => process.env[name] ?? match);
}

function parseHeaders(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const line = String(item);
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = interpolateEnv(line.slice(idx + 1).trim());
  }
  return out;
}

function parseModels(
  raw: Record<string, unknown> | undefined,
  providerName: string,
): Record<string, ModelProfile> {
  const models: Record<string, ModelProfile> = {};
  if (!raw) return models;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const m = value as Record<string, unknown>;
    const profile = (m.profile ?? {}) as Record<string, unknown>;
    models[key] = {
      id: (m.id as string | undefined) ?? key,
      name: (m.name as string | undefined) ?? key,
      capabilities: Array.isArray(m.capabilities)
        ? (m.capabilities as string[])
        : typeof m.capabilities === "string"
          ? m.capabilities.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
      hint: m.hint as string | undefined,
      priority: typeof m.priority === "number" ? m.priority : 0,
      profile,
      messages: Array.isArray(m.messages) ? (m.messages as { role: string; content: string }[]) : undefined,
    };
  }
  return models;
}

const RESERVED_PROVIDER_KEYS = new Set([
  "enable",
  "description",
  "protocol",
  "base_url",
  "api_key",
  "headers",
  "profile",
  "auto_select_loaded",
]);

function parseProvider(name: string, raw: unknown): ProviderConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const rawProtocol = (p.protocol as string | undefined) ?? name;
  const protocol: Protocol = PROTOCOLS[rawProtocol.toLowerCase()] ?? "openai-chat";
  const modelEntries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p)) {
    if (!RESERVED_PROVIDER_KEYS.has(key)) modelEntries[key] = value;
  }
  return {
    name,
    enable: toBool(p.enable, true),
    description: p.description as string | undefined,
    protocol,
    baseUrl:
      (p.base_url as string | undefined) ??
      (protocol === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
    apiKey: typeof p.api_key === "string" ? resolveApiKey(p.api_key) : undefined,
    headers: parseHeaders(p.headers),
    profile: (p.profile ?? {}) as Record<string, unknown>,
    autoSelectLoaded: typeof p.auto_select_loaded === "boolean" ? p.auto_select_loaded : true,
    models: parseModels(modelEntries, name),
  };
}

function resolveConfigPath(): string {
  const fromArg = process.argv.find((a) => a.startsWith("--config="));
  if (fromArg) return fromArg.slice("--config=".length);
  if (process.env.LMCP_CONFIG) return process.env.LMCP_CONFIG;
  return join(homedir(), ".config", "local-models-connect", "config.toml");
}

export function loadConfig(): Config {
  const configPath = resolveConfigPath();
  let file: Record<string, unknown> = {};
  let configError: string | undefined;
  try {
    const raw = readFileSync(configPath, "utf8");
    file = parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      configError = undefined;
    } else {
      configError = `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, raw] of Object.entries(file)) {
    const provider = parseProvider(name, raw);
    if (provider) providers[name] = provider;
  }
  return {
    configPath,
    configFileLoaded: Object.keys(file).length > 0,
    configError,
    providers,
    requestTimeoutMs: Number(process.env.LMCP_REQUEST_TIMEOUT_MS ?? 120_000),
  };
}

export const config = loadConfig();
