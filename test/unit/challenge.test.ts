import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadChallengeKeys, openChallenge, requireChallengeKeys, sealChallenge } from "../../src/challenge.js";

const secret = (): string => randomBytes(32).toString("hex");
const keysFor = (current: string, previous?: string) =>
  loadChallengeKeys({
    MOLPHA_HTTP_CHALLENGE_SECRET: current,
    ...(previous ? { MOLPHA_HTTP_CHALLENGE_SECRET_PREVIOUS: previous } : {})
  })!;

const NOW = 1_800_000_000;
const payload = { endpoint: "https://gateway.test", amount: "50015", nested: { memo: "ab".repeat(32) } };

describe("loadChallengeKeys", () => {
  it("is unset without a secret, and the tools that need one say so", () => {
    expect(loadChallengeKeys({})).toBeUndefined();
    expect(() => requireChallengeKeys(undefined)).toThrow(expect.objectContaining({ code: "missing_config" }));
  });

  it("accepts hex, base64, and base64url secrets of at least 32 bytes", () => {
    const bytes = randomBytes(48);
    const ids = [bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64url")].map(
      (encoded) => keysFor(encoded).current.id
    );
    expect(new Set(ids).size).toBe(1);
  });

  it.each([
    ["too short", randomBytes(31).toString("hex")],
    ["not an encoding", "correct horse battery staple, with punctuation!"],
    ["a short passphrase", "hunter2"]
  ])("fails startup on a secret that is %s, without echoing it", (_label, value) => {
    const load = () => loadChallengeKeys({ MOLPHA_HTTP_CHALLENGE_SECRET: value });
    expect(load).toThrow(/MOLPHA_HTTP_CHALLENGE_SECRET must be at least 32 random bytes/);
    expect(load).not.toThrow(new RegExp(value.slice(0, 6)));
  });

  it("refuses a previous secret with no current one", () => {
    expect(() => loadChallengeKeys({ MOLPHA_HTTP_CHALLENGE_SECRET_PREVIOUS: secret() })).toThrow(/without MOLPHA_HTTP_CHALLENGE_SECRET/);
  });
});

describe("sealChallenge and openChallenge", () => {
  it("returns exactly what was sealed, until it expires", () => {
    const keys = keysFor(secret());
    const challenge = sealChallenge(keys, "x402", payload, NOW + 60);

    expect(openChallenge(keys, "x402", challenge, "payment_expired", NOW)).toEqual(payload);
    expect(openChallenge(keys, "x402", challenge, "payment_expired", NOW + 59.9)).toEqual(payload);
    expect(() => openChallenge(keys, "x402", challenge, "payment_expired", NOW + 60)).toThrow(
      expect.objectContaining({ code: "payment_expired" })
    );
  });

  it("is verified by another instance holding the same secret", () => {
    const shared = secret();
    const challenge = sealChallenge(keysFor(shared), "x402", payload, NOW + 60);

    expect(openChallenge(keysFor(shared), "x402", challenge, "payment_expired", NOW)).toEqual(payload);
  });

  it("refuses a challenge sealed under another secret", () => {
    const challenge = sealChallenge(keysFor(secret()), "x402", payload, NOW + 60);

    expect(() => openChallenge(keysFor(secret()), "x402", challenge, "payment_expired", NOW)).toThrow(
      expect.objectContaining({ code: "invalid_challenge" })
    );
  });

  it("refuses a challenge sealed for a different tool", () => {
    const keys = keysFor(secret());
    const challenge = sealChallenge(keys, "submit", payload, NOW + 60);

    expect(() => openChallenge(keys, "x402", challenge, "payment_expired", NOW)).toThrow(
      expect.objectContaining({ code: "invalid_challenge" })
    );
  });

  it("refuses any altered byte, including a later expiry", () => {
    const keys = keysFor(secret());
    const challenge = sealChallenge(keys, "x402", payload, NOW + 60);
    const [format, id, body, tag] = challenge.split(".") as [string, string, string, string];
    const extended = Buffer.from(JSON.stringify({ exp: NOW + 86_400, payload })).toString("base64url");
    const redirected = Buffer.from(
      JSON.stringify({ exp: NOW + 60, payload: { ...payload, endpoint: "https://attacker.test" } })
    ).toString("base64url");

    for (const forged of [
      [format, id, extended, tag].join("."),
      [format, id, redirected, tag].join("."),
      [format, id, body, Buffer.alloc(32).toString("base64url")].join("."),
      [format, id, body, ""].join("."),
      [format, id, body].join("."),
      [format, "00000000", body, tag].join("."),
      ["mc2", id, body, tag].join("."),
      `${challenge}.extra`,
      "",
      "not a challenge"
    ]) {
      expect(() => openChallenge(keys, "x402", forged, "payment_expired", NOW)).toThrow(
        expect.objectContaining({ code: "invalid_challenge" })
      );
    }
  });

  it("keeps verifying the previous secret while it is rotated out, and seals only with the current one", () => {
    const [old, next] = [secret(), secret()];
    const beforeRotation = sealChallenge(keysFor(old), "x402", payload, NOW + 60);
    const rotating = keysFor(next, old);

    expect(openChallenge(rotating, "x402", beforeRotation, "payment_expired", NOW)).toEqual(payload);
    const afterRotation = sealChallenge(rotating, "x402", payload, NOW + 60);
    expect(openChallenge(keysFor(next), "x402", afterRotation, "payment_expired", NOW)).toEqual(payload);
    expect(() => openChallenge(keysFor(old), "x402", afterRotation, "payment_expired", NOW)).toThrow(
      expect.objectContaining({ code: "invalid_challenge" })
    );
  });
});
