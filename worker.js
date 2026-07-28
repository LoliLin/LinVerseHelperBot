import { handleTarot } from "./tarot.mjs";
import { 
  parseMention, 
  makeUserTag, 
  recordUserCategory, 
  buildGroupMentionList, 
  postMentionCategory, 
  getCategories 
} from "./userManagers.mjs";
import { D1AsKV } from './kvAdapter.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Only POST allowed", { status: 405 });
    }

    const configError = verifyArguments(env);
    if (configError) return configError;

    const d1kv = getD1AsKV(env);

    try {
      const update = await request.json();
      const msg = update.message;

      if (msg && msg.chat) {
        const chatId = msg.chat.id;
        const fromUser = msg.from;

        const content = getMessageContent(msg);
        if (fromUser) {
          console.log(`${fromUser.first_name || 'User'} : ${JSON.stringify(content)}`);
          await recordActiveUser(d1kv, chatId, fromUser);
        }

        // 顺序匹配指令（匹配成功即短路停止后续匹配）
        let cmdUsed = false;
        cmdUsed = cmdUsed || await verifyCommands(
          ["/everyone"], env, msg, ctx, handleEveryone, 
          (_env, _msg) => _msg.text?.includes("@everyone") || _msg.caption?.includes("@everyone")
        );
        cmdUsed = cmdUsed || await verifyCommands(
          ["/tarot", "/塔罗", "/chou", "塔罗牌"], env, msg, ctx, handleTarot
        );
        cmdUsed = cmdUsed || await verifyCommands(
          ["/notify"], env, msg, ctx, handleNotify, condition_handleNotify
        );
        cmdUsed = cmdUsed || await verifyCommands(
          ["/assign", "/tag"], env, msg, ctx, handleTag
        );

        // 如果没有触发任何指令，执行复读机逻辑
        if (!cmdUsed && content) {
          await handleRepeat(d1kv, chatId, content, env.TG_TOKEN);
        }
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("🚨 运行时发生严重崩溃:", err.stack || err.toString());
      return new Response(err.toString(), { status: 500 });
    }
  },
};

function getD1AsKV(env) {
  return new D1AsKV(env.DATA_DB, env.DATA_KV);
}

/**
 * 校验并执行指令（重写：支持正则匹配与可选 _extraTrigger）
 */
async function verifyCommands(cmds, _env, _msg, _ctx, _func, _extraTrigger) {
  if (!_msg) return false;

  const text = (_msg.text || _msg.caption || "").trim();

  // 1. 触发条件一：可选的自定义条件回调
  const isExtraMatch = typeof _extraTrigger === "function" && Boolean(_extraTrigger(_env, _msg, _ctx));

  // 2. 触发条件二：指令正则匹配（自动兼容 /cmd, /cmd@botname 及无斜杠指令）
  const isCmdMatch = cmds.some((cmd) => {
    return (!text.startsWith(`${cmd}@`) && text.startsWith(cmd)) 
    || (text.startsWith(`${cmd}@${_env.BOT_NAME}`))
  });

  if (isExtraMatch || isCmdMatch) {
    await _func(_env, _msg, _ctx);
    return true;
  }

  return false;
}

/**
 * 校验必需的环境变量
 */
function verifyArguments(env) {
  if (!env.DATA_DB || !env.DATA_KV || !env.TG_TOKEN || !env.BOT_NAME) {
    console.error("❌ 严重错误: 缺少 KV/D1 绑定或 TG_TOKEN / BOT_NAME 变量配置！");
    return new Response("Config Missing", { status: 500 });
  }
  return null;
}

/**
 * 提取消息的内容唯一 Key 及复读 Payload
 */
function getMessageContent(msg) {
  if (msg.sticker) {
    return {
      key: `sticker:${msg.sticker.file_unique_id}`,
      type: "sticker",
      fileId: msg.sticker.file_id,
    };
  }

  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    return {
      key: `photo:${photo.file_unique_id}`,
      type: "photo",
      fileId: photo.file_id,
      caption: msg.caption || "",
    };
  }

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
 * 记录群内活跃用户
 */
async function recordActiveUser(d1kv, chatId, fromUser) {
  await recordUserCategory(d1kv, chatId, fromUser, "members");
}

/**
 * 复读机逻辑：检测连续相同内容并自动 +1 复读
 */
