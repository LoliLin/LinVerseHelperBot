import seedrandom from "seedrandom";
import { TAROT_CARDS } from "./tarotData.js";

/**
 * @param {object} env        Workers 环境变量，需包含 TAROT_IMAGE_BASE_URL
 * @param {number} chatId
 * @param {string} text
 * @param {number} messageId
 * @param {number} userId
 * @param {string} token      Telegram Bot Token
 */
export async function handleTarot(env, chatId, text, messageId, userId, token) {
  if (!text.startsWith("/tarot")) return;

  // 可复现随机抽牌
  const today = new Date().toISOString().slice(0, 10);
  const rng = seedrandom(`${userId}_${today}`);
  const cardIndex = Math.floor(rng() * TAROT_CARDS.length);
  const card = TAROT_CARDS[cardIndex];

  const isUpright = rng() > 0.5;
  const position = isUpright ? "正位" : "逆位";
  const interpretation = isUpright ? card.positive : card.negative;

  // 构建图片文件名
  const baseName = card.imageName; // 如 "The Fool.png"
  const extIndex = baseName.lastIndexOf(".");
  const nameWithoutExt = baseName.substring(0, extIndex);
  const ext = baseName.substring(extIndex);
  const imageFileName = isUpright ? baseName : `${nameWithoutExt}_revert${ext}`;

  // 图片完整 URL
  const baseUrl = env.TAROT_IMAGE_BASE_URL || "https://your-domain.com/tarot-images";
  const imageUrl = `${baseUrl}/${imageFileName}`;

  // 构造 caption
  const caption = `${card.name} (${position})\n\n解读:\n${interpretation}`;

  // 通过 Telegram API 直接发送图片 URL（Telegram 会自动下载并显示）
  const apiUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
  const body = JSON.stringify({
    chat_id: chatId,
    photo: imageUrl,
    caption: caption,
    reply_to_message_id: messageId,
  });

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body,
  });

  if (!res.ok) {
    console.error("发送失败:", await res.text());
  }
}