import { TAROT_CARDS } from "./tarotData.js";

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
 * @param {number} userId
 * @returns {Promise<{card: object, isUpright: boolean}>}
 */
async function drawTarot(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const msgBuffer = new TextEncoder().encode(`tarot:${userId}:${today}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const numSeed = new DataView(hashBuffer).getUint32(0, false); // 大端序保证跨平台一致
  const rng = mulberry32(numSeed);

  rng();

  const cardIndex = Math.floor(rng() * TAROT_CARDS.length);
  const isUpright = rng() >= 0.5;
  return { card: TAROT_CARDS[cardIndex], isUpright };
}

/**
 * 处理塔罗牌抽牌请求
 * @param {object} env       环境变量 (包含 TAROT_IMAGE_BASE_URL)
 * @param {number} chatId    Telegram 群组 ID
 * @param {number} messageId 原消息 ID
 * @param {number} userId    用户 ID
 * @param {string} token     Bot Token
 */
export async function handleTarot(env, chatId, messageId, userId, token) {

  // 1. 抽牌
  const { card, isUpright } = await drawTarot(userId);
  const position = isUpright ? "正位" : "逆位";
  const interpretation = isUpright ? card.positive : card.negative;

  // 2. 构建图片文件名（逆位用预生成的 _revert 版本）
  const baseName = card.imageName; // 如 "The Fool.jpg"
  const extIndex = baseName.lastIndexOf(".");
  const nameWithoutExt = baseName.substring(0, extIndex);
  const ext = baseName.substring(extIndex);
  const imageFileName = isUpright ? baseName : `${nameWithoutExt}_revert${ext}`;

  // 3. 拼接完整图片 URL
  const baseUrl = env.TAROT_IMAGE_BASE_URL || "https://raw.githubusercontent.com/LoliLin/LinVerseHelperBot/main/TarotImages";
  const imageUrl = `${baseUrl}/${encodeURIComponent(imageFileName)}`;

  // 4. 构建 caption
  const caption = `${card.name} (${position})\n\n解读:\n${interpretation}`;

  console.log(`✅ 已抽取塔罗牌: ${caption}`);

  // 5. 通过 Telegram API 发送图片（带描述）
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
