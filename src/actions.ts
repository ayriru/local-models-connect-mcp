import { z } from "zod";
import * as client from "./client.js";
import { config, type ModelProfile, type ProviderConfig } from "./config.js";

export interface Action {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  params: z.ZodType;
  execute: (params: any) => Promise<unknown>;
}

function resolveProvider(name: string): ProviderConfig {
  const provider = config.providers[name];
  if (!provider) {
    throw new Error(
      `Provider "${name}" not found. Configured providers: ${Object.keys(config.providers).join(", ") || "(none)"}`,
    );
  }
  if (!provider.enable) {
    throw new Error(`Provider "${name}" is disabled in config.toml (enable = true)`);
  }
  return provider;
}

function resolveOrSingleProvider(name?: string): ProviderConfig {
  if (name) return resolveProvider(name);
  const enabled = Object.values(config.providers).filter((p) => p.enable);
  if (enabled.length === 1) return enabled[0];
  if (enabled.length === 0) {
    throw new Error("No providers are enabled in config.toml (enable = true)");
  }
  throw new Error(
    `Multiple providers are enabled, please specify one: ${enabled.map((p) => p.name).join(", ")}`,
  );
}

function resolveModel(provider: ProviderConfig, model?: string): ModelProfile {
  if (model && provider.models[model]) return provider.models[model];
  if (model) return { id: model, name: model, profile: {} };
  const first = Object.values(provider.models)[0];
  if (first) return first;
  throw new Error(
    `Provider "${provider.name}" has no models configured. Add [${provider.name}.<model>] sections or pass a model id.`,
  );
}

