// tgClient.mjs
// 封装 Telegram Bot API 的发送能力，便于复用与测试。

const TG_API = "https://api.telegram.org/bot";
export const TG_SEND_CHUNK = 4000; // 单条安全长度（Telegram 上限 4096）

/**
 * 把长文本切成 <= chunkSize 的片段（优先在换行处切断，避免截断 HTML 标签）。
 */
export function splitChunks(text, chunkSize = TG_SEND_CHUNK) {
  const out = [];
  let remaining = text || "";
  while (remaining.length > 0) {
    if (remaining.length <= chunkSize) {
      out.push(remaining);
      break;
    }
    // 在 chunkSize 内找一个换行作为切断点
    let cut = remaining.lastIndexOf("\n", chunkSize);
    if (cut <= 0) cut = chunkSize;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  return out;
}

/**
 * 发送文本消息。
 * @param {string} token
 * @param {string|number} chatId
 * @param {string} text
 * @param {object} [opts] { replyTo, parseMode }
 * 若 Telegram 报 "can't parse entities"，自动降级为纯文本重发，绝不丢消息。
 */
export async function sendMessage(token, chatId, text, opts = {}) {
  const { replyTo = null, parseMode = null } = opts;
  const chunks = splitChunks(text);
  for (let i = 0; i < chunks.length; i++) {
    const body = { chat_id: chatId, text: chunks[i] };
    if (i === 0 && replyTo) body.reply_to_message_id = replyTo;
    if (parseMode) body.parse_mode = parseMode;

    const res = await postJson(`${TG_API}${token}/sendMessage`, body);
    if (parseMode && !res.ok) {
      const err = res.json || {};
      if (err.description && /can't parse entities|entities/i.test(err.description)) {
        delete body.parse_mode;
        await postJson(`${TG_API}${token}/sendMessage`, body);
      }
    }
  }
}

/**
 * 发送「正在输入…」动作（在长耗时调用前调用一次）。
 */
export async function sendTyping(token, chatId) {
  await postJson(`${TG_API}${token}/sendChatAction`, {
    chat_id: chatId,
    action: "typing",
  });
}

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, json };
  } catch (e) {
    console.error("Telegram 调用失败:", e);
    return { ok: false, json: {} };
  }
}
