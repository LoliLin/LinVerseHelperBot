import { handleTarot } from "./tarot.mjs";

export default {
  async fetch(request, env, ctx) {
    // 1. 请求方法校验
    if (request.method !== "POST") {
      return new Response("Only POST allowed", { status: 405 });
    }

    // 2. 参数与环境校验
    const configError = verifyArguments(env);
    if (configError) return configError;

    try {
      const update = await request.json();
      const msg = update.message;

      // 3. 处理有效消息
      if (msg && msg.chat) {
        const chatId = msg.chat.id;
        const fromUser = msg.from;
        const text = (msg.text || msg.caption || "").trim();

        // 功能一：记录活跃用户（只要发言都算）
        await recordActiveUser(env, chatId, fromUser);

        // 功能二：人类本质复读机 (+1 匹配)
        const content = getMessageContent(msg);

        console.log(`${fromUser.first_name} :  ${content}`);

        
        if (content) {
          await handleRepeat(env, chatId, content, env.TG_TOKEN);
        }

        // 功能三：@everyone 召唤
        if (text) {
          await handleEveryone(env, chatId, text, msg.message_id, env.TG_TOKEN);
        }

        // 功能四：每日塔罗牌抽卡（指令触发）
        const isTarotCmd = ["/tarot", "/塔罗", "/chou", "塔罗牌"].some((cmd) =>
          text.startsWith(cmd)
        );
        if (isTarotCmd) {
          await handleTarot(env, chatId, text, msg.message_id, fromUser, env.TG_TOKEN);
        }
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("🚨 运行时发生严重崩溃:", err.stack || err.toString());
      return new Response(err.toString(), { status: 500 });
    }
  },
};

/**
 * 校验必需的环境变量
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
      key: `sticker:${msg.sticker.file_unique_id}`,
      type: "sticker",
      fileId: msg.sticker.file_id,
    };
  }

  // 2. 图片 Photo
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    return {
      key: `photo:${photo.file_unique_id}`,
      type: "photo",
      fileId: photo.file_id,
      caption: msg.caption || "",
    };
  }

  // 3. 纯文本 Text
  if (msg.text) {
    const text = msg.text.trim();
    return {
      key: `text:${text}`,
      type: "text",
      text: text,
    };
  }

  return null;
}

/**
 * 记录群内活跃用户（去重存入 KV）
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

  const userTag = fromUser.username ? `@${fromUser.username}` : `#${fromUser.id}*{fromUser.first_name}`;
  if (!members.includes(userTag)) {
    members.push(userTag);
    await env.DATA_KV.put(membersKey, JSON.stringify(members));
    console.log(`✅ 已记录新活跃用户: ${userTag}`);
  }
}

/**
 * 复读机逻辑：检测连续相同内容并自动 +1 复读
 */
async function handleRepeat(env, chatId, content, token) {
  if (!content) return;

  const checkText = content.text || content.caption || "";
  if (checkText.includes("@everyone") || checkText.startsWith("/")) return;

  const repeatKey = `group:${chatId}:repeat`;
  const lastMsgData = (await env.DATA_KV.get(repeatKey, { type: "json" })) || {
    key: "",
    count: 0,
  };

  if (content.key === lastMsgData.key) {
    const newCount = lastMsgData.count + 1;
    await env.DATA_KV.put(
      repeatKey,
      JSON.stringify({ key: content.key, count: newCount })
    );
    console.log(`🔁 发现复读！Key: "${content.key}"，当前第 ${newCount} 次`);

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

    await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } else {
    // 重置复读 Key
    await env.DATA_KV.put(
      repeatKey,
      JSON.stringify({ key: content.key, count: 1 })
    );
  }
}

function parseMention(raw) {
  if (raw.startsWith('@')) {
    return raw; // 直接可用
  }
  const match = raw.match(/^#(\d+)\*(.+)$/);
  if (match) {
    const id = match[1];
    const name = match[2];
    return `<a href="tg://user?id=${id}">${name}</a>`;
  }
  return raw;
}

/**
 * 处理 @everyone / /everyone 召唤功能
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
      fetch(
        `https://api.telegram.org/bot${token}/getChatAdministrators?chat_id=${chatId}`
      ).then((res) => res.json()),
    ]);
    cachedMembersRaw = kvData;
    adminsResponse = tgData;
  } catch (e) {
    console.error("❌ 读取 KV 或请求 TG 管理员列表失败:", e.message);
  }

  const finalTags = new Set(cachedMembersRaw || []);

  if (adminsResponse.ok && adminsResponse.result) {
    for (const admin of adminsResponse.result) {
      if (admin.user && !admin.user.is_bot) {
        finalTags.add(admin.user.username ? `@${admin.user.username}` : `#${admin.user.id}*{admin.user.first_name}`);
      }
    }
  }

  const resultList = Array.from(finalTags).map(parseMention);
  if (resultList.length > 0) {
    const mentionText = resultList.join(" ");
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: mentionText,
        reply_to_message_id: messageId,
        parse_mode: "HTML"
      }),
    });
    console.log("📤 @everyone 消息发送完毕");
  }
}