function sortByPriority(models: ModelProfile[]): ModelProfile[] {
  return [...models].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

async function autoSelectModel(provider: ProviderConfig): Promise<ModelProfile> {
  const models = Object.values(provider.models);
  if (models.length === 0) {
    throw new Error(
      `Provider "${provider.name}" has no models configured. Add [${provider.name}.<model>] sections or pass a model id.`,
    );
  }
  if (provider.autoSelectLoaded === false || models.length <= 1) {
    return sortByPriority(models)[0];
  }
  const loadedIds = await client.getLoadedModelIds(provider);
  if (loadedIds && loadedIds.size > 0) {
    const loaded = sortByPriority(models.filter((m) => loadedIds.has(m.id)));
    if (loaded.length > 0) return loaded[0];
  }
  return sortByPriority(models)[0];
}

export const listModelsParams = z.object({
  provider: z
    .string()
    .optional()
    .describe("Provider key from config.toml (e.g. unsloth). Omit for all enabled providers"),
});

export const chatParams = z.object({
  provider: z
    .string()
    .optional()
    .describe(
      "Provider key from config.toml (e.g. unsloth). Omit when only one provider",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model key from config.toml (e.g. ornith) or raw model id. Omit to auto-pick a loaded model",
    ),
      messages: z.array(
        z.object({
          role: z.enum(["system", "user", "assistant"]),
          content: z
            .union([
              z.string(),
              z.array(
                z.union([
                  z.object({ type: z.literal("text"), text: z.string() }),
                  z.object({
                    type: z.literal("image_url"),
                    image_url: z.object({
                      url: z
                        .string()
                        .describe("Local file path | data: URL | http(s) URL"),
                    }),
                  }),
                ]),
              ),
            ])
            .describe("String, or parts: [{type:'text',text},{type:'image_url',image_url:{url}}]"),
        }),
        { message: "messages must be a JSON array, e.g. [{role:'user',content:'hi'}] (not a string)" },
      )
      .optional()
      .describe("History: [{role, content}], e.g. [{role:'user','content':'hi'}]. Omit to use the model's configured messages"),
  profile: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Generation overrides, e.g. {temperature:0.7, max_tokens:4096}"),
  scenario: z
    .string()
    .optional()
    .describe(
      "'chat'|'vision'. Auto: vision if images present, else chat",
    ),
  profile_key: z
    .string()
    .optional()
    .describe("Deprecated, use scenario"),
});

const actions: Action[] = [
  {
    id: "list_models",
    name: "List models of providers",
    description:
      "List the models configured in config.toml, grouped by provider (with metadata), plus models from each provider's API. Use this when you need to know which providers/models are available and their capabilities before chatting.",
    keywords: [
      "list",
      "models",
      "provider",
      "available",
      "config",
      "列表",
      "模型",
      "服务商",
      "可用",
      "能力",
    ],
    params: listModelsParams,
    execute: async ({ provider: name }) => {
      const providers = name
        ? [resolveProvider(name)]
        : Object.values(config.providers).filter((p) => p.enable);
      const providersOut = await Promise.all(
        providers.map(async (provider) => {
          const models = Object.values(provider.models).map((m) => ({
            key: Object.keys(provider.models).find((k) => provider.models[k] === m),
            id: m.id,
            name: m.name,
            capabilities: m.capabilities ?? [],
            hint: m.hint ?? null,
            profile: m.profile,
            messagesCount: m.messages?.length ?? 0,
          }));
          let remote: unknown = null;
          try {
            remote = await client.listModels(provider);
          } catch (err) {
            remote = { error: err instanceof Error ? err.message : String(err) };
          }
          return {
            provider: provider.name,
            providerDescription: provider.description ?? null,
            protocol: provider.protocol,
            models,
            remote,
          };
        }),
      );
      return { providers: providersOut };
    },
  },
  {
    id: "chat",
    name: "Chat with a model",
    description:
      "Send a chat conversation (text or images) to a model of a configured provider. This is the only action needed for chatting, asking questions, image understanding (vision) and built-in tool use (web search / python). Provider and model are optional: provider defaults to the single enabled provider; model auto-selects a loaded one.",
    keywords: [
      "chat",
      "conversation",
      "llm",
      "generate",
      "ask",
      "model",
      "vision",
      "image",
      "聊天",
      "对话",
      "识图",
      "图片",
      "提问",
      "回答",
      "生成",
      "工具",
      "搜索",
      "网页",
      "联网",
    ],
    params: z.object({
      provider: z
        .string()
        .optional()
        .describe(
          "Provider key from config.toml (e.g. unsloth). Omit when only one provider",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Model key from config.toml (e.g. ornith) or raw model id. Omit to auto-pick a loaded model",
        ),
      messages: z
        .array(
          z.object({
            role: z.enum(["system", "user", "assistant"]),
            content: z
              .union([
                z.string(),
                z.array(
                  z.union([
                    z.object({ type: z.literal("text"), text: z.string() }),
                    z.object({
                      type: z.literal("image_url"),
                      image_url: z.object({
                        url: z
                          .string()
                          .describe("Local file path | data: URL | http(s) URL"),
                      }),
                    }),
                  ]),
                ),
              ])
              .describe("String, or parts: [{type:'text',text},{type:'image_url',image_url:{url}}]"),
          }),
          { message: "messages must be a JSON array, e.g. [{role:'user',content:'hi'}] (not a string)" },
        )
        .optional()
        .describe(
          "History: [{role, content}], e.g. [{role:'user','content':'hi'}]. Omit to use the model's configured messages",
        ),
      profile: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Generation overrides, e.g. {temperature:0.7, max_tokens:4096}"),
      scenario: z
        .string()
        .optional()
        .describe(
          "'chat'|'vision'. Auto: vision if images present, else chat",
        ),
      profile_key: z
        .string()
        .optional()
        .describe("Deprecated, use scenario"),
    }),
    execute: async ({ provider: name, model: modelKey, messages, profile, scenario, profile_key }) => {
      const provider = resolveOrSingleProvider(name);
      const model = modelKey ? resolveModel(provider, modelKey) : await autoSelectModel(provider);
      return client.chat(
        provider,
        model,
        messages ?? model.messages ?? [],
        (profile ?? {}) as Record<string, unknown>,
        scenario ?? profile_key,
      );
    },
  },
  {
    id: "status",
    name: "Show config status",
    description:
      "Show the loaded config file path and all providers with protocol, base URL and model counts. Use this to verify configuration loading (e.g. after editing config.toml) or to discover provider names before calling other actions. Never prints API keys.",
    keywords: [
      "status",
      "config",
      "health",
      "check",
      "providers",
      "settings",
      "状态",
      "配置",
      "健康",
      "检查",
    ],
    params: z.object({}),
    execute: async () => ({
      configPath: config.configPath,
      configFileLoaded: config.configFileLoaded,
      configError: config.configError ?? null,
      requestTimeoutMs: config.requestTimeoutMs,
      providers: Object.values(config.providers).map((p) => ({
        name: p.name,
        enable: p.enable,
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        description: p.description ?? null,
        apiKeyConfigured: Boolean(p.apiKey),
        headersCount: Object.keys(p.headers).length,
        models: Object.values(p.models).map((m) => ({
          key: Object.keys(p.models).find((k) => p.models[k] === m),
          id: m.id,
        })),
      })),
    }),
  },
];

export function getAction(id: string): Action | undefined {
  return actions.find((a) => a.id === id);
}

export function listActions(): Action[] {
  return actions;
}

export function searchActions(intent: string, limit = 10): Action[] {
  const tokens = intent
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fff]+/)
    .filter(Boolean);
  if (tokens.length === 0) return actions.slice(0, limit);
  const scored = actions
    .map((a) => {
      const haystack = `${a.id} ${a.name} ${a.keywords.join(" ")} ${a.description}`.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (a.id.includes(t)) score += 3;
        if (a.keywords.some((k) => k.includes(t) || t.includes(k))) score += 2;
        if (haystack.includes(t)) score += 1;
      }
      return { action: a, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.action);
}

