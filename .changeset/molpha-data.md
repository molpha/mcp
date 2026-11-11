---
"@molpha/mcp": minor
---

Molpha Data tools: `list_data_templates`, `read_data`, `execute_data_round` and one read tool per template of the Molpha Data catalog
(`get_pool_price`, `get_lst_rate`, `get_aave_health_factor`, `get_token_supply`, ... 21 in all).

- The read tools are read-only on every server: the Molpha Data service's own unsigned read, with the source it
  read, re-hashed here.
- `execute_data_round` (servers with a signer) derives the source at the service, re-hashes it, and runs it through
  `execute_subscription_round` (or `execute_x402_round` with `payment: "x402"`), so the dry-run lock and spend caps
  apply unchanged. On the hosted server, a read tool's `source` goes to the session or x402 tools.
- The tool set is generated from a committed snapshot of the catalog (`src/data-catalog.generated.ts`,
  `npm run sync:data-catalog`, `npm run check:data-catalog`).
- New settings `MOLPHA_DATA_URL` (default `https://data.molpha.io`) and `MOLPHA_DATA_API_KEY`; new error codes
  `invalid_data_request` and `data_unavailable`.
