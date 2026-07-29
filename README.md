# LinVerseHelperBot
the codes of linverseHelperBot

### env requires: 

```
env.DATA_DB   
env.DATA_KV   
env.TG_TOKEN  
env.BOT_NAME  
env.GEMINI_API_KEY   # Gemini 后端密钥（secret，建议用 wrangler secret put 配置）
env.GEMINI_MODEL     # 可选，默认 gemini-2.0-flash
```

### LLM 聊天模块（geminiChat.mjs）

基于 Google Gemini 的轻量对话，复用项目已有的 D1AsKV 存储。代码拆为三块：
- `geminiChat.mjs`：主控（指令入口、人设、限流、重试）。
- `memory.mjs`：记忆层（结构化画像 + 滚动摘要上下文 + 限流）。
- `tgClient.mjs`：Telegram 发送封装（分片、HTML 降级、typing 指示）。

特性：
- **上下文维护（不丢信息）**：采用「summary（旧对话压缩）+ 最近 N 轮原文」两段式。短对话直接发原文；超出 12 轮后，更早的对话用 Gemini 压成摘要（`conv:chatId:userId` 存 `{summary, turns}`）。
- **用户画像记忆（结构化）**：每用户一份全局画像（`profile:userId`，JSON `{facts, likes, notes}`），每 6 轮由 Gemini 整合去重，跨群生效。
- **稳定人设**：以「狐狐」口吻闲聊，注入已知信息。
- **交互**：回复前发 typing 指示；`/help` 查看说明；回复以 `parse_mode=HTML` 发送，解析失败自动降级纯文本。
- **健壮**：每用户 6 次/20s 限流；Gemini 调用失败重试 2 次。

指令：
- `/ai 内容` 或 `/chat 内容`：与狐狐聊天（也可回复某条消息后直接 `/ai` 引用它）。
- `/reset`：清空当前群的对话上下文（保留画像）。
- `/forget`：彻底遗忘（清全局画像 + 当前群上下文）。
- `/help`：查看上述说明。

> 配置密钥：`wrangler secret put GEMINI_API_KEY`（本地开发可在 `.dev.vars` 中填写）。
> 单测：`node --test "tests/*.test.mjs"`（不依赖 Workers 运行时，验证分片/限流等纯逻辑）。

## Thanks

Thanks to [Shinokawa/tarotQQBot](https://github.com/Shinokawa/tarotQQBot/)
