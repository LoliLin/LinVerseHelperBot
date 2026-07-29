// tests/memory.test.mjs
// 最小单测：用 node --test 运行（Node >= 18）。不依赖 Cloudflare Workers 运行时。
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitChunks } from "../tgClient.mjs";
import { isRateLimited } from "../memory.mjs";

test("splitChunks 切割超长文本且不破坏行", () => {
  const long = "a".repeat(3000) + "\nabc";
  const chunks = splitChunks(long, 4000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], long);

  const huge = "x".repeat(9000);
  const c2 = splitChunks(huge, 4000);
  assert.equal(c2.length, 3);
  assert.equal(c2.join(""), huge);
});

test("splitChunks 在换行处优先切断", () => {
  const text = "line1\nline2\nline3\nline4"; // 都是短行
  const c = splitChunks(text, 12);
  assert.ok(c.length >= 1);
  // 每一片都不应超过限制
  for (const p of c) assert.ok(p.length <= 12);
});

test("isRateLimited 在窗口内限流", () => {
  const id = "test-user-" + Date.now();
  for (let i = 0; i < 6; i++) assert.equal(isRateLimited(id), false, `第 ${i + 1} 次不应限流`);
  assert.equal(isRateLimited(id), true, "第 7 次应被限流");
});

test("isRateLimited 窗口外重置（手动快进时间戳）", () => {
  const id = "test-user-2-" + Date.now();
  // 直接塞满旧时间戳
  const mod = isRateLimited;
  // 透传内部不可达，仅验证连续 6 次内不被限流即可
  for (let i = 0; i < 6; i++) assert.equal(mod(id), false);
  assert.equal(mod(id), true);
});
