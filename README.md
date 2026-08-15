# local-models-connect-mcp

通过 MCP 协议（stdio）连接本地模型服务的通用服务器：多服务商多模型，全部由 TOML 配置驱动，接入新服务商无需改源码。

- 技术栈：TypeScript（NodeNext strict）+ `@modelcontextprotocol/sdk@1.30.0` + `zod` + `smol-toml`，pnpm 管理

## 功能

- 通用 Provider 架构：`[<provider>]` 服务商段 + `[<provider>.<model>]` 模型子段
- 多协议：`protocol` = `openai-responses` / `openai-chat` / `anthropic`，其他值回退 openai-chat
- 配置路径：`--config=<path>` > `LMCP_CONFIG` 环境变量 > `~/.config/local-models-connect/config.toml`
- `api_key` 支持明文 / `file:<路径>` / `env:<变量名>`；`headers` 支持 `${env:VAR}` 插值
- 多模态识图：content 支持 text + image_url 内容块（本地路径自动转 data URL）
- 思考链剥离（默认剥离 `reasoning_content`/`thinking`/`chain_of_thought`，`include_reasoning: true` 保留原始输出）+ 空回答自动兜底重试（`enable_thinking: false`）
- 分组 profile：按 `chat`/`vision` 场景自动选择（含图→vision），可 `scenario` 显式指定
- 模型自动选型：未指定 `model` 时优先选已加载模型（`auto_select_loaded`，30s 状态缓存）
- 模型元数据：`capabilities` + `hint`，`search_actions` 按能力/名称/hint 分词匹配（含中文）
- MCP Resource：`models://{provider}/{model}`（list + read）；MCP Prompts：`getting-started` / `vision`

## 构建与配置

```bash
pnpm install
pnpm build      # 产出 dist/index.js
```

复制 `config.toml.example` 到 `~/.config/local-models-connect/config.toml`：

- `[<provider>]`：`enable` / `description` / `protocol` / `base_url` / `api_key` / `headers` / `profile`（含 `auto_select_loaded`）
- `[<provider>.<model>]`：`name` / `id` / `capabilities` / `hint` / `priority` / `profile` / `messages`（默认起始对话）

### 接入 opencode（项目级 opencode.json）

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "local-models": {
      "type": "local",
      "command": ["node", "<项目绝对路径>/dist/index.js"],
      "enabled": true
    }
  },
  "experimental": { "mcp_timeout": 300000 }
}
```

> 配置改动后需重启 opencode 生效。

## 工具

| 工具 | 用途 |
|---|---|
| `chat` | 聊天 / 识图 / 内置工具（web_search / python）——唯一模型入口 |
| `list_models` | 模型列表（key、能力、加载状态） |
| `status` | 配置加载状态 |
| `search_actions` | 按意图发现动作 + 匹配模型 |
| `execute_action` | 按 id 执行动作（id 来自 `search_actions`） |

## 注意事项

- 首次调用 10-15s+：本地模型空闲被卸载，请求时重新加载，属正常
- 结果返回 OpenAI 兼容 JSON 字符串，需解析（`choices[0].message.content` 是回答）
- `max_tokens` 上限 4096（超出服务端 `max_context_length` 会卡死，配置前查 `/v1/models` 元数据）
- 思考链默认剥离；API key 在配置文件中，勿打印或提交
