# Reading a Molpha feed on Solana

Source: the Molpha Solana program (`molpha-solana-program`, `state/feed.rs` and `guides/INTEGRATION.md`) and the SDK. Everything here is for Solana **Devnet**. The program is upgradeable and changes often; the program id below is the one recorded in the source checked out when this was written. Confirm it with `get_capabilities` (`programId`) before relying on it.

Program id (devnet, current interface): `chivcFQgxzwkpLvW41PV431HQ4dYpaW3povQH3AdpQt`.

## The feed account

A feed is a PDA of the program, one per `(sourceId, signaturesRequired, submitter)`:

```text
seeds = [ b"molpha_feed", source_id (32 bytes), [signatures_required] (1 byte), submitter (32 bytes) ]
```

`signatures_required` is a single `u8` byte (`to_le_bytes()` of a `u8`). The `submitter` is the wallet that submitted, so each submitting wallet maintains its own feed for a source. A feed with a lower quorum or another submitter is a **different feed**.

Account data, Anchor layout (151 bytes):

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 8 | discriminator | `[69, 191, 16, 227, 132, 187, 84, 227]` |
| 8 | 32 | `source_id` | |
| 40 | 32 | `value` | The signed 32-byte value, or the keccak hash of a longer preimage |
| 72 | 1 | `value_kind` | `0` = `Value`, `1` = `Hash` |
| 73 | 32 | `submitter` | |
| 105 | 8 | `timestamp` | `u64` little-endian, unix **milliseconds** |
| 113 | 1 | `signatures_required` | |
| 114 | 32 | `signers_bitmap` | Which registry nodes signed |
| 146 | 4 | `registry_version` | `u32` little-endian |
| 150 | 1 | `bump` | |

These offsets come from the program source and the SDK's IDL, which agree. Older program versions used a different layout (a `feed_id`, a `canonical_timestamp` in seconds); do not mix them. Decode with the IDL for the program you target, not with these offsets in production code.

## What a consumer must check

Every one of these is the consumer's job. A valid signature does not do them.

1. **Ownership.** The account is owned by the Molpha program and has the `Feed` discriminator. Without this, anyone can hand you an account they wrote.
2. **Identity.** `source_id`, `signatures_required` and `submitter` are the ones you expect. Derive the address from values **you** chose in advance, not from values an untrusted party gives you.
3. **Quorum floor.** `sourceId` does not commit the quorum. Require `signatures_required` to be at least what your application needs.
4. **Freshness.** `timestamp` is milliseconds. Compare `timestamp / 1000` with the cluster clock and reject anything older than you tolerate. A feed does not expire on its own.
5. **Encoding.** `value` is 32 bytes whose meaning is agreed per source. When `value_kind` is `Hash`, obtain the preimage and check `keccak256(preimage) == value`. In tolerance mode the 32 bytes are a signed int256 scaled by `10^decimals`; in exact mode the scale is not attested (see `apiconfig.md`).
6. **Registry.** `registry_version` says which node set signed. Decide whether you accept it.

The program accepts an update only when it is strictly newer than the stored one, on the same source and quorum, so the feed only moves forward.

## Reading from a client (TypeScript)

With the SDK, from a funded or read-only wallet:

```ts
import { MolphaSolanaClient, feedPda, MOLPHA_PROGRAM_ID } from "@molpha/sdk";

// readFeed(sourceId, signaturesRequired, submitter = this client's wallet)
const feed = await solana.readFeed(sourceId, 3, submitter);
// null before the first submit; otherwise value, valueKind, timestamp, registryVersion, ...
```

Check the exports against the SDK version you install; the dev snapshots move. `feedPda(sourceId, signaturesRequired, submitter, programId)` derives the address without a client.

The MCP does the same read for you: `get_latest_value` and `describe_feed` with an explicit `submitter`.

## Reading from an Anchor program

