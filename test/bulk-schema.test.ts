import { describe, expect, it } from "vitest";

import { BulkItemSchema } from "../src/schema.js";

const okItem = {
  index: 0,
  ok: true as const,
  data: { train: "12951", station: "NDLS", expectedTime: "19:45" },
};

const failedItem = {
  index: 1,
  ok: false as const,
  error: { message: "Notice could not be parsed.", issues: [{ field: "expectedTime", code: "invalid-value" }] },
};

describe("BulkItemSchema", () => {
  it("accepts a successful item", () => {
    expect(BulkItemSchema.safeParse(okItem).success).toBe(true);
  });

  it("accepts a failed item carrying issues", () => {
    expect(BulkItemSchema.safeParse(failedItem).success).toBe(true);
  });

  it("rejects ok:true without data", () => {
    expect(BulkItemSchema.safeParse({ index: 0, ok: true }).success).toBe(false);
  });

  it("rejects ok:false without an error", () => {
    expect(BulkItemSchema.safeParse({ index: 0, ok: false }).success).toBe(false);
  });

  it("rejects an error attached to a successful item", () => {
    expect(BulkItemSchema.safeParse({ ...okItem, error: failedItem.error }).success).toBe(false);
  });

  it("rejects data attached to a failed item", () => {
    expect(BulkItemSchema.safeParse({ ...failedItem, data: okItem.data }).success).toBe(false);
  });

  it("rejects a negative index", () => {
    expect(BulkItemSchema.safeParse({ ...okItem, index: -1 }).success).toBe(false);
  });

  it("rejects an unexpected extra key", () => {
    expect(BulkItemSchema.safeParse({ ...okItem, price: "$0.001" }).success).toBe(false);
  });
});
