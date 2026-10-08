# Verifying a Molpha attestation on Starknet

Sources: the `molpha-starknet` repository (`verifier/src/interface.cairo`, `verifier.cairo`, `verify_codes.cairo`, `verifier/README.md`) and the SDK's Starknet helpers. Starknet Sepolia only.

## Read this first: what is and is not known

- The interface below is what the source implements. The recorded Starknet Sepolia deployment is dated **2026-07-19**, before the latest interface and timestamp change. **Whether the deployed class matches this interface is not known from the source.**
- Before you build on a verifier address, confirm it: call `verify` with a known attestation through `starknet_call` and see whether the entrypoint and the 13-felt calldata are accepted. If you cannot confirm, say so.
- There is **no Cairo consumer example** for this interface. Nothing below the interface section has been compiled.

## The call

```cairo
#[derive(Drop, Serde, Copy)]
pub struct AttestationPayload {
    pub value: u256,
    pub source_id: u256,
    pub registry_version: u32,
    pub signatures_required: u8,
    pub timestamp: u64,            // unix MILLISECONDS
}

#[derive(Drop, Serde, Copy)]
pub struct SchnorrSignature {
    pub signature: u256,
    pub commitment: felt252,       // the 20-byte commitment address as a felt
    pub signers_bitmap: u256,
}

#[derive(Drop, Serde, Copy)]
pub struct Attestation { pub payload: AttestationPayload, pub signature: SchnorrSignature }

fn verify(self: @TContractState, attestation: Attestation, max_age: u64) -> (bool, u8);
```

Field order is load-bearing: it is the order of the signed message and the same on EVM and Solana. Serialized, the arguments are **13 felts** (a `u256` is two felts).

- `verify` is a **total function**: it never panics for any well-formed calldata. Every rejection is `(false, code)`. Calldata that does not decode (an out-of-range integer) fails at `Serde` and reverts instead of returning a code.
- `max_age` is seconds. `0` disables freshness, which is not a neutral default: a stateless verifier accepts a correctly signed attestation forever.
- `timestamp` is milliseconds. The verifier compares `timestamp / 1000` against the block timestamp.

### Result codes

The codes are shared with the EVM and Solana verifiers and are append-only.

| Code | Name | Meaning |
|---|---|---|
| 0 | `OK` | Verified |
| 2 | `BAD_REGISTRY_VERSION` | `registry_version` does not exist on this verifier |
| 3 | `MALFORMED` | Structurally invalid input, or dated in the future when `max_age != 0` |
| 4 | `NOT_YET_ACTIVE` | `timestamp` predates the registry version's activation |
| 5 | `VERSION_EXPIRED` | Version superseded more than the grace window earlier |
| 7 | `BAD_QUORUM` | Signers are not within the round's derived selection group |
| 8 | `BAD_AGGREGATE` | The signers' aggregate key is the point at infinity |
| 9 | `BAD_SIGNATURE` | The aggregate Schnorr signature does not verify |
| 10 | `STALE` | Older than `max_age` |

Codes 1 and 6 are reserved and never returned.

## What `verify` does not do

Exactly the same list as EVM (see `integrate-evm.md`), and Cairo has no consumer library for it. A consumer contract must itself:

1. Check `payload.source_id` is the one it expects.
2. Enforce its own minimum `signatures_required`. `source_id` does not commit the quorum.
3. Guard replay. `verify` is a view; the same attestation verifies forever. Track the last accepted timestamp **per source**.
4. Pass a real `max_age`.
5. Decode `value` per the source's agreed encoding. In tolerance mode it is a signed int256 scaled by `10^decimals`; in exact mode the scale is off-chain (see `apiconfig.md`).
6. **Read the returned boolean.** Because `verify` does not panic, a call that returns is not a pass.

A panic inside a cross-contract call aborts the caller's whole transaction, which is why `verify` returns codes instead. Handle each code deliberately: some failures are transient and expected, such as a registry mirror lagging one version (`BAD_REGISTRY_VERSION`).

## Calling from a client (TypeScript, SDK)

```ts
import { RpcProvider } from "starknet";
import { buildStarknetVerifierArgs, encodeStarknetVerifyCalldata, parseStarknetVerifyResult } from "@molpha/sdk";

const provider = new RpcProvider({ nodeUrl: STARKNET_RPC_URL });
const args = buildStarknetVerifierArgs(result, { maxAge: 300 });

const response = await provider.callContract({
  contractAddress: VERIFIER_ADDRESS,   // a verifier you have confirmed, see above
  entrypoint: "verify",
  calldata: encodeStarknetVerifyCalldata(args),
});
const { success, code, reason } = parseStarknetVerifyResult(response);
```

`maxAge` is required by the builder. The MCP's `build_verifier_calldata` returns the same arguments for the `starknet` chain; it sends nothing.

## Trust notes

- Verification proves a quorum of registered nodes signed the payload. The node set is permissioned on testnet and the contracts are pre-audit.
- One deliberate divergence from EVM: node registration's proof-of-possession hashes the contract address differently. It is checked only at registration, never in `verify`, so cross-chain payload verification is unaffected.
- Registry versions are versioned, and an old version stops being usable 60 seconds after its successor activates.