There is **no published consumer example** for this interface. The snippet below is written from the account layout. A static Solana-program linter reported no findings, but it has **not been compiled or run**. Treat it as a starting point and build it against the IDL of the program version you target.

```rust
use anchor_lang::prelude::*;

pub const MOLPHA_PROGRAM_ID: Pubkey = pubkey!("chivcFQgxzwkpLvW41PV431HQ4dYpaW3povQH3AdpQt");
/// Anchor's discriminator for the `Feed` account.
const FEED_DISCRIMINATOR: [u8; 8] = [69, 191, 16, 227, 132, 187, 84, 227];

/// Mirror of the program's `Feed` account body. Prefer generating it from the IDL (`declare_program!`).
#[derive(AnchorDeserialize)]
pub struct MolphaFeed {
    pub source_id: [u8; 32],
    pub value: [u8; 32],
    pub value_kind: u8, // 0 = Value, 1 = Hash (a unit-variant enum in the real program)
    pub submitter: Pubkey,
    pub timestamp: u64, // unix milliseconds
    pub signatures_required: u8,
    pub signers_bitmap: [u8; 32],
    pub registry_version: u32,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct ReadPrice<'info> {
    /// CHECK: owner, discriminator, address (seeds) and contents are all checked in `read_price`.
    pub feed: UncheckedAccount<'info>,
}

pub fn read_price(
    ctx: Context<ReadPrice>,
    expected_source_id: [u8; 32],
    min_signatures: u8,
    expected_submitter: Pubkey,
    max_age_ms: u64,
) -> Result<u64> {
    let info = ctx.accounts.feed.to_account_info();

    // 1. Ownership: only the Molpha program can have written this account.
    require_keys_eq!(*info.owner, MOLPHA_PROGRAM_ID, ErrorCode::ConstraintOwner);

    // 2. Identity: the address must be the PDA for the values *you* expect, with the quorum you require.
    let (expected_address, _) = Pubkey::find_program_address(
        &[b"molpha_feed", &expected_source_id, &[min_signatures], expected_submitter.as_ref()],
        &MOLPHA_PROGRAM_ID,
    );
    require_keys_eq!(info.key(), expected_address, ErrorCode::ConstraintSeeds);

    let data = info.try_borrow_data()?;
    require!(data.len() >= 8 && data[..8] == FEED_DISCRIMINATOR, ErrorCode::AccountDiscriminatorMismatch);
    let feed = MolphaFeed::deserialize(&mut &data[8..])?;

    // 3. Freshness: timestamp is milliseconds, the cluster clock is seconds.
    let now_ms = (Clock::get()?.unix_timestamp as u64).saturating_mul(1000);
    require!(now_ms.saturating_sub(feed.timestamp) <= max_age_ms, ErrorCode::ConstraintRaw);

    // 4. Encoding: decode `feed.value` per the source's agreed encoding (see apiconfig.md).
    //    Here: an unsigned integer in the low 8 bytes of the big-endian word.
    require!(feed.value_kind == 0, ErrorCode::ConstraintRaw);
    Ok(u64::from_be_bytes(feed.value[24..32].try_into().unwrap()))
}
```

Using the quorum as a seed means this reads exactly the feed at `min_signatures`; a feed at a higher quorum is a different account, so require the one you want. Use your own error enum in a real program: the Anchor `ErrorCode` variants above are placeholders.

## Writing a feed

Anyone can submit a signed attestation; the program verifies the aggregate signature on chain. Submitting costs SOL, and the submitter's address is part of the feed's seeds. From the MCP: `autoSubmit` on a round tool, or `submit_attestation`. From code: `solana.submitAttestation(result)`; the SDK builds the instruction, resolves the signer accounts and sets the compute budget.

## Trust notes

- The oracle signature proves a quorum of **registered nodes** signed the payload. The node set is permissioned on devnet and the program is pre-audit.
- A feed can lag. Never treat "the feed exists" as "the feed is current".
