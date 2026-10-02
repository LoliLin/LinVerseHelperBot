CREATE TABLE IF NOT EXISTS group_members (
  chat_id TEXT NOT NULL,
  category TEXT NOT NULL,
  user_tag TEXT NOT NULL,
  PRIMARY KEY (chat_id, category, user_tag)
);

CREATE TABLE IF NOT EXISTS repeat_state (
  chat_id TEXT PRIMARY KEY,
  content_key TEXT NOT NULL,
  count INTEGER NOT NULL,
  bot_repeated INTEGER NOT NULL DEFAULT 0
);

-- Import the old D1-backed key/value records once, then remove the adapter table.
CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value TEXT
);

WITH legacy AS (
  SELECT
    substr(key, 7, instr(substr(key, 7), ':') - 1) AS chat_id,
    substr(substr(key, 7), instr(substr(key, 7), ':') + 1) AS category,
    CASE WHEN json_valid(value) THEN value ELSE '[]' END AS json_value
  FROM kv_store
  WHERE key LIKE 'group:%:%'
    AND instr(substr(key, 7), ':') > 0
), member_arrays AS (
  SELECT chat_id, category, json_value
  FROM legacy
  WHERE json_type(json_value) = 'array'
)
INSERT OR IGNORE INTO group_members (chat_id, category, user_tag)
SELECT member_arrays.chat_id, member_arrays.category, members.value
FROM member_arrays, json_each(member_arrays.json_value) AS members
WHERE members.type = 'text';

WITH legacy AS (
  SELECT
    substr(key, 7, instr(substr(key, 7), ':') - 1) AS chat_id,
    CASE WHEN json_valid(value) THEN value ELSE '{}' END AS json_value
  FROM kv_store
  WHERE key LIKE 'group:%:repeat'
    AND instr(substr(key, 7), ':') > 0
), repeat_objects AS (
  SELECT chat_id, json_value
  FROM legacy
  WHERE json_type(json_value) = 'object'
)
INSERT INTO repeat_state (chat_id, content_key, count, bot_repeated)
SELECT
  chat_id,
  COALESCE(json_extract(json_value, '$.key'), ''),
  COALESCE(CAST(json_extract(json_value, '$.count') AS INTEGER), 0),
  COALESCE(CAST(json_extract(json_value, '$.botRepeated') AS INTEGER), 0)
FROM repeat_objects
WHERE json_type(json_value, '$.key') = 'text'
ON CONFLICT(chat_id) DO UPDATE SET
  content_key = excluded.content_key,
  count = excluded.count,
  bot_repeated = excluded.bot_repeated;

DROP TABLE IF EXISTS kv_store;
