#!/usr/bin/env node
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  type Action,
  chatParams,
  getAction,
  listActions,
  listModelsParams,
  searchActions,
  searchModels,
  describeParams,
} from "./actions.js";
import { config } from "./config.js";

const server = new McpServer(
  { name: "local-models-connect-mcp", version: "0.1.0" },
  {
    instructions:
      "local-models MCP server: access local models (e.g. Unsloth Studio) ONLY via this server's tools - never call provider HTTP APIs, never import local-models as a library. Every tool call takes exactly one input object: toolName({ ... }) or toolName({}) (host syntax varies, e.g. tools['local-models'].chat in opencode). Tools: chat (text/image chat, Q&A, vision, built-in web_search/python. Params: provider? | model? auto-picks loaded | messages: [{role, content: string or [{type:'text',text},{type:'image_url',image_url:{url}}]}] url=path|data:|http(s) | profile? e.g. {max_tokens:4096} | scenario? 'chat'|'vision' auto), list_models (provider?; keys, capabilities, loaded state - call before choosing a model), status ({}; config info), search_actions ({intent, limit?}; discover actions/models), execute_action ({action, params?}; generic entry for action ids from search_actions). Notes: first call 10-15s+ (model reload); results are JSON strings, answer at choices[0].message.content; thinking stripped by default (profile {include_reasoning:true} keeps); max_tokens cap 4096; never print API keys.",
  },
);
server.registerTool(
  "chat",
  {
    description:
      "Chat with a local model: text/image Q&A, vision, built-in web_search/python. Params: provider? (defaults to single enabled) | model? (auto-picks loaded) | messages: [{role, content}] (content: string or parts [{type:'text',text},{type:'image_url',image_url:{url}}]; url: path|data:|http(s)) | profile? (overrides, e.g. {max_tokens:4096}) | scenario? ('chat'|'vision', auto). All model access goes through this tool.",
    inputSchema: chatParams,
  },
  async (params) => {
    const action = getAction("chat")!;
    return runAction(action, params);
  },
);

server.registerTool(
  "list_models",
  {
    description:
      "List models: configured (key, id, name, capabilities, hint) + API models with loaded state. Params: provider? (omit for all).",
    inputSchema: listModelsParams,
  },
  async (params) => runAction(getAction("list_models")!, params),
);

server.registerTool(
  "status",
  {
    description:
      "Config status: file path, providers (protocol, base URL, model counts). Params: none. Never prints API keys.",
  },
  async () => runAction(getAction("status")!, {}),
);

server.registerTool(
  "search_actions",
  {
    description:
      "Discover actions/models by intent. Params: intent (what you want to do), limit? (1-50, default 10).",
    inputSchema: {
      intent: z.string().describe("What you want to do"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results (default 10)"),
    },
  },
  async ({ intent, limit }) => {
    const actions = searchActions(intent, limit ?? 10).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      params: describeParams(a),
    }));
    const models = searchModels(intent, limit ?? 10);
    const payload = { query: intent, actions, models };
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(payload, null, 2) },
      ],
    };
  },
);

async function runAction(
  action: Action,
  params: unknown,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    const result = await action.execute((params ?? {}) as never);
    const text =
      typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text" as const, text }] };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Action ${action.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

server.registerTool(
  "execute_action",
  {
    description:
      "Run an action by id. Params: action (id from search_actions), params? (per action schema). Generic entry; common actions are the chat/list_models/status tools.",
    inputSchema: {
      action: z.string().describe("Action id (e.g. chat)"),
      params: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("Action params (schema from search_actions)"),
    },
  },
  async ({ action, params }) => {
    const found = getAction(action);
    if (!found) {
      const candidates = listActions().filter(
        (a) =>
          a.id.includes(action) ||
          action.includes(a.id) ||
          a.keywords.some((k) => action.includes(k) || k.includes(action)),
      );
      const hint = candidates.length
        ? ` Did you mean: ${candidates.map((a) => a.id).join(", ")}?`
        : ` Use search_actions to discover the available actions.`;
      return {
        content: [
          { type: "text" as const, text: `Unknown action: ${action}.${hint}` },
        ],
        isError: true,
      };
    }
    const parsed = found.params.safeParse(params);
    if (!parsed.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Invalid params for ${action}: ${z.prettifyError(parsed.error)}`,
          },
        ],
        isError: true,
      };
    }
    return runAction(found, parsed.data);
  },
);

server.registerPrompt(
  "getting-started",
  {
    description: "Usage: tools, params, examples. Read when unsure how to use this server.",
  },
  async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `local-models MCP server usage.
Tools:
- chat: the ONLY way to talk to models. chat({provider?, model?, messages, profile?, scenario?}).
  messages: 'hello' | [{role:'user'|'assistant'|'system', content:'text' | [{type:'text',text:'...'},{type:'image_url',image_url:{url:'/path/img.png'|'data:...'|'https://...'}}]}].
  profile: {temperature?, max_tokens? (cap 4096), enable_thinking?, include_reasoning? (default false: thinking stripped), enable_tools?} etc.
  scenario: 'chat'|'vision' (auto: vision if images present).
- list_models: list_models({provider?}) - keys, capabilities, loaded state.
- status: status({}) - config info.
- search_actions: search_actions({intent, limit?}) - discover actions/models.
- execute_action: execute_action({action, params?}) - action ids from search_actions.
Notes: first call 10-15s+ (model reload); results are JSON strings - answer at choices[0].message.content; never print API keys.`,
        },
      },
    ],
  }),
);

server.registerPrompt(
  "vision",
  {
    description: "Image analysis: multimodal message format + params. Read to send images.",
  },
  async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Image analysis:
chat({messages:[{role:'user',content:[{type:'text',text:'Describe this image in Chinese'},{type:'image_url',image_url:{url:'/absolute/path/to/image.png'}}]}]})
- url: local file path | data: URL | http(s) URL.
- scenario 'vision' auto when images present (or pass scenario:'vision').
- First call 10-15s+ (model reload). Answer: choices[0].message.content.`,
        },
      },
    ],
  }),
);

server.registerResource(
  "Model directory",
  new ResourceTemplate("models://{provider}/{model}", {
    list: async () => ({
      resources: Object.entries(config.providers).flatMap(([pname, p]) =>
        Object.entries(p.models).map(([mkey, m]) => ({
          uri: `models://${pname}/${mkey}`,
          name: `${pname}/${m.name}`,
          description: m.hint ?? m.id,
          mimeType: "application/json",
        })),
      ),
    }),
  }),
  { mimeType: "application/json" },
  async (uri, variables) => {
    const provider = config.providers[variables.provider as string];
    const model = provider?.models[variables.model as string];
    if (!model) {
      throw new Error(
        `Model not found: ${variables.provider}/${variables.model}`,
      );
    }
    const payload = {
      provider: provider.name,
      providerDescription: provider.description ?? null,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      modelKey: variables.model,
      id: model.id,
      name: model.name,
      capabilities: model.capabilities ?? [],
      hint: model.hint ?? null,
      profile: model.profile,
      defaultMessages: model.messages ?? [],
    };
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
