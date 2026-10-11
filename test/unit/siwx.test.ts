import { address, createKeyPairFromPrivateKeyBytes, getBase58Decoder, signBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { assertChallenge, encodeSiwxHeader, formatSiwsMessage, siwxStatement, type SiwxMessageFields, type SiwxTerms } from "../../src/siwx.js";

/*
 * The golden vector, shared with the gateway
 * (gateway internal/gateway/features/session/siwx/siwx_test.go): the same fields must
 * render the same text and the same key must produce the same signature, or a message
 * this server hands a wallet would not be the one the gateway verifies.
 */
const GOLDEN_ADDRESS = address("9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj"); // ed25519 seed 0x01..0x20
const GOLDEN_OWNER = address("c8fpTXm3XTRgE5maYQ24Li4L65wMYvAFomzXknxVEx7");
const GATEWAY_PDA = address("H6DDMmWivXh8GdBaxwsZQbwWXwKwPSx3SdmSyJV24yXd");
const PROGRAM_ID = address("MoLFnEbuMS5gWnXNfUMLAYSqRM3eQZKWRzjeMQfqbT3");
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const GOLDEN_MESSAGE = `gateway.molpha.test wants you to sign in with your Solana account:
9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj

Sign in to Molpha gateway H6DDMmWivXh8GdBaxwsZQbwWXwKwPSx3SdmSyJV24yXd as subscriber or delegate. This signature does not move funds.

URI: https://gateway.molpha.test/v1/session
Version: 1
Chain ID: EtWTRABZaYq6iMfeYKouRu166VU2xqa1
Nonce: 5f3a9c0e7b1d4a26c8e0f1a2b3c4d5e6
Issued At: 2026-10-07T12:00:00.000Z
Expiration Time: 2026-10-07T12:05:00.000Z
Resources:
- molpha:program:MoLFnEbuMS5gWnXNfUMLAYSqRM3eQZKWRzjeMQfqbT3
- molpha:gateway:H6DDMmWivXh8GdBaxwsZQbwWXwKwPSx3SdmSyJV24yXd
- molpha:subscription:c8fpTXm3XTRgE5maYQ24Li4L65wMYvAFomzXknxVEx7`;
const GOLDEN_SIGNATURE = "5eWifHeuMjRpo7AHek1d9QtKWVG83xZ1YdPgyNxhYwKzo52fdM74fGgnZ6SkJDYbz7v5iw4bKz2spDKe63ndcfSp";
const ISSUED_AT_MS = Date.parse("2026-10-07T12:00:00.000Z");

const goldenFields = (): SiwxMessageFields => ({
  domain: "gateway.molpha.test",
  uri: "https://gateway.molpha.test/v1/session",
  statement: siwxStatement(GATEWAY_PDA),
  version: "1",
  nonce: "5f3a9c0e7b1d4a26c8e0f1a2b3c4d5e6",
  issuedAt: "2026-10-07T12:00:00.000Z",
  expirationTime: "2026-10-07T12:05:00.000Z",
  resources: [`molpha:program:${PROGRAM_ID}`, `molpha:gateway:${GATEWAY_PDA}`, `molpha:subscription:${GOLDEN_OWNER}`],
  address: GOLDEN_ADDRESS,
  chainId: NETWORK
});

const terms: SiwxTerms = {
  endpoint: "https://gateway.molpha.test",
  network: NETWORK,
  programId: PROGRAM_ID,
  gatewayPda: GATEWAY_PDA,
  address: GOLDEN_ADDRESS,
  owner: GOLDEN_OWNER
};

/** The gateway's GET /v1/session/challenge `data` for some fields. */
const challengeOf = (fields: SiwxMessageFields, message = formatSiwsMessage(fields)) => {
  const { address: signer, chainId, ...info } = fields;
  return { info, supportedChains: [{ chainId, type: "ed25519", signatureScheme: "siws" }], address: signer, owner: GOLDEN_OWNER, chainId, message };
};

describe("formatSiwsMessage", () => {
  it("renders the golden message the gateway verifies", () => {
    expect(formatSiwsMessage(goldenFields())).toBe(GOLDEN_MESSAGE);
  });

  it("is signed to the golden signature by the golden key", async () => {
    const { privateKey } = await createKeyPairFromPrivateKeyBytes(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    const signature = await signBytes(privateKey, new TextEncoder().encode(GOLDEN_MESSAGE));
    expect(getBase58Decoder().decode(signature)).toBe(GOLDEN_SIGNATURE);
  });
});

describe("encodeSiwxHeader", () => {
  it("is base64 JSON of the signed terms in the x402 sign-in-with-x payload shape", () => {
    const payload = JSON.parse(Buffer.from(encodeSiwxHeader(goldenFields(), GOLDEN_SIGNATURE), "base64").toString("utf8"));
    expect(payload).toEqual({ ...goldenFields(), type: "ed25519", signatureScheme: "siws", signature: GOLDEN_SIGNATURE });
  });
});

describe("assertChallenge", () => {
  it("accepts a challenge that states this server's terms for its gateway", () => {
    expect(assertChallenge(terms, challengeOf(goldenFields()), ISSUED_AT_MS)).toEqual(goldenFields());
  });

  it.each<[string, (fields: SiwxMessageFields) => void, RegExp]>([
    ["another domain", (f) => (f.domain = "evil.example"), /is for domain evil\.example/],
    ["another URI", (f) => (f.uri = "https://gateway.molpha.test/v1/other"), /is for URI/],
    ["another chain", (f) => (f.chainId = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), /is for chain/],
    ["another version", (f) => (f.version = "2"), /has version 2/],
    ["another address", (f) => (f.address = GOLDEN_OWNER), /is for address/],
    ["a statement that asks for something else", (f) => (f.statement = "Approve a transfer of all funds."), /sign-in statement/],
    ["another gateway in the statement", (f) => (f.statement = siwxStatement(PROGRAM_ID)), /sign-in statement/],
    ["another gateway in the resources", (f) => (f.resources[1] = `molpha:gateway:${PROGRAM_ID}`), /resources/],
    ["another owner in the resources", (f) => (f.resources[2] = `molpha:subscription:${GOLDEN_ADDRESS}`), /resources/],
    ["an extra resource", (f) => f.resources.push("https://evil.example"), /resources/],
    ["a nonce that could break out of its line", (f) => (f.nonce = "5f3a9c0e7b1d4a26\nURI: https://evil.example"), /malformed nonce/],
    ["an issuedAt from another day", (f) => (f.issuedAt = "2026-10-06T12:00:00.000Z"), /not issued now/],
    ["an expiry a day out", (f) => (f.expirationTime = "2026-10-08T12:00:00.000Z"), /expiry/],
    ["no expiry", (f) => (f.expirationTime = ""), /has no expirationTime/]
  ])("refuses %s", (_label, mutate, error) => {
    const fields = goldenFields();
    mutate(fields);
    expect(() => assertChallenge(terms, challengeOf(fields), ISSUED_AT_MS)).toThrow(error);
  });

  it("refuses message text that says something its fields do not", () => {
    const tampered = GOLDEN_MESSAGE.replace("does not move funds", "moves all funds");
    expect(() => assertChallenge(terms, challengeOf(goldenFields(), tampered), ISSUED_AT_MS)).toThrow(/does not match its own terms/);
  });

  it("refuses an expired or malformed challenge", () => {
    expect(() => assertChallenge(terms, challengeOf(goldenFields()), ISSUED_AT_MS + 301_000)).toThrow(/not issued now|expiry/);
    expect(() => assertChallenge(terms, undefined, ISSUED_AT_MS)).toThrow(/malformed/);
    expect(() => assertChallenge(terms, { info: {} }, ISSUED_AT_MS)).toThrow(/has no/);
  });
});
