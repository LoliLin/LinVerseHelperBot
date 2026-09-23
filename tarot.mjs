import { TAROT_CARDS } from "./tarotData.js";
import { makeUserTag } from "./userManagers.mjs";

// 伪随机数发生器 (Mulberry32)
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 基于用户 ID + 日期生成可复现的抽牌结果
 * @param {object} fromUser
 * @returns {Promise<{card: object, isUpright: boolean}>}
 */
async function drawTarot(fromUser) {
  const today = new Date().toISOString().slice(0, 10);
  const userTag = makeUserTag(fromUser);
  const msgBuffer = new TextEncoder().encode(`tarot:${userTag}:${today}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const numSeed = new DataView(hashBuffer).getUint32(0, false); // 大端序保证跨平台一致
  const rng = mulberry32(numSeed);

  const cardIndex = Math.floor(rng() * TAROT_CARDS.length);
  const isUpright = rng() >= 0.5;
  return { card: TAROT_CARDS[cardIndex], isUpright };
}

/**
 * 真正随机抽一张牌，不受日期限制
 * @returns {{card: object, isUpright: boolean}}
 */
function drawRandomTarot() {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  const cardIndex = Math.floor((buf[0] / 0x100000000) * TAROT_CARDS.length);
  const isUpright = buf[1] >= 0x80000000;
  return { card: TAROT_CARDS[cardIndex], isUpright };
}

async function replyTarotDraw(env, msg, draw) {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const token = env.TG_TOKEN;
  const { card, isUpright } = draw;
  const position = isUpright ? "正位" : "逆位";
  const interpretation = isUpright ? card.positive : card.negative;

  // 构建图片文件名（逆位用预生成的 _revert 版本）
  const baseName = card.imageName; // 如 "The Fool.jpg"
  const extIndex = baseName.lastIndexOf(".");
  const nameWithoutExt = baseName.substring(0, extIndex);
  const ext = baseName.substring(extIndex);
  const imageFileName = isUpright ? baseName : `${nameWithoutExt}_revert${ext}`;

  const baseUrl = env.TAROT_IMAGE_BASE_URL || "https://raw.githubusercontent.com/LoliLin/LinVerseHelperBot/main/TarotImages";
  const imageUrl = `${baseUrl}/${encodeURIComponent(imageFileName)}`;

  const caption = `${card.name} (${position})\n\n解读:\n${interpretation}`;

  console.log(`✅ 已抽取塔罗牌: ${caption}`);

  const apiUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo: imageUrl,
      caption: caption,
      reply_to_message_id: messageId,
    }),
  });

  if (!res.ok) {
    console.error("发送失败:", await res.text());
  }
}

export async function handleTarot(env, msg, ctx) {
  const draw = await drawTarot(msg.from);
  await replyTarotDraw(env, msg, draw);
}

export async function handleImTarot(env, msg, ctx) {
  const draw = drawRandomTarot();
  await replyTarotDraw(env, msg, draw);
}