export function describeParams(action: Action): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(action.params instanceof z.ZodObject)) {
    return { value: action.params.description ?? action.params.constructor.name };
  }
  for (const [key, schema] of Object.entries(action.params.shape)) {
    out[key] = schema.description ?? schema.constructor.name;
  }
  return out;
}

export interface ModelMatch {
  provider: string;
  modelKey: string;
  id: string;
  name: string;
  capabilities: string[];
  hint: string | null;
}

export function searchModels(intent: string, limit = 10): ModelMatch[] {
  const tokens = intent
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fff]+/)
    .filter(Boolean);
  const CAP_CN: Record<string, string[]> = {
    chat: ["聊天", "对话", "问答", "文本", "回复", "文字"],
    vision: ["识图", "图片", "图像", "看图", "视觉", "照片", "截图", "画面", "多模态"],
    streaming: ["流式", "流"],
    tools: ["工具", "搜索", "联网", "执行", "代码"],
  };
  const matches: { match: ModelMatch; score: number }[] = [];
  for (const provider of Object.values(config.providers)) {
    if (!provider.enable) continue;
    for (const [key, m] of Object.entries(provider.models)) {
      const haystack = [
        key,
        m.id,
        m.name,
        m.hint,
        ...(m.capabilities ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const words = new Set(
        haystack
          .split(/[^a-z0-9_\u4e00-\u9fff]+/)
          .filter((w) => w.length >= 2),
      );
      let score = 0;
      for (const t of tokens) {
        if (tokens.length > 0 && haystack.includes(t)) score += 1;
        if (m.capabilities?.some((c) => c.toLowerCase().includes(t))) score += 2;
        if (m.id.toLowerCase().includes(t) || m.name.toLowerCase().includes(t)) score += 2;
        if ([...words].some((w) => t.includes(w))) score += 2;
        for (const [cap, cn] of Object.entries(CAP_CN)) {
          if (m.capabilities?.includes(cap) && cn.some((w) => t.includes(w))) score += 3;
        }
      }
      if (score > 0) {
        matches.push({
          match: {
            provider: provider.name,
            modelKey: key,
            id: m.id,
            name: m.name,
            capabilities: m.capabilities ?? [],
            hint: m.hint ?? null,
          },
          score,
        });
      }
    }
  }
  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => m.match);
}
