import { describe, expect, it } from "vitest";

import { PAY_TO_PLACEHOLDER, loadBuyerConfig, loadConfig } from "../src/config.js";

const VALID = { PAY_TO: `0x${"1".repeat(40)}` } as NodeJS.ProcessEnv;

describe("required PAY_TO", () => {
  it("throws a clear error when unset", () => {
    expect(() => loadConfig({})).toThrow(/PAY_TO is required/);
  });

  it("throws when empty", () => {
    expect(() => loadConfig({ PAY_TO: "  " })).toThrow(/PAY_TO is required/);
  });

  it("names the placeholder rather than calling it malformed", () => {
    expect(() => loadConfig({ PAY_TO: PAY_TO_PLACEHOLDER })).toThrow(/placeholder/);
  });

  it.each(["0xdead", "not-an-address", "0xZZZ4567890abcdef1234567890abcdef12345678"])(
    "rejects malformed address %s",
    (payTo) => {
      expect(() => loadConfig({ PAY_TO: payTo })).toThrow(/40 hex/);
    },
  );
});

describe("defaults", () => {
  it("fills every optional value when only PAY_TO is set", () => {
    expect(loadConfig(VALID)).toEqual({
      port: 4021,
      payTo: `0x${"1".repeat(40)}`,
      facilitatorUrl: "https://x402.org/facilitator",
      network: "eip155:84532",
      priceSingle: "$0.001",
      priceBulk: "$0.005",
      maxNoticeLen: 2000,
      maxBulkItems: 10,
      syncFacilitatorOnStart: true,
      maxTimeoutSeconds: 60,
      maxBodyBytes: 4 * 1024 + 10 * 2000 * 4,
    });
  });
});

describe("network", () => {
  it("accepts CAIP-2 ids", () => {
    expect(loadConfig({ ...VALID, NETWORK: "eip155:11155111" }).network).toBe("eip155:11155111");
  });

  it("rejects the x402 v1 name, which cannot settle", () => {
    expect(() => loadConfig({ ...VALID, NETWORK: "base-sepolia" })).toThrow(/CAIP-2/);
  });
});

describe("prices", () => {
  it("accepts a $-prefixed or bare decimal", () => {
    expect(loadConfig({ ...VALID, PRICE_SINGLE: "$0.002" }).priceSingle).toBe("$0.002");
    expect(loadConfig({ ...VALID, PRICE_SINGLE: "0.002" }).priceSingle).toBe("0.002");
  });

  it.each(["free", "-0.001", "0", "1e-3", "0.0000001"])("rejects %s", (price) => {
    expect(() => loadConfig({ ...VALID, PRICE_SINGLE: price })).toThrow(/PRICE_SINGLE/);
  });
});

describe("limits", () => {
  it("parses numeric env values", () => {
    const config = loadConfig({ ...VALID, MAX_NOTICE_LEN: "50", MAX_BULK_ITEMS: "3" });
    expect(config.maxNoticeLen).toBe(50);
    expect(config.maxBulkItems).toBe(3);
  });

  it.each(["0", "-3", "abc", "1.5"])("rejects MAX_BULK_ITEMS=%s", (value) => {
    expect(() => loadConfig({ ...VALID, MAX_BULK_ITEMS: value })).toThrow(/MAX_BULK_ITEMS/);
  });

  it("derives a body cap that fits a maximal legal batch", () => {
    const config = loadConfig({ ...VALID, MAX_NOTICE_LEN: "2000", MAX_BULK_ITEMS: "10" });
    // A full batch of 2000-char Devanagari notices is ~60 KB, so the derived cap
    // must clear it or the server would reject requests its own limits allow.
    const worstCase = 10 * 2000 * 3;
    expect(config.maxBodyBytes).toBeGreaterThan(worstCase);
  });

  it("lets MAX_BODY_BYTES tighten the cap but not the limits", () => {
    const config = loadConfig({ ...VALID, MAX_BODY_BYTES: "2048" });
    expect(config.maxBodyBytes).toBe(2048);
    expect(config.maxNoticeLen).toBe(2000);
  });
});

describe("x402 flags", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["yes", true],
    ["on", true],
    ["false", false],
    ["0", false],
    ["no", false],
  ])("reads X402_SYNC_ON_START=%s as %s", (raw, expected) => {
    expect(loadConfig({ ...VALID, X402_SYNC_ON_START: raw }).syncFacilitatorOnStart).toBe(expected);
  });
});

describe("error reporting", () => {
  it("collects every problem at once", () => {
    try {
      loadConfig({ PAY_TO: `0x${"1".repeat(40)}`, PORT: "0", MAX_BULK_ITEMS: "-1" });
      throw new Error("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/PORT/);
      expect(message).toMatch(/MAX_BULK_ITEMS/);
    }
  });
});

describe("loadBuyerConfig", () => {
  const KEY = `0x${"a".repeat(64)}`;

  it("requires a buyer key", () => {
    expect(() => loadBuyerConfig({})).toThrow(/BUYER_PRIVATE_KEY/);
  });

  it.each(["0xdead", "not-a-key", `0x${"a".repeat(63)}`, `0x${"a".repeat(65)}`, "0xZZ" + "a".repeat(62)])(
    "rejects malformed key %s",
    (key) => {
      expect(() => loadBuyerConfig({ BUYER_PRIVATE_KEY: key })).toThrow(/64 hex/);
    },
  );

  it("defaults the base url and network", () => {
    const config = loadBuyerConfig({ BUYER_PRIVATE_KEY: KEY });
    expect(config).toEqual({
      privateKey: KEY,
      baseUrl: "http://localhost:4021",
      network: "eip155:84532",
      rpcUrl: undefined,
    });
  });

  it("strips a trailing slash so paths do not double up", () => {
    expect(loadBuyerConfig({ BUYER_PRIVATE_KEY: KEY, BUYER_BASE_URL: "http://localhost:4021/" }).baseUrl).toBe(
      "http://localhost:4021",
    );
  });

  it("rejects the v1 network name", () => {
    expect(() => loadBuyerConfig({ BUYER_PRIVATE_KEY: KEY, NETWORK: "base-sepolia" })).toThrow(/CAIP-2/);
  });

  it("warns that the key must be testnet-only", () => {
    expect(() => loadBuyerConfig({})).toThrow(/TESTNET/);
  });

  it("does not require PAY_TO, so a buyer-only .env still works", () => {
    expect(() => loadBuyerConfig({ BUYER_PRIVATE_KEY: KEY })).not.toThrow();
  });
});
