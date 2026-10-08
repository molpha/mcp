# Verifying a Molpha attestation on EVM

Sources: the `molpha-core-contracts` repository (`IVerifier.sol`, `VerifyCodes.sol`, and the consumer library with its guide `docs/consumer-sdk.md`, on the `chivchyn` and `timestamp-v2` branches) and the SDK's EVM helpers. Testnet only: Sepolia and other test networks.

## Read this first: what is and is not deployed

- The current interface is `verify(Attestation calldata attestation, uint64 maxAge) returns (bool success, uint8 code)`. It exists in source on those branches.
- **No deployment of that interface is recorded.** The source's deployment file is marked provisional ("No deployment exists for the verify(Attestation,uint64) interface yet"), the consumer library's address constant is the zero address, and the previously deployed address is listed there as deprecated, for an older interface (`verify(DataUpdate, SchnorrSignature, ...)`).
- The SDK's dev build falls back to that older address and flags it provisional. So the address returned by `get_capabilities` or `build_verifier_calldata` may not speak this interface.
- Before you build on an address, check it: read the contract on an explorer, or `eth_call` `getRegistryVersion()` and then `verify` with a known attestation, and confirm the selector exists (`0x67e2907b` for the current `verify`). Tell the user plainly if you could not.
- The consumer library ships as a release candidate (`1.0.0-rc.N`); its own guide says that stays so until the audited build is deployed.

## The call

```solidity
struct AttestationPayload {
    bytes32 value;            // 32 bytes: a word, or keccak256 of encoded fields
    bytes32 sourceId;
    uint32  registryVersion;
    uint8   signaturesRequired;
    uint64  timestamp;        // unix MILLISECONDS
}
struct SchnorrSignature {
    bytes32 signature;        // scalar s
    address commitment;       // address of the commitment point R
    uint256 signersBitmap;
}
struct Attestation { AttestationPayload payload; SchnorrSignature signature; }

function verify(Attestation calldata attestation, uint64 maxAge)
    external view returns (bool success, uint8 code);
```

- `verify` is `view` and **never reverts on the verification path**: every rejection is `(false, code)`. Always read `success`; a call that does not revert is not a pass.
- `maxAge` is seconds, compared against `timestamp / 1000` and `block.timestamp`. `0` disables the freshness check. It is not a neutral default: a stateless verifier accepts a correctly signed attestation forever.
- `timestamp` is milliseconds. Do the division yourself in any code that compares it.

### Result codes

| Code | Name | Meaning |
|---|---|---|
| 0 | `OK` | Verified |
| 2 | `BAD_REGISTRY_VERSION` | `registryVersion` does not exist on this verifier |
| 3 | `MALFORMED` | Structurally invalid input, or dated in the future when `maxAge != 0` |
| 4 | `NOT_YET_ACTIVE` | `timestamp` predates the registry version's activation |
| 5 | `VERSION_EXPIRED` | Version superseded more than the grace window earlier |
| 7 | `BAD_QUORUM` | Signers are not within the round's derived selection group |
| 8 | `BAD_AGGREGATE` | The signers' aggregate key is the point at infinity |
| 9 | `BAD_SIGNATURE` | The aggregate Schnorr signature does not verify |
| 10 | `STALE` | Older than `maxAge` |

Codes 1 and 6 are reserved and never returned. Codes are append-only. Library codes in `0xF0` to `0xFF` belong to the consumer library, not the verifier.

## What `verify` does not do

`verify` authenticates a signature and nothing else. A consumer contract must still:

