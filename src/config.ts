import { config as readDotenv } from "dotenv";
import { z } from "zod";

/**
 * Sentinel shipped in `.env.example`. Caught separately so the boot error can
 * say "you copied the template" instead of "malformed address".
 */
export const PAY_TO_PLACEHOLDER = "0xYourAddressHere";

const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
/**
 * CAIP-2 id, not the x402 v1 name `base-sepolia`. x402 v2 matches the
 * facilitator's advertised kinds by exact string, and facilitators advertise
 * `eip155:84532`; passing `base-sepolia` makes every paid route fail at
 * runtime with "Facilitator does not support exact on base-sepolia".
 */
const DEFAULT_NETWORK = "eip155:84532";
const DEFAULT_PRICE_SINGLE = "$0.001";
const DEFAULT_PRICE_BULK = "$0.005";
const DEFAULT_PORT = 4021;
const DEFAULT_MAX_NOTICE_LEN = 2_000;
const DEFAULT_MAX_BULK_ITEMS = 10;
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
/**
 * Widest request body the server will even attempt to parse.
 *
 * Derived rather than hardcoded, because a fixed 20 KB cap contradicts the
 * limits this same config enforces: a full 10-item batch of 2000-character
 * Devanagari notices is ~60 KB of UTF-8 before JSON escaping, so a 20 KB cap
 * would reject requests that pass every other check.
 *
 * 4 bytes per character covers 3-byte Devanagari plus slack; the 4 KB reserve
 * covers JSON framing and the per-item key overhead.
 */
const bodyBytesFor = (maxNoticeLen: number, maxBulkItems: number): number =>
  4 * 1024 + maxBulkItems * maxNoticeLen * 4;

const evmAddress = z
  .string()
  .trim()
  .regex(
    /^0x[0-9a-fA-F]{40}$/,
    "must be 0x followed by 40 hex characters, e.g. 0x1234...cdef (no ENS names, no checksum requirement)",
  );

/**
 * USD amount with an optional leading `$`. x402's `parseMoney` strips the
 * symbol, so `"$0.001"` and `"0.001"` are equivalent on the wire. Scientific
 * notation is rejected here because x402 rejects it too, and it silently
 * loses precision.
 */
const usdAmount = (fallback: string) =>
  z
    .string()
    .trim()
    .refine(
      (value) => /^\$?\d+(\.\d{1,6})?$/.test(value),
      'must be a positive decimal amount, optionally $-prefixed, e.g. "$0.001"',
    )
    .refine((value) => Number(value.replace(/^\$/, "")) > 0, "must be greater than zero")
    .default(fallback);

const positiveInt = (fallback: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, "must be a whole number")
    .transform(Number)
    .refine((value) => value > 0, "must be greater than zero")
    // zod v3 types `.default()` on a transform by its *input*, so the numeric
    // fallback is supplied as a string and run through `.transform(Number)`.
    .default(String(fallback));

/** Same as {@link positiveInt} but absent stays absent, so a derived default can apply. */
const optionalPositiveInt = z
  .string()
  .trim()
  .regex(/^\d+$/, "must be a whole number")
  .transform(Number)
  .refine((value) => value > 0, "must be greater than zero")
  .optional();

/** Accepts the usual spellings of a boolean env var. */
const booleanish = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => ["1", "true", "yes", "on"].includes(value))
  .pipe(z.boolean());

const envSchema = z.object({
  PORT: positiveInt(DEFAULT_PORT),
  PAY_TO: evmAddress,
  FACILITATOR_URL: z.string().trim().url("must be an absolute URL").default(DEFAULT_FACILITATOR_URL),
  /**
   * Validated as CAIP-2. `"base-sepolia"` is a v1 alias and is rejected on
   * purpose rather than silently producing a booth that 500s on every request.
   */
  NETWORK: z
    .string()
    .trim()
    .regex(
      /^eip155:\d+$/,
      "must be a CAIP-2 id such as eip155:84532 (Base Sepolia) or eip155:11155111 (Sepolia); the v1 name 'base-sepolia' is not accepted by x402 v2",
    )
    .default(DEFAULT_NETWORK),
  PRICE_SINGLE: usdAmount(DEFAULT_PRICE_SINGLE),
  PRICE_BULK: usdAmount(DEFAULT_PRICE_BULK),
  /** Longest accepted raw notice text, in UTF-8 characters. */
  MAX_NOTICE_LEN: positiveInt(DEFAULT_MAX_NOTICE_LEN),
  /** Largest batch a single bulk request may carry. */
  MAX_BULK_ITEMS: positiveInt(DEFAULT_MAX_BULK_ITEMS),
  /**
   * Fetch the facilitator's supported kinds on boot. Keep true: with false,
   * x402 v2's middleware skips initialization and never lazily retries, so every
   * paid route fails with "Facilitator does not support exact on <network>".
   */
  X402_SYNC_ON_START: booleanish.default("true"),
  /** Seconds a client has to settle after receiving the 402. */
  MAX_TIMEOUT_SECONDS: positiveInt(DEFAULT_MAX_TIMEOUT_SECONDS),
  /**
   * Server-side request body cap. Left unset, it is derived from
   * MAX_NOTICE_LEN and MAX_BULK_ITEMS so the two can never disagree; set it
   * only to tighten the ceiling.
   */
  MAX_BODY_BYTES: optionalPositiveInt,
});

