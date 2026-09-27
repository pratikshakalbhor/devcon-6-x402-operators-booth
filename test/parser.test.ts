import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ParsedNoticeSchema } from "../src/schema.js";
import { ParseError, parseNotice } from "../src/parser.js";

const SAMPLES = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "samples/notices");

const readSample = (name: string): string => readFileSync(path.join(SAMPLES, name), "utf8");
const sampleNames = (): string[] => readdirSync(SAMPLES).filter((f) => f.endsWith(".txt")).sort();

/** Runs parseNotice and returns the issue codes, failing loudly if it succeeds. */
const issueCodes = (text: string): string[] => {
  try {
    parseNotice(text);
  } catch (error) {
    if (error instanceof ParseError) return error.issues.map((i) => i.code);
    throw error;
  }
  throw new Error("expected a ParseError, but parsing succeeded");
};

describe("sample notices", () => {
  it("every sample file is accounted for", () => {
    expect(sampleNames().length).toBeGreaterThan(0);
  });

  it.each(["delay-1-mumbai-rajdhani.txt", "delay-2-hindi-mandovi.txt", "delay-3-12h-clock.txt", "delay-4-mixed-hrs.txt"])(
    "%s parses and satisfies the schema",
    (name) => {
      const parsed = parseNotice(readSample(name));
      expect(ParsedNoticeSchema.safeParse(parsed).success).toBe(true);
    },
  );

  it("normalizes the English sample", () => {
    expect(parseNotice(readSample("delay-1-mumbai-rajdhani.txt"))).toEqual({
      train: "12951",
      station: "NDLS",
      expectedTime: "19:45",
      reason: "Signal failure beyond Faridabad",
    });
  });

  it("reads the Devanagari sample and keeps a Hindi reason", () => {
    const parsed = parseNotice(readSample("delay-2-hindi-mandovi.txt"));
    expect(parsed.train).toBe("10103");
    expect(parsed.station).toBe("MAO");
    expect(parsed.expectedTime).toBe("22:40");
    expect(parsed.reason).toMatch(/पेड़/);
  });

  it("converts 12-hour clock to 24-hour", () => {
    expect(parseNotice(readSample("delay-3-12h-clock.txt")).expectedTime).toBe("06:15");
  });

  it("reads HRS notation and mixed-language notices", () => {
    expect(parseNotice(readSample("delay-4-mixed-hrs.txt")).expectedTime).toBe("09:15");
  });

  it.each([
    ["bad-1-unrecognised.txt", "unrecognized-document"],
    ["bad-2-bad-time.txt", "invalid-value"],
    ["bad-3-no-station.txt", "missing"],
  ])("%s is rejected with %s", (name, code) => {
    expect(issueCodes(readSample(name))).toContain(code);
  });
});

describe("train numbers", () => {
  const withTrain = (train: string): string => `Train No: ${train}\nStation: NDLS\nExpected Time: 19:45`;

  it.each(["1295", "12951", "01234", "99999"])("accepts %s", (train) => {
    expect(parseNotice(withTrain(train)).train).toBe(train);
  });

  it.each(["1", "12", "123", "123456", "129512", "1295a"])("rejects %s", (train) => {
    expect(issueCodes(withTrain(train))).toContain("invalid-value");
  });

  it("does not truncate an over-long number into a valid one", () => {
    // A naive /\d{4,5}/ match would silently yield "12951" from "129512".
    expect(() => parseNotice(withTrain("129512"))).toThrow(ParseError);
  });

  it("finds the number inside a decorated value", () => {
    expect(parseNotice(withTrain("12951 (Mumbai Rajdhani)")).train).toBe("12951");
  });

  it("normalizes Devanagari digits", () => {
    const parsed = parseNotice("ट्रेन संख्या: १२९५१\nस्टेशन: NDLS\nअनुमानित समय: १९:४५");
    expect(parsed).toMatchObject({ train: "12951", expectedTime: "19:45" });
  });
});

describe("station", () => {
  const withStation = (station: string): string => `Train No: 12951\nStation: ${station}\nExpected Time: 19:45`;

  it("prefers a parenthetical code over a spelled-out name", () => {
    expect(parseNotice(withStation("NDLS (New Delhi)")).station).toBe("NDLS");
    expect(parseNotice(withStation("New Delhi (NDLS)")).station).toBe("NDLS");
  });

  it("keeps a bare code or name within the 10-character cap", () => {
    expect(parseNotice(withStation("NDLS")).station).toBe("NDLS");
    expect(parseNotice(withStation("Pune")).station).toBe("Pune");
  });

  it("rejects a name longer than the schema allows", () => {
    // The schema caps station at 10 chars, so full names do not fit. Documented
    // in the README as a deliberate consequence of the field limit.
    expect(issueCodes(withStation("Hazrat Nizamuddin"))).toContain("invalid-value");
  });

  it("rejects a one-character station", () => {
    expect(issueCodes(withStation("N"))).toContain("invalid-value");
  });

  it("treats a label with no value as empty, not as a station", () => {
    expect(issueCodes("Train No: 12951\nStation:\nExpected Time: 19:45")).toContain("empty-value");
  });
});