1. **Pin the source.** Check `payload.sourceId` equals the one you expect.
2. **Set its own quorum floor.** `sourceId` commits the source's configuration, **not** `signaturesRequired`, which is chosen by whoever requested the round. The verifier only rejects a zero quorum. A consumer that pins `sourceId` without its own `minSignatures` accepts whatever threshold the protocol permits.
3. **Guard replay.** `verify` is `view`: the same attestation verifies forever. Any state-changing consumer needs a guard. The library offers `Latest.acceptNewer` (strictly greater timestamp than the last accepted; default) and `Consumed.consumeOnce`.
4. **Choose freshness.** Pass a real `maxAge`. Monotonicity is not recency: with `maxAge == 0` a consumer's first accepted attestation can be arbitrarily old.
5. **Decode the value.** `value` is 32 bytes. A single static type (`uintN`, `intN`, `bool`, `address`, `bytesN`) is the word itself; anything else is `keccak256` of the ABI-encoded fields, and you must pass and check the preimage.
6. **Handle the result.** Read `success`. Do not treat a returned tuple as a pass.

## Using the consumer library

The library layers those checks outside the verifier. From its guide, the whole integration:

```solidity
import {IVerifier} from "@molpha/evm-verifier/interfaces/IVerifier.sol";
import {MolphaLib} from "@molpha/evm-verifier/consumer/MolphaLib.sol";

contract Consumer {
    using MolphaLib for IVerifier;
    using MolphaLib for MolphaLib.Latest;

    IVerifier public immutable VERIFIER;
    MolphaLib.Policy internal policy;
    MolphaLib.Latest internal latest;

    constructor(IVerifier verifier, bytes32 sourceId) {
        VERIFIER = verifier;
        policy = MolphaLib.Policy({sourceId: sourceId, minSignatures: 5, maxAge: 3600});
    }

    function settle(IVerifier.Attestation calldata att) external {
        VERIFIER.requireValid(att, policy);
        latest.acceptNewer(att.payload);
        _apply(MolphaLib.asInt256(att.payload.value));
    }
}
```

- `requireValid` reverts on any failure; `isValid` returns a code instead, for batch or keeper contracts that must skip a bad attestation.
- Check order: policy valid, source matches, threshold meets `minSignatures`, kind-B payload hash matches, then `verify`. The cheap checks run first.
- **`Latest` carries no `sourceId`.** Sharing one `Latest` between two sources makes them reject each other's updates. Keep `mapping(bytes32 => Latest)`.
- Replay guards mutate state: call them before any external interaction.
- Install: package `@molpha/evm-verifier` (a release candidate), remapping `@molpha/evm-verifier/=lib/evm-verifier/src/`. The library's `MolphaAddresses.VERIFIER` is `address(0)` until an audited build is deployed, so pass the verifier address to the constructor yourself and verify it.
- Tests: `MockVerifier` (configurable `(ok, code)`, no crypto) and `MolphaTestSigner` (real keys and signatures, Foundry). A mock cannot record arguments because `verify` is `view`; use `vm.expectCall`.

Value-decoding helpers (`asUint256`, `asInt256`, `asBool`, `asAddress`) reject non-canonical encodings. Scale and decimals are part of the source's configuration, not of the value: a tolerance-mode source commits its `decimals` in the `sourceId`; an exact-mode source's scale is off-chain (see `apiconfig.md`).

## Calling from a client (TypeScript, SDK)

```ts
import { buildEvmVerifierArgs, MOLPHA_VERIFIER_ABI, parseEvmVerifyResult } from "@molpha/sdk";

const { attestation, maxAge } = buildEvmVerifierArgs(result, { maxAge: 300 });
const returned = await client.readContract({
  address: VERIFIER_ADDRESS,          // a verifier you have checked, see above
  abi: MOLPHA_VERIFIER_ABI,
  functionName: "verify",
  args: [attestation, maxAge],
});
const { success, code, reason } = parseEvmVerifyResult(returned);
```

`maxAge` is required by the builder. `encodeEvmVerifyCalldata` gives raw calldata for `eth_call`. `parseEvmVerifyResult` throws when `success` and `code` disagree, which means the call did not reach a verifier of this interface.

The MCP's `build_verifier_calldata` returns the same arguments and the address; it sends nothing.

## Trust notes

- Verification proves a quorum of registered nodes signed the payload. The node set is permissioned on testnet.
- The verifier is stateless, but its node registry is managed by an owner-only role. Find out who holds it before relying on it.
- Registry versions change; an old version stays usable only for a short grace window after its successor activates.
