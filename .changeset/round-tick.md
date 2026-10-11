---
"@molpha/mcp": minor
---

Follow the protocol's fixed 100 ms round tick (`ROUND_TICK_MS = 100`, a protocol constant the server hardcodes).

The gateway stamps each round with its own clock rounded down to the tick. Requests for one feed (the same source, quorum and registry version) inside one tick share a round, a feed runs at most 10 rounds per second, and one wallet gets at most one round per tick for a feed.

- HTTP 409 means the consumer or payer already has a round for the feed in the current tick (or an x402 payment already reserved a round). `execute_x402_round` and the hosted `execute_subscription_round` repeat the request once, after one full tick plus a small jitter (100 to 120 ms); an x402 round resends the same payment, which a 409 leaves unspent. The stdio `execute_subscription_round` retries inside `@molpha/sdk`, on that package's own schedule.
- A request still refused with 409 fails with the error code `round_conflict`.
- HTTP 503 keeps the code `round_timeout`, and its remediation names the usual cause: the gateway's own capacity limit (`gateway at capacity`), which refuses a request before reading it, so nothing is reserved or spent. Otherwise too few nodes accepted or finished the round; a node refuses a gateway only as a safety limit. A paid x402 request is never resent after a 503: once the gateway has asked the nodes to work, its payment is spent even if the round fails, so a retry signs a new payment.
