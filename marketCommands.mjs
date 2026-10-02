const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const BINANCE_API = "https://data-api.binance.vision/api/v3";
const HOT_MARKET_COUNT = 5;

export async function handlePolymarket(env, msg) {
  const args = getCommandArgs(msg);
  const action = (args[0] || "hot").toLowerCase();

  try {
    if (action === "hot") {
      await sendHotMarkets(env.TG_TOKEN, msg.chat.id);
      return;
    }
    if (action === "book") {
      await sendOrderBook(env.TG_TOKEN, msg.chat.id, args.slice(1));
      return;
    }
    if (action === "bet") {
      await sendBetLink(env.TG_TOKEN, msg.chat.id, args.slice(1));
      return;
    }

    await sendTelegramMessage(env.TG_TOKEN, msg.chat.id, polymarketHelp());
  } catch (error) {
    console.error("Polymarket command failed:", error);
    await sendTelegramMessage(
      env.TG_TOKEN,
      msg.chat.id,
      `Polymarket 查询失败：${escapeHtml(error.message || "未知错误")}`
    );
  }
}

export async function handleBinance(env, msg) {
  const args = getCommandArgs(msg);
  const symbol = (args[0] || "BTCUSDT").toUpperCase();

  if (!/^[A-Z0-9]{3,20}$/.test(symbol)) {
    await sendTelegramMessage(env.TG_TOKEN, msg.chat.id, "交易对格式错误，例如：<code>/binance BTCUSDT</code>");
    return;
  }

  try {
    const url = new URL(`${BINANCE_API}/ticker/24hr`);
    url.searchParams.set("symbol", symbol);
    const ticker = await fetchJson(url);
    const change = Number(ticker.priceChangePercent);
    const changeText = Number.isFinite(change)
      ? `${change > 0 ? "+" : ""}${change.toFixed(2)}%`
      : "未知";

    const text = [
      `<b>Binance Spot · ${escapeHtml(ticker.symbol || symbol)}</b>`,
      `最新价：${formatNumber(ticker.lastPrice)}`,
      `24h 涨跌：${changeText}`,
      `24h 高 / 低：${formatNumber(ticker.highPrice)} / ${formatNumber(ticker.lowPrice)}`,
      `24h 成交额：${formatNumber(ticker.quoteVolume)}`,
      `买一 / 卖一：${formatNumber(ticker.bidPrice)} / ${formatNumber(ticker.askPrice)}`,
    ].join("\n");
    await sendTelegramMessage(env.TG_TOKEN, msg.chat.id, text);
  } catch (error) {
    console.error("Binance command failed:", error);
    await sendTelegramMessage(
      env.TG_TOKEN,
      msg.chat.id,
      `Binance 行情查询失败：${escapeHtml(error.message || "未知错误")}`
    );
  }
}

async function sendHotMarkets(token, chatId) {
  const markets = await getHotMarkets();
  if (markets.length === 0) {
    await sendTelegramMessage(token, chatId, "暂时没有可展示的活跃 Polymarket 盘口。");
    return;
  }

  const lines = ["<b>Polymarket 热门市场（按 24h 成交量）</b>"];
  for (const [index, market] of markets.entries()) {
    const outcomes = parseArray(market.outcomes);
    const prices = parseArray(market.outcomePrices);
    const reference = market.slug;
    const outcome = outcomes[0] || "yes";
    lines.push(
      `${index + 1}. <b>${escapeHtml(truncate(market.question, 160))}</b>\n` +
      `24h 成交量：$${formatNumber(market.volume24hr ?? market.volume)} · ` +
      `${escapeHtml(outcome)}：${formatProbability(prices[0])}\n` +
      `Slug：<code>${escapeHtml(reference)}</code>\n` +
      `盘口：<code>/polymarket book ${escapeHtml(reference)}</code> · ` +
      `下注：<code>/polymarket bet ${escapeHtml(reference)} ${escapeHtml(outcome)} 5</code>`
    );
  }
  lines.push("下注时使用该市场列出的选项名；下注命令只生成 Polymarket 跳转，不会代为下单。");
  await sendTelegramMessage(token, chatId, lines.join("\n\n"));
}

async function sendOrderBook(token, chatId, args) {
  if (args.length < 1) {
    await sendTelegramMessage(token, chatId, polymarketHelp());
    return;
  }

  const market = await resolveMarket(args[0]);
  const selection = selectOutcome(market, args.slice(1).join(" "));
  const url = new URL(`${CLOB_API}/book`);
  url.searchParams.set("token_id", selection.tokenId);
  const book = await fetchJson(url);
  const bids = sortLevels(book.bids, "desc").slice(0, 5);
  const asks = sortLevels(book.asks, "asc").slice(0, 5);
  const bestBid = bids[0] ? Number(bids[0].price) : NaN;
  const bestAsk = asks[0] ? Number(asks[0].price) : NaN;
  const spread = Number.isFinite(bestBid) && Number.isFinite(bestAsk)
    ? `\n价差：${formatCents(bestAsk - bestBid)}`
    : "";

  const text = [
    `<b>${escapeHtml(truncate(market.question, 180))}</b>`,
    `选项：${escapeHtml(selection.outcome)} · 最新成交：${formatProbability(book.last_trade_price)}`,
    `买盘（价格 × 数量）：\n${formatLevels(bids)}`,
    `卖盘（价格 × 数量）：\n${formatLevels(asks)}`,
    `最小下单量：${escapeHtml(book.min_order_size ?? "未知")} · 最小价格步长：${escapeHtml(book.tick_size ?? "未知")}${spread}`,
  ].join("\n\n");
  await sendTelegramMessage(token, chatId, text);
}

