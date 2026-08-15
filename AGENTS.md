# AGENTS.md

## Project

local-models-connect-mcp — 通用 MCP server（stdio），通过 TOML 配置连接本地模型服务（多服务商多模型）。技术栈：TypeScript（NodeNext strict）+ `@modelcontextprotocol/sdk` + `zod` + `smol-toml`，pnpm 管理。

## Commands

- `pnpm build` — 构建 dist/
- `pnpm dev` — 开发模式
- `node dist/index.js` — 启动 MCP server（stdio）

## Conventions

- 新增服务商只需在配置里加 `[<provider>]` 段 + `[<provider>.<model>]` 子段，无需改源码
- 协议由 `protocol` 字段决定：`openai-responses` / `openai-chat` / `anthropic`，其他值回退 openai-chat
- 配置路径优先级：`--config=<path>` > `LMCP_CONFIG` > `~/.config/local-models-connect/config.toml`
- 模型级 profile 可覆盖全局 profile；调用时 profile 可再覆盖
- 消息含图片 → vision 分组，纯文本 → chat 分组；也可显式传 `profile_key`
- 不提交 `config.toml`（已在 .gitignore）；示例见 `config.toml.example`
- 所有 MCP 工具调用入口：`local-models-connect-mcp` 的 `chat` / `list_models` / `status` / `search_actions` / `execute_action`