export interface Config {
  readonly port: number;
  readonly payTo: `0x${string}`;
  readonly facilitatorUrl: string;
  readonly network: `eip155:${number}`;
  readonly priceSingle: string;
  readonly priceBulk: string;
  readonly maxNoticeLen: number;
  readonly maxBulkItems: number;
  readonly syncFacilitatorOnStart: boolean;
  readonly maxTimeoutSeconds: number;
  readonly maxBodyBytes: number;
}

/**
 * Reads and validates configuration. Call once at boot; it throws rather than
 * letting the server start with an address it cannot pay to.
 *
 * `env` is injectable so tests can exercise the failure paths without
 * mutating `process.env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Idempotent, and scoped here so importing this module stays side-effect free.
  readDotenv();

  const merged = { ...env };
  const payTo = merged.PAY_TO?.trim();
  if (payTo === undefined || payTo === "") {
    throw new Error(
      "PAY_TO is required but was not set.\n" +
        `  Set it in .env, e.g. PAY_TO=0xYourRealPaymentAddressHere.\n` +
        "  This is the address that receives x402 payments. Never put a private key here.",
    );
  }
  if (payTo === PAY_TO_PLACEHOLDER) {
    throw new Error(
      `PAY_TO is still the .env.example placeholder (${PAY_TO_PLACEHOLDER}).\n` +
        "  Replace it with the 0x address that should collect payments.",
    );
  }

  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${details}`);
  }

  const value = parsed.data;
  return {
    port: value.PORT,
    payTo: value.PAY_TO as `0x${string}`,
    facilitatorUrl: value.FACILITATOR_URL,
    network: value.NETWORK as `eip155:${number}`,
    priceSingle: value.PRICE_SINGLE,
    priceBulk: value.PRICE_BULK,
    maxNoticeLen: value.MAX_NOTICE_LEN,
    maxBulkItems: value.MAX_BULK_ITEMS,
    syncFacilitatorOnStart: value.X402_SYNC_ON_START,
    maxTimeoutSeconds: value.MAX_TIMEOUT_SECONDS,
    maxBodyBytes: value.MAX_BODY_BYTES ?? bodyBytesFor(value.MAX_NOTICE_LEN, value.MAX_BULK_ITEMS),
  };
}

/**
 * Buyer-only settings, deliberately kept out of {@link envSchema}.
 *
 * The server must boot without a signing key ever being present, so the two
 * schemas stay separate: nothing here is read by the server, and nothing in
 * `envSchema` is required by the buyer beyond the shared `NETWORK`.
 */
const buyerSchema = z.object({
  BUYER_PRIVATE_KEY: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key (0x + 64 hex characters)"),
  BUYER_BASE_URL: z.string().trim().url("must be an absolute URL").default("http://localhost:4021"),
  /** Must match the server's NETWORK, or the buyer signs for the wrong chain. */
  NETWORK: z
    .string()
    .trim()
    .regex(/^eip155:\d+$/, "must be a CAIP-2 id such as eip155:84532 (Base Sepolia)")
    .default(DEFAULT_NETWORK),
  /**
   * Optional. The scheme can obtain chain state through the facilitator, but
   * pointing at your own Base Sepolia RPC makes nonce/allowance lookups faster
   * and survives a rate-limited public facilitator.
   */
  RPC_URL: z.string().trim().url("must be an absolute URL").optional(),
});

export interface BuyerConfig {
  readonly privateKey: `0x${string}`;
  readonly baseUrl: string;
  readonly network: `eip155:${number}`;
  readonly rpcUrl: string | undefined;
}

/** Reads buyer settings for `npm run buyer`. Throws rather than paying the wrong chain. */
export function loadBuyerConfig(env: NodeJS.ProcessEnv = process.env): BuyerConfig {
  readDotenv();

  const parsed = buyerSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid buyer configuration:\n${details}\n\n` +
        "  BUYER_PRIVATE_KEY is the only required value. Use a TESTNET wallet holding\n" +
        "  test USDC only. Never reuse a key that holds real funds.",
    );
  }

  const value = parsed.data;
  return {
    privateKey: value.BUYER_PRIVATE_KEY as `0x${string}`,
    baseUrl: value.BUYER_BASE_URL.replace(/\/+$/, ""),
    network: value.NETWORK as `eip155:${number}`,
    rpcUrl: value.RPC_URL,
  };
}
