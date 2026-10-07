import { BN, BorshAccountsCoder, type Idl } from "@anchor-lang/core";
import {
  address,
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase58Encoder,
  getPublicKeyFromAddress,
  signatureBytes,
  signBytes,
  verifySignature,
  type Address
} from "@solana/kit";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveDelegatePda, readAccess } from "../../src/access.js";
import { getMolphaProgramId, type MolphaContext, type ToolDependencies } from "../../src/clients.js";
import { type MolphaConfig } from "../../src/config.js";
import { requireSdkExport } from "../../src/sdk.js";
import { beginSession, completeSession, executeSessionRound, sessionEndpoint, type SessionContext } from "../../src/session.js";
import { formatSiwsMessage, siwxStatement, SIWX_HEADER, type SiwxMessageFields } from "../../src/siwx.js";
import { x402Timing } from "../../src/x402.js";
import { deriveGatewayPda } from "../../src/x402-payment.js";
import { callTool, callToolError } from "./tool-harness.js";

const programId = getMolphaProgramId();
const GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const apiConfig = { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" };
const sourceId = requireSdkExport<(config: Record<string, unknown>) => string>("deriveSourceIdString")(apiConfig);
const randomAddress = (): Address => address(Keypair.generate().publicKey.toBase58());

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Wallet {
  address: Address;
  /** Signs UTF-8 text as a wallet's signMessage does; base58. */
  sign(message: string): Promise<string>;
}

async function newWallet(): Promise<Wallet> {
  const { privateKey, publicKey } = await createKeyPairFromPrivateKeyBytes(new Uint8Array(randomBytes(32)));
  return {
    address: await getAddressFromPublicKey(publicKey),
    sign: async (message) => getBase58Decoder().decode(await signBytes(privateKey, new TextEncoder().encode(message)))
  };
}

interface Env {
  ctx: SessionContext & { connection: SessionContext["connection"] & { getAccountInfo: ReturnType<typeof vi.fn> } };
  endpoint: string;
  gatewayPda: Address;
  fetch: ReturnType<typeof vi.fn>;
  /** owner → delegates with access, as the gateway reads them from chain. */
  access: Map<string, Set<string>>;
  /** token → who signed in. */
  sessions: Map<string, { authority: string; owner: string }>;
  rounds: Array<{ token: string | undefined; body: Record<string, unknown> }>;
  usedNonces: Set<string>;
  onRound?: (attempt: number) => Response | undefined;
  hosted: ToolDependencies;
}

let counter = 0;

/**
 * A gateway that behaves as the real one does on the session routes: it states its own terms,
 * rebuilds the signed message from the payload, verifies the signature, burns the nonce, checks
 * access, and admits a round only for a token it issued.
 */
async function setup(): Promise<Env> {
  counter += 1;
  const endpoint = `https://gateway-${counter}.test`;
  const authority = randomAddress();
  const gatewayPda = await deriveGatewayPda(authority, programId);
  const access = new Map<string, Set<string>>();
  const sessions = new Map<string, { authority: string; owner: string }>();
  const usedNonces = new Set<string>();
  const rounds: Env["rounds"] = [];
  const env = {} as Env;

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(endpoint);
    const headers = new Headers(init?.headers);

    if (url.pathname === "/v1/session/challenge") {
      const signer = url.searchParams.get("address")!;
      const owner = url.searchParams.get("owner") ?? signer;
      const issued = new Date();
      const fields: SiwxMessageFields = {
        domain: url.host,
        uri: `${endpoint}/v1/session`,
        statement: siwxStatement(gatewayPda),
        version: "1",
        nonce: randomBytes(16).toString("hex"),
        issuedAt: issued.toISOString(),
        expirationTime: new Date(issued.getTime() + 300_000).toISOString(),
        resources: [`molpha:program:${programId}`, `molpha:gateway:${gatewayPda}`, `molpha:subscription:${owner}`],
        address: signer,
        chainId: NETWORK
      };
      const { address: _a, chainId: _c, ...info } = fields;
      return json(200, {
        status: "ok",
        data: { info, supportedChains: [{ chainId: NETWORK, type: "ed25519", signatureScheme: "siws" }], address: signer, owner, chainId: NETWORK, message: formatSiwsMessage(fields) }
      });
    }

    if (url.pathname === "/v1/session" && init?.method === "POST") {
      const payload = JSON.parse(Buffer.from(headers.get(SIWX_HEADER) ?? "", "base64").toString("utf8")) as SiwxMessageFields & {
        signature: string;
        type: string;
      };
      const signature = new Uint8Array(getBase58Encoder().encode(payload.signature));
      const valid =
        payload.type === "ed25519" &&
        payload.domain === url.host &&
        (await verifySignature(
          await getPublicKeyFromAddress(address(payload.address)),
          signatureBytes(signature),
          new TextEncoder().encode(formatSiwsMessage(payload))
        ));
      if (!valid) return json(401, { error: "invalid_siwx_signature: signature does not verify" });
      if (usedNonces.has(payload.nonce)) return json(401, { error: "invalid_siwx_nonce: this sign-in message was already used" });
      const owner = payload.resources[2]!.replace("molpha:subscription:", "");
      if (!access.get(owner)?.has(payload.address)) return json(403, { error: "forbidden: subscription is inactive" });
      usedNonces.add(payload.nonce);
      const token = `molpha_sess_${randomBytes(32).toString("base64url")}`;
      sessions.set(token, { authority: payload.address, owner });
      const now = Math.floor(Date.now() / 1000);
      return json(201, {
        status: "ok",
        data: { token, tokenType: "Bearer", sessionId: randomBytes(16).toString("hex"), authority: payload.address, owner,
          role: owner === payload.address ? "owner" : "delegate", gatewayPda, programId, issuedAt: now, expiresAt: now + 1800 }
      });
    }

    if (url.pathname === "/v1/round/execute") {
      const token = headers.get("authorization")?.replace(/^Bearer /, "");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      rounds.push({ token, body });
      const override = env.onRound?.(rounds.length);
      if (override) return override;
      const session = token ? sessions.get(token) : undefined;
      if (!session) return json(401, { error: "unauthorized: session token is unknown, expired or revoked; sign in again" });
      // Access is read from chain for every round, whatever the token says.
      if (!access.get(session.owner)?.has(session.authority)) return json(403, { error: "forbidden: delegate account is required" });
      return json(200, {
        status: "completed",
        data: {
          attestation: {
            payload: { value: "ab".repeat(32), sourceId, registryVersion: body.registryVersion, signaturesRequired: body.signaturesRequired,
              timestamp: Math.floor(Date.now() / 1000) * 1000 },
            signature: { signature: "11".repeat(32), commitment: "22".repeat(20), signersBitmap: "3" }
          },
          value: "42", fresh: true, configHash: sourceId
        }
      });
    }
    throw new Error(`unexpected request ${init?.method ?? "GET"} ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const config: MolphaConfig = {
    gatewayEndpoints: [endpoint], gatewayAuthorities: [authority], solanaRpc: "http://solana.test", ownerKeypair: undefined,
    evmNetworks: [], starknetNetworks: [], guardrails: { maxExecutesPerDay: 100, dryRunDefault: false },
    x402: { maxPriceUsdcAtomic: 1_000_000n, maxSpendPerDayUsdcAtomic: 10_000_000n }
  };
  const ctx = {
    config,
    connection: { getGenesisHash: vi.fn(async () => GENESIS_HASH), getAccountInfo: vi.fn(async () => null) },
    solana: { getRegistrySelectionConfig: async () => ({ registryVersion: 3, redundancyBuffer: 1, nodeCount: 3 }), readSubscription: vi.fn(async () => null) },
    gateway: { fetchGatewayInfo: vi.fn(async () => ({ gatewayAuthority: authority })) }
  } as unknown as Env["ctx"];

  Object.assign(env, { ctx, endpoint, gatewayPda, fetch: fetchMock, access, sessions, rounds, usedNonces,
    hosted: { getContext: async () => ({ ...ctx, hosted: true }) as unknown as MolphaContext, hosted: {} } });
  return env;
}

const grant = (env: Env, owner: string, signer: string): void => {
  env.access.set(owner, (env.access.get(owner) ?? new Set()).add(signer));
};

beforeEach(() => {
  x402Timing.conflictRetryMs = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sessionEndpoint", () => {
  const config = (endpoints: string[]) => ({ gatewayEndpoints: endpoints }) as MolphaConfig;
  it("is the only configured gateway, or the one named among several", () => {
    expect(sessionEndpoint(config(["https://a.test"]))).toBe("https://a.test");
    expect(sessionEndpoint(config(["https://a.test", "https://b.test/"]), "https://b.test")).toBe("https://b.test/");
  });
  it("never sends a session anywhere that is not configured", () => {
    expect(() => sessionEndpoint(config(["https://a.test"]), "https://attacker.test")).toThrow(/not a gateway endpoint/);
    expect(() => sessionEndpoint(config(["https://a.test", "https://b.test"]))).toThrow(/pass gatewayEndpoint/);
  });
});

describe("begin, sign, complete", () => {
  it("signs an owner in with nothing but a text signature", async () => {
    const env = await setup();
    const wallet = await newWallet();
    grant(env, wallet.address, wallet.address);

    const begun = await beginSession(env.ctx, { address: wallet.address });
    expect(begun).toMatchObject({ gatewayEndpoint: env.endpoint, address: wallet.address, owner: wallet.address });
    expect(begun.message).toContain(`Sign in to Molpha gateway ${env.gatewayPda}`);
    expect(begun.message).toContain("This signature does not move funds.");
    expect(begun.expiresAt).toBeGreaterThan(Date.now() / 1000);

    const opened = await completeSession(env.ctx, { challenge: begun.challenge, signature: await wallet.sign(begun.message) });
    expect(opened).toMatchObject({ gatewayEndpoint: env.endpoint, authority: wallet.address, owner: wallet.address, role: "owner" });
    expect(env.sessions.get(opened.sessionToken)).toEqual({ authority: wallet.address, owner: wallet.address });
  });

  it("signs a delegate in under its owner", async () => {
    const env = await setup();
    const [owner, delegate] = [randomAddress(), await newWallet()];
    grant(env, owner, delegate.address);

    const begun = await beginSession(env.ctx, { address: delegate.address, owner });
    expect(begun.message).toContain(`- molpha:subscription:${owner}`);
    const opened = await completeSession(env.ctx, { challenge: begun.challenge, signature: await delegate.sign(begun.message) });
    expect(opened).toMatchObject({ authority: delegate.address, owner, role: "delegate" });
  });

  it.each(["base58", "base64", "hex"] as const)("accepts a %s signature, named or detected", async (encoding) => {
    const env = await setup();
    const wallet = await newWallet();
    grant(env, wallet.address, wallet.address);
    const encode = (base58: string): string => {
      const bytes = Buffer.from(getBase58Encoder().encode(base58));
      return encoding === "base58" ? base58 : bytes.toString(encoding);
    };
    for (const signatureEncoding of [encoding, undefined]) {
      const begun = await beginSession(env.ctx, { address: wallet.address });
      const signature = encode(await wallet.sign(begun.message));
      await expect(completeSession(env.ctx, { challenge: begun.challenge, signature, signatureEncoding })).resolves.toMatchObject({ role: "owner" });
    }
  });

  it("refuses a signature over anything but the exact message, before the gateway sees it", async () => {
    const env = await setup();
    const [wallet, other] = [await newWallet(), await newWallet()];
    grant(env, wallet.address, wallet.address);
    const begun = await beginSession(env.ctx, { address: wallet.address });
    const calls = env.fetch.mock.calls.length;

    for (const signature of [
      await wallet.sign(`${begun.message}\n`),
      await wallet.sign(`\xffsolana offchain${begun.message}`),
      await other.sign(begun.message),
      "not a signature"
    ]) {
      await expect(completeSession(env.ctx, { challenge: begun.challenge, signature })).rejects.toMatchObject({ code: "invalid_signature" });
    }
    expect(env.fetch.mock.calls.length).toBe(calls);
  });

  it("refuses to hand a wallet a challenge that is not this gateway's", async () => {
    const env = await setup();
    const wallet = await newWallet();
    env.fetch.mockImplementationOnce(async (input: string | URL) => {
      const url = new URL(String(input));
      const issued = new Date();
      const fields: SiwxMessageFields = {
        domain: url.host, uri: `${env.endpoint}/v1/session`, statement: siwxStatement(randomAddress()), version: "1",
        nonce: randomBytes(16).toString("hex"), issuedAt: issued.toISOString(), expirationTime: new Date(issued.getTime() + 300_000).toISOString(),
        resources: [`molpha:program:${programId}`, `molpha:gateway:${env.gatewayPda}`, `molpha:subscription:${wallet.address}`],
        address: wallet.address, chainId: NETWORK
      };
      const { address: _a, chainId: _c, ...info } = fields;
      return json(200, { status: "ok", data: { info, address: wallet.address, chainId: NETWORK, message: formatSiwsMessage(fields) } });
    });

    await expect(beginSession(env.ctx, { address: wallet.address })).rejects.toThrow(/sign-in statement.*refusing to hand it to a wallet/);
  });

  it("reports a gateway that offers no sessions", async () => {
    const env = await setup();
    env.fetch.mockImplementationOnce(async () => new Response("404 page not found", { status: 404 }));
    await expect(beginSession(env.ctx, { address: randomAddress() })).rejects.toMatchObject({ code: "sessions_unavailable" });
  });

  it("maps the gateway's refusals: a used message, and a signer without access", async () => {
    const env = await setup();
    const wallet = await newWallet();
    const begun = await beginSession(env.ctx, { address: wallet.address });
    const signature = await wallet.sign(begun.message);

    await expect(completeSession(env.ctx, { challenge: begun.challenge, signature })).rejects.toMatchObject({ status: 403 });
    grant(env, wallet.address, wallet.address);
    await completeSession(env.ctx, { challenge: begun.challenge, signature });
    await expect(completeSession(env.ctx, { challenge: begun.challenge, signature })).rejects.toMatchObject({ code: "sign_in_rejected" });
  });

  it("sends a signed message only to a configured gateway, whatever the challenge says", async () => {
    const env = await setup();
    const wallet = await newWallet();
    const begun = await beginSession(env.ctx, { address: wallet.address });
    const sealed = JSON.parse(Buffer.from(begun.challenge, "base64url").toString("utf8")) as { endpoint: string };
    const redirected = Buffer.from(JSON.stringify({ ...sealed, endpoint: "https://attacker.test" })).toString("base64url");
    const calls = env.fetch.mock.calls.length;

    await expect(completeSession(env.ctx, { challenge: redirected, signature: await wallet.sign(begun.message) })).rejects.toThrow(/not a gateway endpoint/);
    await expect(completeSession(env.ctx, { challenge: "garbage", signature: "x" })).rejects.toMatchObject({ code: "invalid_challenge" });
    expect(env.fetch.mock.calls.length).toBe(calls);
  });
});

describe("executeSessionRound", () => {
  async function signedIn(env: Env): Promise<{ wallet: Wallet; token: string }> {
    const wallet = await newWallet();
    grant(env, wallet.address, wallet.address);
    const begun = await beginSession(env.ctx, { address: wallet.address });
    const { sessionToken } = await completeSession(env.ctx, { challenge: begun.challenge, signature: await wallet.sign(begun.message) });
    return { wallet, token: sessionToken };
  }
  const round = { apiConfig, signaturesRequired: 2 };

  it("runs a round with the token alone: no identity, signature or timestamp in the body", async () => {
    const env = await setup();
    const { token } = await signedIn(env);

    const result = await executeSessionRound(env.ctx, { ...round, sessionToken: token });

    expect(result).toMatchObject({ sourceId, value: "42", registryVersion: 3, signaturesRequired: 2 });
    expect(env.rounds).toHaveLength(1);
    expect(env.rounds[0]!.token).toBe(token);
    expect(Object.keys(env.rounds[0]!.body).sort()).toEqual(["apiConfig", "registryVersion", "signaturesRequired"]);
  });

  it("answers session_invalid for a token the gateway does not know", async () => {
    const env = await setup();
    await expect(executeSessionRound(env.ctx, { ...round, sessionToken: "molpha_sess_unknown" })).rejects.toMatchObject({ code: "session_invalid" });
  });

  it("is refused once the delegate is removed, with its token still live", async () => {
    const env = await setup();
    const { wallet, token } = await signedIn(env);
    env.access.get(wallet.address)!.delete(wallet.address);

    await expect(executeSessionRound(env.ctx, { ...round, sessionToken: token })).rejects.toMatchObject({ status: 403 });
  });

  it("retries once when this consumer's tick was taken, and gives up on a second 409", async () => {
    const env = await setup();
    const { token } = await signedIn(env);
    env.onRound = (attempt) => (attempt === 1 ? json(409, { error: "round already reserved" }) : undefined);
    await expect(executeSessionRound(env.ctx, { ...round, sessionToken: token })).resolves.toMatchObject({ value: "42" });
    expect(env.rounds).toHaveLength(2);

    env.onRound = () => json(409, { error: "round already reserved" });
    await expect(executeSessionRound(env.ctx, { ...round, sessionToken: token })).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an aggregate for another source, and a caller sourceId that does not match apiConfig", async () => {
    const env = await setup();
    const { token } = await signedIn(env);
    await expect(executeSessionRound(env.ctx, { ...round, sessionToken: token, sourceId: "ff".repeat(32) })).rejects.toThrow(/sourceId does not match apiConfig/);
    expect(env.rounds).toHaveLength(0);

    env.onRound = () =>
      json(200, { status: "completed", data: { attestation: { payload: { sourceId: "cd".repeat(32), registryVersion: 3, signaturesRequired: 2, timestamp: Date.now() }, signature: {} }, value: "1" } });
    await expect(executeSessionRound(env.ctx, { ...round, sessionToken: token })).rejects.toThrow(/different round/);
  });

  it("sends the token to no gateway but the one named and configured", async () => {
    const env = await setup();
    const { token } = await signedIn(env);
    await expect(executeSessionRound(env.ctx, { ...round, sessionToken: token, gatewayEndpoint: "https://attacker.test" })).rejects.toThrow(/not a gateway endpoint/);
    expect(env.rounds).toHaveLength(0);
  });
});

describe("hosted session tools", () => {
  it("begin_session → sign → complete_session → execute_subscription_round", async () => {
    const env = await setup();
    const wallet = await newWallet();
    grant(env, wallet.address, wallet.address);

    const begun = await callTool("begin_session", { address: wallet.address }, env.hosted);
    const opened = await callTool("complete_session", { challenge: begun.challenge, signature: await wallet.sign(String(begun.message)) }, env.hosted);
    expect(opened).toMatchObject({ authority: wallet.address, role: "owner", gatewayEndpoint: env.endpoint });

    const live = await callTool("execute_subscription_round", { sessionToken: opened.sessionToken, apiConfig, signaturesRequired: 2, chains: ["evm"] }, env.hosted);
    expect(live).toMatchObject({
      payment: "subscription", value: "42",
      dataUpdate: { sourceId: `0x${sourceId}`, registryVersion: 3, signaturesRequired: 2 },
      verifierArgs: { evm: { args: {} } }
    });
    expect(JSON.stringify(live)).not.toContain(String(opened.sessionToken));
  });

  it("keeps each failure's own code", async () => {
    const env = await setup();
    const wallet = await newWallet();
    const begun = await callTool("begin_session", { address: wallet.address }, env.hosted);

    expect(await callToolError("complete_session", { challenge: begun.challenge, signature: "1".repeat(88) }, env.hosted)).toMatchObject({ code: "invalid_signature" });
    expect(await callToolError("complete_session", { challenge: "garbage", signature: "x" }, env.hosted)).toMatchObject({ code: "invalid_challenge" });
    expect(await callToolError("execute_subscription_round", { sessionToken: "molpha_sess_unknown", apiConfig, signaturesRequired: 2, chains: ["evm"] }, env.hosted)).toMatchObject({ code: "session_invalid" });
  });
});

describe("readAccess and describe_access", () => {
  const coder = new BorshAccountsCoder(requireSdkExport<Idl>("MOLPHA_IDL"));
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const subscription = (owner: Address, until = validUntil) => ({
    owner, planType: "Standard", validUntil: until, maxRounds: 1000n, delegateCount: 1, maxDelegates: 5, maxSigners: 7
  });
  async function delegateAccount(owner: Address, delegate: Address, max: number): Promise<AccountInfo<Buffer>> {
    const data = await coder.encode("Delegate", { owner: new PublicKey(owner), delegate: new PublicKey(delegate), max_data_requests: new BN(max), bump: 255 });
    return { data, owner: new PublicKey(programId), lamports: 1, executable: false, rentEpoch: 0 };
  }

  it("reports an owner with the plan's own limits", async () => {
    const env = await setup();
    const owner = randomAddress();
    vi.mocked(env.ctx.solana.readSubscription as (owner: string) => Promise<unknown>).mockResolvedValue(subscription(owner));

    expect(await readAccess(env.ctx, owner)).toMatchObject({ role: "owner", effectiveMaxRounds: 1000, subscription: { active: true, maxSigners: 7 } });
    expect(env.ctx.connection.getAccountInfo).not.toHaveBeenCalled();
  });

  it("reports a delegate with the smaller of its own limit and the plan's", async () => {
    const env = await setup();
    const [owner, delegate] = [randomAddress(), randomAddress()];
    const pda = await deriveDelegatePda(owner, delegate, programId);
    vi.mocked(env.ctx.solana.readSubscription as (owner: string) => Promise<unknown>).mockResolvedValue(subscription(owner));
    env.ctx.connection.getAccountInfo.mockImplementation(async (key: PublicKey) => (key.toBase58() === pda ? delegateAccount(owner, delegate, 25) : null));

    const access = await readAccess(env.ctx, delegate, owner);

    expect(access).toMatchObject({ role: "delegate", delegate: { account: pda, maxDataRequests: 25 }, effectiveMaxRounds: 25 });
    expect(env.ctx.solana.readSubscription).toHaveBeenCalledWith(owner);
  });

  it("reports no access for a stranger, a removed delegate, or a delegate account under another owner", async () => {
    const env = await setup();
    const [owner, delegate, otherOwner] = [randomAddress(), randomAddress(), randomAddress()];
    vi.mocked(env.ctx.solana.readSubscription as (owner: string) => Promise<unknown>).mockResolvedValue(subscription(owner));
    expect(await readAccess(env.ctx, delegate, owner)).toMatchObject({ role: "none" });

    env.ctx.connection.getAccountInfo.mockResolvedValue(await delegateAccount(otherOwner, delegate, 25));
    expect((await readAccess(env.ctx, delegate, owner)).role).toBe("none");

    vi.mocked(env.ctx.solana.readSubscription as (owner: string) => Promise<unknown>).mockResolvedValue(null);
    expect(await readAccess(env.ctx, owner)).toEqual({ address: owner, owner, role: "none" });
  });

  it("describe_access says whether rounds can be requested, in both server modes", async () => {
    const env = await setup();
    const owner = randomAddress();
    const read = vi.mocked(env.ctx.solana.readSubscription as (owner: string) => Promise<unknown>);
    read.mockResolvedValue(subscription(owner));
    expect(await callTool("describe_access", { address: owner }, env.hosted)).toMatchObject({ role: "owner", canRequestRounds: true, effectiveMaxRounds: 1000 });
    expect(await callTool("describe_access", { address: owner }, { getContext: env.hosted.getContext! })).toMatchObject({ role: "owner" });

    read.mockResolvedValue(subscription(owner, 1n));
    expect(await callTool("describe_access", { address: owner }, env.hosted)).toMatchObject({ role: "owner", canRequestRounds: false, note: expect.stringMatching(/term has ended/) });
    expect(await callTool("describe_access", { address: randomAddress(), owner }, env.hosted)).toMatchObject({ role: "none", canRequestRounds: false });
  });
});
