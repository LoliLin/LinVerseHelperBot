export function parseMention(raw) {
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

export function makeUserTag(fromUser) {
  return  fromUser.username ? `@${fromUser.username}` : `#${fromUser.id}*${fromUser.first_name}`;
}

export async function buildGroupMentionList(d1kv, token, chatId, category) {
  const isEveryone = category === "everyone" || category === "members";
  const membersKey = isEveryone ? `group:${chatId}:members` : `group:${chatId}:${category}`;

  const finalTags = new Set();

  const cachedMembersRaw = await d1kv.get(membersKey, { type: "json" });
  if (Array.isArray(cachedMembersRaw)) {
    cachedMembersRaw.forEach((tag) => finalTags.add(tag));
  }

  if (isEveryone) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/getChatAdministrators?chat_id=${chatId}`
      );
      const adminsResponse = await res.json();

      if (adminsResponse.ok && Array.isArray(adminsResponse.result)) {
        for (const admin of adminsResponse.result) {
          if (admin.user && !admin.user.is_bot) {
            finalTags.add(makeUserTag(admin.user));
          }
        }
      }
    } catch (err) {
      console.error("获取管理员列表失败:", err);
    }
  }

  return Array.from(finalTags).map(parseMention);
}

export async function getCategories(d1kv, chatId) {
  const categoriesKey = `group:${chatId}*categories`;
  let categories = [];
  try {
    categories = (await d1kv.get(categoriesKey, { type: "json" })) || [];
  } catch (e) {
    console.error("❌ 读取 KV 数据库失败:", e.message);
    return;
  }
  return categories;
}

export async function recordUserCategory(d1kv, chatId, fromUser, category) {
  if (!fromUser || fromUser.is_bot) return;

  const membersKey = `group:${chatId}:${category}`;
  const categoriesKey = `group:${chatId}*categories`;

  //members
  let members = [];
  try {
    members = (await d1kv.get(membersKey, { type: "json" })) || [];
  } catch (e) {
    console.error("❌ 读取 KV 数据库失败:", e.message);
    return;
  }

  const userTag = makeUserTag(fromUser);
  if (!members.includes(userTag)) {
    members.push(userTag);
    await d1kv.put(membersKey, JSON.stringify(members));
  }

  //categories
  let categories = [];
  try {
    categories = (await d1kv.get(categoriesKey, { type: "json" })) || [];
  } catch (e) {
    console.error("❌ 读取 KV 数据库失败:", e.message);
    return;
  }

  if (!categories.includes(category)) {
    categories.push(category);
    await d1kv.put(categoriesKey, JSON.stringify(categories));
  }
}

export async function postMentionCategory(d1kv, chatId, messageId, token, category) {
  const resultList = buildGroupMentionList(d1kv, token, chatId, category);
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
  }
}