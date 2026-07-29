// geminiChat.mjs
// 轻量级 LLM 对话模块（主控）：基于 Google Gemini，复用项目 D1AsKV 存储。
//
// 能力：
//  - 稳定人设：以「狐狐」口吻闲聊。
//  - 上下文维护：滚动摘要（长对话压缩，不丢关键信息）。
//  - 用户画像：结构化记忆（事实/偏好/备注），周期整合，跨群聊天生效。
//  - 不聒噪：仅指令触发，默认简洁，HTML 渲染，失败降级纯文本。
//  - 健壮：输入指示(typing)、每用户限流、Gemini 失败重试。

import { D1AsKV } from "./kvAdapter.js";
import { sendMessage, sendTyping } from "./tgClient.mjs";
import {
  isRateLimited,
  getProfileText,
  updateProfile,
  appendAndCompact,
  contextToGemini,
  clearContext,
  forgetUser,
} from "./memory.mjs";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.0-flash";
const MAX_OUTPUT_TOKENS = 1024;
const PROFILE_UPDATE_INTERVAL = 6; // 每 N 轮对话整合一次画像
const PERSONA = "你是一只叫「狐狐」的轻量聊天助手，嵌在 Telegram 群里。语气自然、亲切、偶尔俏皮，像朋友闲聊。";

// ---------------- 指令入口 ----------------

export async function handleAIChat(env, msg) {
  const token = env.TG_TOKEN;
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId) return true;

  let text = (msg.text || msg.caption || "").trim();
  text = text.replace(/^\/(ai|chat)(@\S+)?\s*/i, "").trim();
  if (!text && msg.reply_to_message) {
    text = (msg.reply_to_message.text || msg.reply_to_message.caption || "").trim();
  }
  if (!text) {
    await sendMessage(token, chatId, "想聊点什么？直接发 /ai 你的内容 就行～", { replyTo: msg.message_id });
    return true;
  }

  if (isRateLimited(userId)) {
    await sendMessage(token, chatId, "慢一点喵，狐狐有点忙不过来～", { replyTo: msg.message_id });
    return true;
  }

  const d1kv = new D1AsKV(env.DATA_DB, env.DATA_KV);
  const ctxKey = `conv:${chatId}:${userId}`;
  const ctx = await getContext(d1kv, ctxKey);
  const profileText = await getProfileText(d1kv, userId);

  const systemPrompt = buildSystemPrompt(msg.from, profileText, ctx.summary);
  const { contents } = contextToGemini(ctx);
  contents.push({ role: "user", parts: [{ text }] });

  await sendTyping(token, chatId);
  const reply = await callGeminiWithRetry(env, systemPrompt, contents);
  if (!reply) {
    await sendMessage(token, chatId, "狐狐不知道呢aw", { replyTo: msg.message_id });
    return true;
  }

  // 写回上下文（带滚动摘要）
  await appendAndCompact(env, ctxKey, text, reply, callGemini);

  // 周期整合画像
  const meta = (await d1kv.get(`profile_meta:${userId}`, { type: "json" })) || { turns: 0 };
  meta.turns += 1;
  await d1kv.put(`profile_meta:${userId}`, JSON.stringify(meta));
  if (meta.turns % PROFILE_UPDATE_INTERVAL === 0) {
    await updateProfile(env, userId, ctx.turns, callGemini);
  }

  await sendMessage(token, chatId, reply, { replyTo: msg.message_id, parseMode: "HTML" });
  return true;
}

export async function handleReset(env, msg) {
  const d1kv = new D1AsKV(env.DATA_DB, env.DATA_KV);
  const userId = msg.from?.id;
  if (!userId) return true;
  await clearContext(d1kv, `conv:${msg.chat.id}:${userId}`);
  await sendMessage(env.TG_TOKEN, msg.chat.id, "好的，这次的聊天上下文已清空。", { replyTo: msg.message_id });
  return true;
}

export async function handleForget(env, msg) {
  const userId = msg.from?.id;
  if (!userId) return true;
  await forgetUser(env, userId); // 清全局画像 + meta
  // 清所有已知 chat 的上下文（跨群）：扫描本 worker 无法枚举 chatId，调用方逐群清除；这里清当前群
  await clearContext(new D1AsKV(env.DATA_DB, env.DATA_KV), `conv:${msg.chat.id}:${userId}`);
  await sendMessage(env.TG_TOKEN, msg.chat.id, "已遗忘关于你的记忆，我们从头开始吧。", { replyTo: msg.message_id });
  return true;
}

export async function handleHelp(env, msg) {
  const text =
    "【狐狐聊天助手】\n" +
    "/ai 内容　或　/chat 内容：和狐狐聊天（也可回复某条消息后直接 /ai 引用它）\n" +
    "/reset：清空当前群的聊天上下文（保留对你的记忆）\n" +
    "/forget：彻底遗忘狐狐对你的记忆\n" +
    "提示：狐狐会记住你聊过的事，回复简洁、偶尔用 HTML 排版。";
  await sendMessage(env.TG_TOKEN, msg.chat.id, text, { replyTo: msg.message_id });
  return true;
}

// ---------------- 内部 ----------------

function buildSystemPrompt(from, profileText, summary) {
  const name = from.first_name || from.username || "朋友";
  const memBlock = [];
  if (summary) memBlock.push(`【之前的对话摘要】\n${summary}`);
  if (profileText) memBlock.push(`【关于 ${name} 的已知信息，自然参考即可】\n${profileText}`);
  const memory = memBlock.length ? "\n\n" + memBlock.join("\n\n") : "";

  return (
    `${PERSONA} 正在和「${name}」对话。` +
    `回复原则：简洁自然，不堆客套话，不要每条都加问候或表情前缀，不要复述用户原话；` +
    `用户用中文就中文、用英文就英文；不确定时简短反问。` +
    `排版可用 Telegram 支持的 HTML 轻量标签（<b> <i> <u> <code> <pre> <a href>），不要出现裸 < > &。` +
    memory
  );
}

async function callGeminiWithRetry(env, systemInstruction, contents, tries = 2) {
  for (let i = 0; i < tries; i++) {
    const out = await callGemini(env, systemInstruction, contents);
    if (out) return out;
  }
  return null;
}

async function callGemini(env, systemInstruction, contents) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ 未配置 GEMINI_API_KEY，无法调用 Gemini");
    return null;
  }
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.7 },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("Gemini API 错误:", JSON.stringify(data));
      return null;
    }
    const cand = data.candidates?.[0];
    if (!cand || !cand.content?.parts?.length) {
      if (cand?.finishReason === "SAFETY") return "这个话题我可能不太方便聊，我们换个方向？";
      return null;
    }
    return cand.content.parts.map((p) => p.text || "").join("").trim();
  } catch (e) {
    console.error("Gemini 调用失败:", e);
    return null;
  }
}
