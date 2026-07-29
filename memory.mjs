// memory.mjs
// 结构化记忆层：用户画像（profile）+ 滚动摘要上下文（context）。
// 全部走项目已有的 D1AsKV（D1 为主，KV 兜底）。
//
// 设计：
//  - profile: 结构化画像，JSON { facts:[], likes:[], notes:"" }，由 Gemini 周期性整合。
//  - context: 长对话采用「summary（旧对话压缩）+ 最近 N 轮原文」两段式，避免直接截断丢信息。

import { D1AsKV } from "./kvAdapter.js";

const PROFILE_MAX_CHARS = 1200; // 画像文本总上限，超出由模型压缩
const SHORT_CONTEXT_LIMIT = 12; // 上下文轮数（单/双条各算一轮）低于此值直接发送原文
const SUMMARY_TURNS = 6;        // 超出后，保留最近 N 轮原文，更早的压成 summary

// ---------- 限流 ----------
const RATE_LIMIT = Object.create(null); // userId -> number[] (timestamps, ms)
export function isRateLimited(userId, max = 6, windowMs = 20000) {
  const now = Date.now();
  const arr = (RATE_LIMIT[userId] || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    RATE_LIMIT[userId] = arr;
    return true;
  }
  arr.push(now);
  RATE_LIMIT[userId] = arr;
  return false;
}

// ---------- 画像 ----------
async function readProfile(d1kv, userId) {
  const raw = (await d1kv.get(`profile:${userId}`, { type: "json" })) || {};
  return {
    facts: Array.isArray(raw.facts) ? raw.facts : [],
    likes: Array.isArray(raw.likes) ? raw.likes : [],
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
}

function serializeProfile(p) {
  const parts = [];
  if (p.facts.length) parts.push("事实：\n- " + p.facts.join("\n- "));
  if (p.likes.length) parts.push("偏好：\n- " + p.likes.join("\n- "));
  if (p.notes) parts.push("其他备注：" + p.notes);
  return parts.join("\n\n").slice(0, PROFILE_MAX_CHARS);
}

/**
 * 周期整合用户画像：把旧画像 + 最近对话交给 Gemini，产出结构化新画像。
 */
export async function updateProfile(env, userId, context, callGemini) {
  const d1kv = new D1AsKV(env.DATA_DB, env.DATA_KV);
  const old = await readProfile(d1kv, userId);
  const recent = context
    .map((t) => `${t.role === "assistant" ? "助手" : "用户"}：${t.content}`)
    .join("\n");

  const sys =
    "你是记忆整理器。根据用户旧画像与最近对话，输出更新后的用户画像。" +
    "严格只输出一个 JSON 对象，不要任何解释或代码块标记。结构：\n" +
    '{"facts":["稳定的事实/身份/职业等"],"likes":["偏好/口味/习惯"],"notes":"其他值得记住的简短备注"}';
  const userText =
    `旧画像：\n${JSON.stringify(old)}\n\n最近对话：\n${recent}\n\n请输出整合后的 JSON：`;

  const out = await callGemini(env, sys, [{ role: "user", parts: [{ text: userText }] }]);
  let parsed = null;
  if (out) {
    try {
      const cleaned = out
        .replace(/^```[a-zA-Z]*\s*/m, "")
        .replace(/```\s*$/m, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("画像 JSON 解析失败，沿用旧画像:", e);
    }
  }
  if (!parsed) return old;

  const merged = {
    facts: dedupe([...old.facts, ...(parsed.facts || [])]).slice(0, 20),
    likes: dedupe([...old.likes, ...(parsed.likes || [])]).slice(0, 20),
    notes: (parsed.notes || old.notes || "").slice(0, 400),
  };
  await d1kv.put(`profile:${userId}`, JSON.stringify(merged));
  return merged;
}

export async function getProfileText(d1kv, userId) {
  return serializeProfile(await readProfile(d1kv, userId));
}

export async function forgetUser(env, userId) {
  const d1kv = new D1AsKV(env.DATA_DB, env.DATA_KV);
  // 全局画像 + 计数器
  await d1kv.delete(`profile:${userId}`);
  await d1kv.delete(`profile_meta:${userId}`);
  // 注意：D1AsKV 不支持前缀扫描，无法枚举该用户在哪些 chat 有上下文，
  // 所以“当前群的上下文”由调用方按 chatId 删除（见 handleForget）。
}

// ---------- 上下文（滚动摘要） ----------
async function readContext(d1kv, key) {
  const raw = (await d1kv.get(key, { type: "json" })) || {};
  return { summary: typeof raw.summary === "string" ? raw.summary : "", turns: Array.isArray(raw.turns) ? raw.turns : [] };
}

/**
 * 把一轮 user/assistant 写入上下文并执行滚动摘要：
 *  - 短对话（<= SHORT_CONTEXT_LIMIT 轮）直接 append。
 *  - 超出后把最早的 (len - SUMMARY_TURNS) 轮压进 summary（用 Gemini），保留最近 SUMMARY_TURNS 轮原文。
 */
export async function appendAndCompact(env, key, userText, assistantText, callGemini) {
  const d1kv = new D1AsKV(env.DATA_DB, env.DATA_KV);
  const ctx = await readContext(d1kv, key);
  ctx.turns.push({ role: "user", content: userText }, { role: "assistant", content: assistantText });

  const rounds = ctx.turns.length / 2;
  if (rounds > SHORT_CONTEXT_LIMIT) {
    const keep = SUMMARY_TURNS * 2;
    const older = ctx.turns.slice(0, ctx.turns.length - keep);
    const recent = ctx.turns.slice(ctx.turns.length - keep);

    const olderText = older.map((t) => `${t.role === "assistant" ? "助手" : "用户"}：${t.content}`).join("\n");
    const sys = "你是对话摘要器。把以下对话压缩成简洁要点（中文，不超过150字），保留关键事实、决定与未决问题。只输出摘要本身。";
    const summary = await callGemini(env, sys, [{ role: "user", parts: [{ text: `已有摘要：\n${ctx.summary || "（无）"}\n\n新增对话：\n${olderText}\n\n输出合并后的新摘要：` }] }]);
    ctx.summary = summary ? summary.trim() : ctx.summary;
    ctx.turns = recent;
  }

  await d1kv.put(key, JSON.stringify(ctx));
  return ctx;
}

/**
 * 把上下文转为发给 Gemini 的 contents（summary 作为系统侧背景，turns 作为对话）。
 */
export function contextToGemini(ctx) {
  return {
    summary: ctx.summary,
    contents: ctx.turns.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.content }],
    })),
  };
}

export async function clearContext(d1kv, key) {
  await d1kv.delete(key);
}

export async function getContext(d1kv, key) {
  return readContext(d1kv, key);
}

function dedupe(arr) {
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
}
