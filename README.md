# LinVerseHelperBot
Telegram bot on Cloudflare Workers.

## Configuration

Required Worker bindings/variables:

- `DATA_DB`: Cloudflare D1 database
- `TG_TOKEN`: Telegram bot token
- `BOT_NAME`: Telegram bot username, without `@`

Apply the D1 migration before deploying:

```sh
npx wrangler d1 migrations apply tg-linbot --remote
```

The migration imports records stored in the old D1 `kv_store` table, replaces it
with `group_members` and `repeat_state`, then drops `kv_store`. It does not import
values that exist only in the old Cloudflare KV namespace; the bot no longer
requires or reads that namespace.

## Market commands

- `/polymarket` or `/polymarket hot`: show the five active markets with highest 24-hour volume.
- `/polymarket book <market-slug-or-hot-rank> [outcome]`: show the selected outcome's top five bids and asks. Outcome defaults to the first listed outcome.
- `/polymarket bet <market-slug-or-hot-rank> <outcome> <USDC>`: prepare a market link with the chosen outcome and stake amount. The bot does not submit orders or handle wallet keys; confirm and place the trade on Polymarket.
- `/binance [symbol]`: show Binance Spot 24-hour price/change, high/low, quote volume, and best bid/ask. Defaults to `BTCUSDT`.

Hot-market ranks are resolved against the current 24-hour-volume list. Market slugs are shown in `/polymarket` output.

## Existing commands

The bot also supports tarot, tagging, notifications, group mentions, and repeat handling.

## Thanks

Thanks to [Shinokawa/tarotQQBot](https://github.com/Shinokawa/tarotQQBot/)
