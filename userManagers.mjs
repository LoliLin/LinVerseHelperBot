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

export async function buildGroupMentionList(db, token, chatId, category) {
  const isEveryone = category === "everyone" || category === "members";
  const memberCategory = isEveryone ? "members" : category;
  const { results: members = [] } = await db.prepare(
    "SELECT user_tag FROM group_members WHERE chat_id = ? AND category = ?"
  ).bind(String(chatId), memberCategory).all();

  const finalTags = new Set(members.map((member) => member.user_tag));

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

export async function getCategories(db, chatId) {
  const { results = [] } = await db.prepare(
    "SELECT DISTINCT category FROM group_members WHERE chat_id = ? ORDER BY category"
  ).bind(String(chatId)).all();
  return results.map((row) => row.category);
}

export async function recordUserCategory(db, chatId, fromUser, category) {
  if (!fromUser || fromUser.is_bot) return;

  await db.prepare(
    "INSERT OR IGNORE INTO group_members (chat_id, category, user_tag) VALUES (?, ?, ?)"
  ).bind(String(chatId), category, makeUserTag(fromUser)).run();
}

export async function unrecordUserCategory(db, chatId, fromUser, category) {
  if (!fromUser || fromUser.is_bot) return;

  await db.prepare(
    "DELETE FROM group_members WHERE chat_id = ? AND category = ? AND user_tag = ?"
  ).bind(String(chatId), category, makeUserTag(fromUser)).run();
}

export async function postMentionCategory(db, chatId, messageId, token, category) {
  const resultList = await buildGroupMentionList(db, token, chatId, category);
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