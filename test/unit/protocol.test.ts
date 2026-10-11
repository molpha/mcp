import { describe, expect, it } from "vitest";
import { ROUND_TICK_MS } from "../../src/protocol.js";

describe("protocol constants", () => {
  it("pins the round tick at 100 ms: ten ticks in every second", () => {
    expect(ROUND_TICK_MS).toBe(100);
    expect(1000 % ROUND_TICK_MS).toBe(0);
    expect(1000 / ROUND_TICK_MS).toBe(10);
  });
});