async function handleRepeat(d1kv, chatId, content, token) {
  if (!content) return;

  const repeatKey = `group:${chatId}:repeat`;
  const lastMsgData = (await d1kv.get(repeatKey, { type: "json" })) || {
    key: "",
    count: 0,
  };

  if (content.key === lastMsgData.key) {
    const newCount = lastMsgData.count + 1;
    await d1kv.put(
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
    await d1kv.put(
      repeatKey,
      JSON.stringify({ key: content.key, count: 1 })
    );
  }
}

/**
 * Notify 触发判断
 */
async function condition_handleNotify(env, msg, ctx) {
  if (!msg) return false;

  const text = (msg.text || msg.caption || "").toLowerCase();

  if (text.startsWith("/") ||text.includes("@everyone") || text.includes("@members")) {
    return false;
  }

  const d1kv = getD1AsKV(env);
  const categories = await getCategories(d1kv, msg.chat.id);

  if (!Array.isArray(categories) || categories.length === 0) {
    return false;
  }

  return categories.some((cate) => return text.includes(`@${String(cate)}`));
}

/**
 * Notify 逻辑处理
 */
async function handleNotify(env, msg, ctx) {
  const text = (msg.text || msg.caption || "").trim();
  const d1kv = getD1AsKV(env);

  if (text.startsWith("/")) {
    const cmds = text.split(/\s+/);
    if (cmds.length >= 2) {
      const category = cmds[1];
      await postMentionCategory(d1kv, msg.chat.id, msg.message_id, env.TG_TOKEN, category);
      return true;
    }
    await postInvokeSuccess(msg.chat.id, msg.message_id, env.TG_TOKEN, "请指定要通知的标签，例如：<code>/notify dev</code>");
    return true;
  } else {
    const env_categories = await getCategories(d1kv, msg.chat.id);
    if (!Array.isArray(env_categories) || env_categories.length === 0) return false;

    const rawCategories = [...text.matchAll(/@([a-zA-Z0-9_]+)/g)]
      .map((m) => m[1].toLowerCase())
      .filter((cat) => env_categories.map(c => String(c).toLowerCase()).includes(cat));

    const categories = [...new Set(rawCategories)];
    if (categories.length === 0) return false;

    const mentionsSet = new Set();
    for (const category of categories) {
      const mentions = await buildGroupMentionList(d1kv, env.TG_TOKEN, msg.chat.id, category);
      if (Array.isArray(mentions)) {
        mentions.forEach((user) => mentionsSet.add(user));
      }
    }

    const usersMentions = Array.from(mentionsSet);
    if (usersMentions.length === 0) return false;

    const mentionText = usersMentions.join(" ");
    await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: mentionText,
        reply_to_message_id: msg.message_id,
        parse_mode: "HTML"
      }),
    });
  }
}

/**
 * Tag 标签归类逻辑
回复 + /tag dev：给被回复者打上 dev 标签。

回复 + /tag @Cynun：提取被回复消息的内容作为 category，打给 @Cynun。

单发 + /tag dev：给消息发送者自己打上 dev 标签。

单发 + /tag dev @Cynun（顺序可颠倒）：给 @Cynun 打上 dev 标签。
 */
export async function handleTag(env, msg, ctx) {
  const text = (msg.text || msg.caption || "").trim();
  
  const args = text.split(/\s+/).slice(1); 
  if (args.length === 0) return;

  const replyMsg = msg.reply_to_message;
  let targetUser = null;
  let category = "";

  if (replyMsg) {
    const firstArg = args[0];

    if (firstArg.startsWith("@")) {
      targetUser = { username: firstArg.replace(/^@/, "") };
      category = (replyMsg.text || replyMsg.caption || "").trim();
    } else {
      targetUser = replyMsg.from;
      category = firstArg;
    }
  } else {
    if (args.length === 1) {
      targetUser = msg.from;
      category = args[0];
    } else {
      const mentionArg = args.find((a) => a.startsWith("@"));
      const categoryArg = args.find((a) => !a.startsWith("@"));

      if (mentionArg && categoryArg) {
        targetUser = { username: mentionArg.replace(/^@/, "") };
        category = categoryArg;
      } else if (args[1]) {
        category = args[0];
        targetUser = { username: args[1].replace(/^@/, "") };
      }
    }
  }

  if (!targetUser || !category) return;

  const d1kv = getD1AsKV(env);
  await recordUserCategory(d1kv, msg.chat.id, targetUser, category);

  const displayName = getDisplayName(targetUser);
  await postInvokeSuccess(
    msg.chat.id, 
    msg.message_id, 
    env.TG_TOKEN, 
    `好的喵！已将 ${displayName} 归类到 #${category}`
  );
}

function getDisplayName(user) {
  if (!user) return "未知用户";
  if (typeof user === "string") return user.startsWith("@") ? user : `@${user}`;
  if (user.username) return `@${user.username}`;
  if (user.first_name) return user.first_name;
  return `User(${user.id})`;
}

async function handleEveryone(env, msg, ctx) {
  console.log("🎯 触发了 @everyone 逻辑");
  await postMentionCategory(getD1AsKV(env), msg.chat.id, msg.message_id, env.TG_TOKEN, "members");
}

async function postInvokeSuccess(chatId, messageId, token, text = "好的喵！") {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
  };

  if (messageId) {
    body.reply_to_message_id = messageId;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return await res.json();
}