async function sendBetLink(token, chatId, args) {
  if (args.length < 3) {
    await sendTelegramMessage(token, chatId, polymarketHelp());
    return;
  }

  const market = await resolveMarket(args[0]);
  const amountText = args[args.length - 1];
  const outcomeText = args.slice(1, -1).join(" ");
  if (!/^(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/.test(amountText) || Number(amountText) <= 0) {
    throw new Error("金额须为大于 0 的 USDC 数值，最多 6 位小数。");
  }

  const selection = selectOutcome(market, outcomeText);
  const amount = formatNumber(amountText, 6);
  const url = getMarketUrl(market);
  const text = [
    "<b>Polymarket 下注意向</b>",
    `市场：${escapeHtml(truncate(market.question, 180))}`,
    `方向：${escapeHtml(selection.outcome)}`,
    `金额：${amount} USDC`,
    "请在 Polymarket 页面核对市场、方向和金额后自行签名下单。本 bot 不会创建订单，也不会接触钱包密钥。",
  ].join("\n");

  await sendTelegramMessage(token, chatId, text, {
    reply_markup: {
      inline_keyboard: [[{ text: "打开 Polymarket 并确认下单", url }]],
    },
  });
}

async function getHotMarkets() {
  const url = new URL(`${GAMMA_API}/markets`);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  url.searchParams.set("limit", "25");

  const rows = await fetchJson(url);
  if (!Array.isArray(rows)) throw new Error("市场 API 返回格式无效。");
  return rows
    .filter((market) =>
      market &&
      typeof market.slug === "string" &&
      market.slug &&
      market.active !== false &&
      market.closed !== true &&
      market.enableOrderBook !== false &&
      parseArray(market.clobTokenIds).length > 0
    )
    .sort((left, right) => Number(right.volume24hr ?? right.volume ?? 0) - Number(left.volume24hr ?? left.volume ?? 0))
    .slice(0, HOT_MARKET_COUNT);
}

async function resolveMarket(reference) {
  if (/^[1-5]$/.test(reference)) {
    const markets = await getHotMarkets();
    const market = markets[Number(reference) - 1];
    if (!market) throw new Error(`当前热门列表中没有第 ${reference} 个市场。`);
    return market;
  }

  const url = new URL(`${GAMMA_API}/markets`);
  url.searchParams.set("slug", reference);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", "5");
  const rows = await fetchJson(url);
  const market = Array.isArray(rows)
    ? rows.find((row) => row.slug === reference && row.active !== false && row.closed !== true)
    : null;
  if (!market) throw new Error("找不到该活跃市场；请用热门列表中的序号或 market slug。");
  if (parseArray(market.clobTokenIds).length === 0) throw new Error("该市场没有可用的 CLOB 盘口。");
  return market;
}

function selectOutcome(market, requestedOutcome) {
  const outcomes = parseArray(market.outcomes);
  const tokenIds = parseArray(market.clobTokenIds);
  if (outcomes.length === 0 || outcomes.length !== tokenIds.length) {
    throw new Error("该市场的选项或 token 数据不完整。");
  }

  const wanted = requestedOutcome.trim().toLowerCase();
  const index = wanted
    ? outcomes.findIndex((outcome) => String(outcome).toLowerCase() === wanted)
    : 0;
  if (index < 0) {
    throw new Error(`无效选项。可选：${outcomes.join("、")}`);
  }
  return { outcome: String(outcomes[index]), tokenId: String(tokenIds[index]) };
}

function getMarketUrl(market) {
  const slug = market.events?.[0]?.slug || market.slug;
  if (!slug) throw new Error("该市场缺少 Polymarket 页面链接。");
  return `https://polymarket.com/event/${encodeURIComponent(slug)}`;
}

function getCommandArgs(msg) {
  return (msg.text || msg.caption || "").trim().split(/\s+/).slice(1);
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.error || data?.msg || `HTTP ${response.status}`;
    throw new Error(String(detail));
  }
  return data;
}

async function sendTelegramMessage(token, chatId, text, extra = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...extra }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(result?.description || `Telegram sendMessage failed: HTTP ${response.status}`);
  }
  return result;
}

function sortLevels(levels, direction) {
  if (!Array.isArray(levels)) return [];
  return [...levels].sort((left, right) => {
    const delta = Number(left.price) - Number(right.price);
    return direction === "desc" ? -delta : delta;
  });
}

function formatLevels(levels) {
  if (levels.length === 0) return "无挂单";
  return levels.map((level) => `${formatCents(level.price)} × ${formatNumber(level.size)}`).join("\n");
}

function formatNumber(value, maximumFractionDigits = 8) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "未知";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(number);
}

function formatProbability(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(2)}¢` : "未知";
}

function formatCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(2)}¢` : "未知";
}

function truncate(value, maxLength) {
  const text = String(value || "未知市场");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function polymarketHelp() {
  return [
    "<b>Polymarket 命令</b>",
    "/polymarket 或 /polymarket hot：查看 24h 成交量最高的 5 个活跃市场",
    "/polymarket book &lt;market-slug 或热门序号&gt; [outcome]：查看盘口（默认首个选项）",
    "/polymarket bet &lt;market-slug 或热门序号&gt; &lt;outcome&gt; &lt;USDC&gt;：生成手动下注链接",
  ].join("\n");
}