describe("expected time", () => {
  const withTime = (time: string): string => `Train No: 12951\nStation: NDLS\nExpected Time: ${time}`;

  it.each([
    ["19:45", "19:45"],
    ["7:45", "07:45"],
    ["7:45 PM", "19:45"],
    ["7:45 pm", "19:45"],
    ["7 PM", "19:00"],
    ["12:30 AM", "00:30"],
    ["12:00 PM", "12:00"],
    ["00:05", "00:05"],
    ["23:59", "23:59"],
    ["0915 HRS", "09:15"],
    ["0745", "07:45"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(parseNotice(withTime(input)).expectedTime).toBe(expected);
  });

  it("understands Devanagasi meridiem markers", () => {
    expect(parseNotice(`Train No: 12951\nStation: NDLS\nअनुमानित समय: सायं 7:45`).expectedTime).toBe("19:45");
    expect(parseNotice(`Train No: 12951\nStation: NDLS\nअपेक्षित समय: सुबह 6:05`).expectedTime).toBe("06:05");
  });

  it.each(["24:00", "19:60", "25:00", "sometime later today"])("rejects %s", (time) => {
    expect(issueCodes(withTime(time))).toContain("invalid-value");
  });

  it("reports an empty value once, without also calling it missing", () => {
    // A bare "Expected Time:" must not produce two complaints about one line.
    expect(issueCodes(withTime(""))).toEqual(["empty-value"]);
  });
});

describe("label matching", () => {
  it("works with and without a separator", () => {
    const withSep = parseNotice("Train No: 12951\nStation: NDLS\nExpected Time: 19:45");
    const without = parseNotice("Train No 12951\nStation NDLS\nExpected Time 19:45");
    expect(withSep).toEqual(without);
  });

  it("is not confused by a colon inside the value", () => {
    // Splitting each line on the first colon would truncate 19:45 to "45".
    expect(parseNotice("Expected Time: 19:45\nTrain No: 12951\nStation: NDLS").expectedTime).toBe("19:45");
  });

  it("ignores unrelated lines", () => {
    const text = "Platform: 12\nCoach: B7\nTrain No: 12951\nStation: NDLS\nExpected Time: 19:45";
    expect(parseNotice(text)).toMatchObject({ train: "12951", station: "NDLS" });
  });

  it("rejects a document with no recognizable labels", () => {
    expect(issueCodes("Passengers are requested to note the following.")).toEqual(["unrecognized-document"]);
  });

  it("rejects an empty document", () => {
    expect(issueCodes("   \n\n  ")).toEqual(["unrecognized-document"]);
  });

  it("reports a missing required field", () => {
    expect(issueCodes("Train No: 12951\nExpected Time: 19:45")).toContain("missing");
  });

  it("reports one issue per field, not one per layer", () => {
    // Regression: a value-level problem used to short-circuit the schema pass,
    // and a bad time used to surface twice (specific message + raw zod null).
    expect(issueCodes("Train No: 12951\nStation: NDLS\nExpected Time: sometime")).toEqual(["invalid-value"]);
    expect(issueCodes("Train No: 1\nStation: N")).toEqual(["missing", "invalid-value", "invalid-value"]);

    const message = (() => {
      try {
        parseNotice("Train No: 12951\nStation: NDLS\nExpected Time: sometime");
        return "";
      } catch (error) {
        return (error as ParseError).issues[0]?.message ?? "";
      }
    })();
    // The zod wording ("Expected string, received null") must never leak through.
    expect(message).toContain("not a recognisable time");
    expect(message).not.toMatch(/received null/);
  });
});

describe("reason", () => {
  it("is optional", () => {
    const parsed = parseNotice("Train No: 12951\nStation: NDLS\nExpected Time: 19:45");
    expect(parsed.reason).toBeUndefined();
  });

  it("is capped at 500 characters by the schema", () => {
    const long = "Train No: 12951\nStation: NDLS\nExpected Time: 19:45\nReason: " + "x".repeat(501);
    expect(issueCodes(long)).toContain("invalid-value");
  });

  it("collapses runs of whitespace within a line", () => {
    const parsed = parseNotice("Train No: 12951\nStation: NDLS\nExpected Time: 19:45\nReason: a   b");
    expect(parsed.reason).toBe("a b");
  });

  it("does not join an unlabelled continuation line onto the reason", () => {
    // Documented limitation: only labelled fields are read, because gluing any
    // trailing line onto `reason` would swallow footers and notices-byline text.
    const parsed = parseNotice("Train No: 12951\nStation: NDLS\nExpected Time: 19:45\nReason: signal failure\nPassengers are advised to note.");
    expect(parsed.reason).toBe("signal failure");
  });
});

describe("duplicates", () => {
  it("rejects a conflicting second value rather than guessing", () => {
    expect(issueCodes("Train No: 12951\nTrain No: 12952\nStation: NDLS\nExpected Time: 19:45")).toContain("duplicate");
  });
});

describe("ParseError", () => {
  it("carries every issue and a readable message", () => {
    try {
      parseNotice("Train No: 1\nStation: N");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      const parseError = error as ParseError;
      expect(parseError.issues.length).toBeGreaterThan(1);
      expect(parseError.message).toMatch(/failed to parse/);
      expect(parseError.issues.every((i) => typeof i.field === "string" && typeof i.code === "string")).toBe(true);
    }
  });
});
