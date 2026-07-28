import { handleTarot } from "./tarot.mjs";

export default {
  async fetch(request, env, ctx) {
    // 1. 请求方法校验
    if (request.method !== "POST") {
      return new Response("Only POST allowed", { status: 405 });
    }

    // 2. 参数与环境校验（提取为 verifyArguments）
    const configError = verifyArguments(env);
    if (configError) return configError;

    try {
      const update = await request.json();
      const msg = update.message;

      // 调整条件：只要有有效的 msg 和 chat 就继续处理（不限于普通文本）
      if (msg && msg.chat) {
        const chatId = msg.chat.id;
        const fromUser = msg.from;

        // 提取文本内容（普通文本 或 图片/文件的配图说明 caption）
        const text = (msg.text || msg.caption || "").trim();

        // 提取图片或 Sticker 信息（包含类型、fileId 和 uniqueId）
        const media = getMediaInfo(msg);

        // 功能一：记录活跃用户（只要发了消息/图片/表情，都算活跃）
        await recordActiveUser(env, chatId, fromUser);

        // 功能二：人类本质复读机（传参支持文本与媒体）
        await handleRepeat(env, chatId, { text, media }, env.TG_TOKEN);

        // 功能三：@everyone 召唤（如果带了文本或带图文 caption）
        if (text) {
          await handleEveryone(env, chatId, text, msg.message_id, env.TG_TOKEN);
          
          await handleTarot(env, chatId, text, msg.message_id, fromUser, env.TG_TOKEN);
        }
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("🚨 运行时发生严重崩溃:", err.stack || err.toString());
      return new Response(err.toString(), { status: 500 });
    }

    try {
      const update = await request.json();
      const msg = update.message;

      // 只处理带文本的有效消息
      if (msg && msg.text && msg.chat) {
        const chatId = msg.chat.id;
        const text = msg.text.trim();
        const fromUser = msg.from;

        // 功能一：动态收集普通发言用户（委派）
        await recordActiveUser(env, chatId, fromUser);

        // 功能二：人类本质复读机（委派）
        const content = getMessageContent(msg);

        // 3. 只要提取出了有效 content，就进行 +1 复读比对
        if (content) {
          await handleRepeat(env, chatId, content, env.TG_TOKEN);
        }
        await handleRepeat(env, chatId, text, env.TG_TOKEN);

        // 功能三：@everyone 召唤（委派）
        await handleEveryone(env, chatId, text, msg.message_id, env.TG_TOKEN);
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("🚨 运行时发生严重崩溃:", err.stack || err.toString());
      return new Response(err.toString(), { status: 500 });
    }
  }
};

/**
 * 校验必需的配置参数
 * @param {Object} env 环境变量
 * @returns {Response|null} 缺少配置时返回错误响应，否则返回 null
 */
function verifyArguments(env) {
  if (!env.DATA_KV || !env.TG_TOKEN) {
    console.error("❌ 严重错误: 缺少 KV 绑定或 TG_TOKEN 变量配置！");
    return new Response("Config Missing", { status: 500 });
  }
  return null;
}

/**
 * 提取消息的内容唯一 Key 及复读 Payload
 */
function getMessageContent(msg) {
  // 1. 贴纸 Sticker
  if (msg.sticker) {
    return {
      key: `sticker:${msg.sticker.file_unique_id}`, // 内容唯一 Key
      type: "sticker",
      fileId: msg.sticker.file_id                  // 复读发送时需要的 ID
    };
  }

  // 2. 图片 Photo
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    return {
      key: `photo:${photo.file_unique_id}`,
      type: "photo",
      fileId: photo.file_id,
      caption: msg.caption || ""
    };
  }

  // 3. 纯文本 Text
  if (msg.text) {
    const text = msg.text.trim();
    return {
      key: `text:${text}`,
      type: "text",
      text: text
    };
  }

  // 其他类型（如语音、视频、文件等暂不响应 +1）
  return null;
}

/**
 * 记录群内活跃用户（去重存入 KV）
 * @param {Object} env 环境变量（含 DATA_KV）
 * @param {number} chatId 群聊 ID
 * @param {Object} fromUser 消息发送者
 */
async function recordActiveUser(env, chatId, fromUser) {
  if (!fromUser || !fromUser.username || fromUser.is_bot) return;

  const membersKey = `group:${chatId}:members`;
  let members = [];
  try {
    members = (await env.DATA_KV.get(membersKey, { type: "json" })) || [];
  } catch (e) {
    console.error("❌ 读取 KV 数据库失败:", e.message);
    return;
  }

  const userTag = `@${fromUser.username}`;
  if (!members.includes(userTag)) {
    members.push(userTag);
    await env.DATA_KV.put(membersKey, JSON.stringify(members));
    console.log(`✅ 已记录新活跃用户: ${userTag}`);
  }
}

/**
 * 复读机逻辑：检测连续相同内容（文本/贴纸/图片）并自动 +1 复读
 * @param {Object} env 环境变量（含 DATA_KV）
 * @param {number} chatId 群聊 ID
 * @param {Object} content 消息内容对象（由 getMessageContent 提取）
 * @param {string} token 机器人 Token
 */
async function handleRepeat(env, chatId, content, token) {
  if (!content) return;

  // 1. 排除 @everyone 和指令类消息（兼容图片配图 caption）
  const checkText = content.text || content.caption || "";
  if (checkText.includes("@everyone") || checkText.startsWith("/")) return;

  const repeatKey = `group:${chatId}:repeat`;
  const lastMsgData = (await env.DATA_KV.get(repeatKey, { type: "json" })) || { key: "", count: 0 };

  // 2. 比对 content.key
  if (content.key === lastMsgData.key) {
    const newCount = lastMsgData.count + 1;
    await env.DATA_KV.put(repeatKey, JSON.stringify({ key: content.key, count: newCount }));
    console.log(`🔁 发现复读！Key: "${content.key}"，当前第 ${newCount} 次`);

    // 3. 根据媒体类型选择 Telegram API 接口与 Payload
    let endpoint = "sendMessage";
    let body = { chat_id: chatId };

    if (content.type === "sticker") {
      endpoint = "sendSticker";
      body.sticker = content.fileId;
    } else if (content.type === "photo") {
      endpoint = "sendPhoto";
      body.photo = content.fileId;
      if (content.caption) body.caption = content.caption;
    } else if (content.type === "text") {
      endpoint = "sendMessage";
      body.text = content.text;
    }

    // 4. 发送复读响应
    await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } else {
    // 话题中断，重置 Key 和计数
    await env.DATA_KV.put(repeatKey, JSON.stringify({ key: content.key, count: 1 }));
  }
}

/**
 * 处理 @everyone / /everyone 召唤功能
 * @param {Object} env 环境变量（含 DATA_KV）
 * @param {number} chatId 群聊 ID
 * @param {string} text 消息文本
 * @param {number} messageId 原消息 ID（用于回复）
 * @param {string} token 机器人 Token
 */
async function handleEveryone(env, chatId, text, messageId, token) {
  if (!text.includes("@everyone") && !text.startsWith("/everyone")) return;

  console.log("🎯 触发了 @everyone 逻辑");
  const membersKey = `group:${chatId}:members`;

  let cachedMembersRaw = [];
  let adminsResponse = { ok: false };

  try {
    const [kvData, tgData] = await Promise.all([
      env.DATA_KV.get(membersKey, { type: "json" }),
      fetch(`https://api.telegram.org/bot${token}/getChatAdministrators?chat_id=${chatId}`).then(res => res.json()),
    ]);
    cachedMembersRaw = kvData;
    adminsResponse = tgData;
  } catch (e) {
    console.error("❌ 读取 KV 或请求 TG 管理员列表失败:", e.message);
  }

  const finalTags = new Set(cachedMembersRaw || []);

  if (adminsResponse.ok && adminsResponse.result) {
    for (const admin of adminsResponse.result) {
      if (admin.user && admin.user.username && !admin.user.is_bot) {
        finalTags.add(`@${admin.user.username}`);
      }
    }
  }

  const resultList = Array.from(finalTags);
  if (resultList.length > 0) {
    const mentionText = resultList.join(" ");
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: mentionText,
        reply_to_message_id: messageId,
      }),
    });
    console.log("📤 @everyone 消息发送完毕");
  }
}
