---
"@molpha/mcp": patch
---

A policy round's `outcome` is read from the signed value (a value among the source's fallback words is the fallback), not passed through from the gateway's unsigned label; the label only supplies the `reason`. `simulate_source` does not take an answer whose `sourceId` is not the sent source's.
