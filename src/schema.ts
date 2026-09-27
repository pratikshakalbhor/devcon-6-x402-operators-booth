import { z } from "zod";

/**
 * Indian Railways train numbers are 4 or 5 digits. The leading zeros in
 * 5-digit numbers are significant, so this is deliberately a string and never
 * coerced to a number.
 */
const trainNumber = z
  .string()
  .trim()
  .regex(/^\d{4,5}$/, "must be a 4 or 5 digit train number, e.g. 12951 or 10103");

/** Station name or code as printed on the notice, 2-10 characters. */
const stationName = z
  .string()
  .trim()
  .min(2, "must be at least 2 characters")
  .max(10, "must be at most 10 characters");

/** 24-hour clock, zero-padded. Rejects 24:00 and 7:05, which `new Date` would tolerate. */
const clockTime = z
  .string()
  .trim()
  .regex(
    /^(?:[01]\d|2[0-3]):[0-5]\d$/,
    'must be 24-hour HH:MM, e.g. "19:45" (not "7:45" or "24:00")',
  );

/** A delay reason is frequently absent. Blank counts as absent rather than an empty string. */
const optionalReason = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1, "must not be blank when present").max(500).optional(),
);

/**
 * The product this booth sells: one delay notice, normalized to stable JSON.
 *
 * `.strict()` because this schema is the published contract. An unrecognized
 * key means the parser produced something nobody agreed to pay for, so it
 * fails loudly instead of being silently dropped.
 */
export const ParsedNoticeSchema = z
  .object({
    train: trainNumber,
    station: stationName,
    expectedTime: clockTime,
    reason: optionalReason,
  })
  .strict();

export type ParsedNotice = z.infer<typeof ParsedNoticeSchema>;

/**
 * One entry in a `/parse/bulk` result.
 *
 * The call itself succeeds, so the response is always a `200` and the payment
 * settles; each entry reports honestly whether that item parsed. Modelled as a
 * discriminated union so `ok: true` cannot be paired with an `error`, and
 * `ok: false` cannot be paired with a `data`, which is what the handler emits.
 */
export const BulkItemSchema = z.discriminatedUnion("ok", [
  z.object({ index: z.number().int().nonnegative(), ok: z.literal(true), data: ParsedNoticeSchema }).strict(),
  z
    .object({
      index: z.number().int().nonnegative(),
      ok: z.literal(false),
      error: z.object({ message: z.string(), issues: z.array(z.unknown()) }).strict(),
    })
    .strict(),
]);

export type BulkItem = z.infer<typeof BulkItemSchema>;
