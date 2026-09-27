import { ParsedNoticeSchema, type ParsedNotice } from "./schema.js";

/** Stable machine-readable reason a notice could not be parsed. */
export type ParseIssueCode =
  | "empty-document"
  | "unrecognized-document"
  | "missing"
  | "duplicate"
  | "empty-value"
  | "invalid-value";

export interface ParseIssue {
  /** Canonical field name, or `"$text"` for whole-document problems. */
  readonly field: string;
  readonly code: ParseIssueCode;
  readonly message: string;
}

/**
 * Thrown when a notice cannot be turned into a valid `ParsedNotice`. Carries
 * every problem found rather than only the first, so a caller fixing a bad
 * notice board sees the whole list at once.
 */
export class ParseError extends Error {
  readonly issues: readonly ParseIssue[];

  constructor(issues: readonly ParseIssue[]) {
    const detail = issues.map((issue) => `  - ${issue.field} (${issue.code}): ${issue.message}`);
    super(
      `Notice failed to parse (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n${detail.join("\n")}`,
    );
    this.name = "ParseError";
    this.issues = issues;
  }
}

type Field = "train" | "station" | "expectedTime" | "reason";

/**
 * One pattern per field, matching `Label<sep?>value` where the separator is
 * optional. Patterns are tried in order and the first hit wins.
 *
 * A colon inside the value (`Expected Time: 19:45`) is why labels are matched
 * by pattern rather than by splitting each line on the first colon, which
 * would cut the value down to `45`.
 */
const FIELD_PATTERNS: readonly { field: Field; re: RegExp }[] = [
  {
    field: "train",
    re: /^(?:train\s*(?:no\.?|number)?|ट्रेन\s*(?:संख्या|सं)?)\s*[:\-–]?\s*(.+)$/iu,
  },
  { field: "station", re: /^(?:station|स्टेशन)\s*[:\-–]?\s*(.+)$/iu },
  {
    field: "expectedTime",
    re: /^(?:expected\s*(?:arrival|time)?|new\s*arrival|अनुमानित(?:\s*समय)?|अपेक्षित(?:\s*समय)?)\s*[:\-–]?\s*(.+)$/iu,
  },
  { field: "reason", re: /^(?:reason|कारण|वजह)\s*[:\-–]?\s*(.+)$/iu },
];

/** Devanagari digits and ASCII digits -> ASCII. */
function normalizeDigits(value: string): string {
  return value.replace(/[०-९]/g, (ch) => String(ch.charCodeAt(0) - 0x0966));
}

/**
 * Normalizes a notice's time to 24-hour HH:MM.
 *
 * Indian notices mix conventions: `19:45`, `7:45 PM`, `0745 HRS`, and the
 * Devanagari `सायं 7:45`. Returns null when nothing usable is present.
 */
function normalizeTime(raw: string): string | null {
  const text = normalizeDigits(raw)
    .replace(/सायं|शाम/g, " PM ")
    .replace(/प्रातः|सुबह/g, " AM ")
    .replace(/बजे/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 7:45 PM / 7 PM / सायं 7:45
  const meridiem = /\b(am|pm)\b/i.exec(text);
  if (meridiem !== null) {
    const bare = text.replace(/\b(am|pm)\b/gi, "").replace(/[:.]/g, ":").trim();
    const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(bare);
    if (match === null) return null;
    const hour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    const marker = meridiem[1]?.toLowerCase();
    if (hour > 23 || minute > 59 || marker === undefined) return null;
    // 12 AM is hour 0; 12 PM is hour 12.
    const hour24 = marker === "pm" ? (hour % 12) + 12 : hour % 12;
    return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  // 0745 HRS / 0745
  const hms = /^(\d{2})(\d{2})\s*(?:hrs?|hours?)?$/i.exec(text);
  if (hms !== null) {
    if (Number(hms[1]) > 23 || Number(hms[2]) > 59) return null;
    return `${hms[1]}:${hms[2]}`;
  }

  // 19:45, 7:45
  const hm = /^(\d{1,2})\s*:\s*(\d{2})$/.exec(text);
  if (hm !== null) {
    if (Number(hm[1]) > 23 || Number(hm[2]) > 59) return null;
    return `${String(Number(hm[1])).padStart(2, "0")}:${hm[2]}`;
  }

  return null;
}

/**
 * Reduces a station field to the form the schema accepts.
 *
 * Real notices print both orders (`NDLS (New Delhi)`, `New Delhi (NDLS)`) and
 * the schema caps the field at 10 characters, so a parenthetical code is
 * preferred over the spelled-out name whenever one is present.
 */
function normalizeStation(raw: string): string {
  const clean = raw
    .replace(/[०-९]/g, (ch) => String(ch.charCodeAt(0) - 0x0966))
    .replace(/\s+/g, " ")
    .trim();

  const paren = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(clean);
  if (paren !== null) {
    const outside = (paren[1] ?? "").trim();
    const inside = (paren[2] ?? "").trim();
    // A code is short and has no lowercase letters.
    const isCode = (s: string) => s.length >= 2 && s.length <= 10 && !/[a-z]/.test(s);
    if (outside !== "" && isCode(outside)) return outside;
    if (inside !== "" && isCode(inside)) return inside;
    return outside !== "" ? outside : inside;
  }

  return clean;
}

/**
 * Pulls the train number out of free text such as `12951 (Mumbai Rajdhani)`.
 *
 * Only a leading run of 4 or 5 digits counts, and the character after it must
 * not be a letter. A bare `/\d{4,5}/` would match the first five digits of
 * `129512` and silently turn it into `12951`, while a looser digit-token scan
 * would accept the malformed `1295a`.
 */
function normalizeTrain(raw: string): string {
  const match = /^\s*(\d+)(.*)$/.exec(normalizeDigits(raw).trim());
  if (match === null) return "";

  const digits = match[1] ?? "";
  const rest = (match[2] ?? "").trimStart();
  if (digits.length !== 4 && digits.length !== 5) return "";
  // "12951 (Mumbai Rajdhani)" and "12951/12952" are fine; "1295a" is not.
  if (rest !== "" && /^[A-Za-z]/.test(rest)) return "";

  return digits;
}

/**
 * Parses one Indian Railways delay notice into a validated `ParsedNotice`.
 *
 * Throws `ParseError` listing every problem found. The returned value has
 * already passed `ParsedNoticeSchema`, so what a buyer pays for is
 * schema-valid by construction.
 */
export function parseNotice(text: string): ParsedNotice {
  const issues: ParseIssue[] = [];
  const found = new Map<Field, string>();
  let recognizedLines = 0;

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;

    const hit = FIELD_PATTERNS.find(({ re }) => re.test(line));
    if (hit === undefined) continue;

    const value = hit.re.exec(line)?.[1]?.trim() ?? "";
    recognizedLines += 1;

    // A bare `Station:` leaves the separator inside the capture, because the
    // separator in the pattern is optional. Treat that as no value at all.
    if (value === "" || /^[:\-–]+$/.test(value)) {
      issues.push({ field: hit.field, code: "empty-value", message: `"${line.trim()}" has no value` });
      continue;
    }
    if (found.has(hit.field)) {
      // Ambiguous rather than merely redundant: there is no way to tell which
      // occurrence is authoritative, so the notice is rejected outright.
      issues.push({
        field: hit.field,
        code: "duplicate",
        message: `"${value}" gives a second, conflicting ${hit.field}`,
      });
      continue;
    }
    found.set(hit.field, value);
  }

  if (recognizedLines === 0) {
    issues.push({
      field: "$text",
      code: "unrecognized-document",
      message: `no recognisable field labels in ${text.split(/\r?\n/).length} line(s); expected "Train No: 12951" or "स्टेशन: NDLS" pairs`,
    });
    throw new ParseError(issues);
  }

  const train = found.has("train") ? normalizeTrain(String(found.get("train"))) : "";
  const station = found.has("station") ? normalizeStation(String(found.get("station"))) : "";
  const expectedRaw = found.has("expectedTime") ? String(found.get("expectedTime")) : null;
  const expectedTime = expectedRaw === null ? null : normalizeTime(expectedRaw);
  const reason = found.has("reason") ? String(found.get("reason")).replace(/\s+/g, " ").trim() : "";

  // Fields that were seen on a label but yielded no usable value. They get an
  // `empty-value`/`duplicate` issue already, so a follow-up `missing` for the
  // same field would be a second complaint about one line.
  const unusable = new Set(issues.map((issue) => issue.field));

  if (!found.has("train") && !unusable.has("train")) {
    issues.push({ field: "train", code: "missing", message: "no train number found" });
  }
  if (!found.has("station") && !unusable.has("station")) {
    issues.push({ field: "station", code: "missing", message: "no station found" });
  }
  if (expectedRaw === null) {
    if (!unusable.has("expectedTime")) {
      issues.push({ field: "expectedTime", code: "missing", message: "no expected time found" });
    }
  } else if (expectedTime === null) {
    issues.push({
      field: "expectedTime",
      code: "invalid-value",
      message: `"${expectedRaw}" is not a recognisable time; use 24-hour HH:MM, 7:45 PM, or 0745 HRS`,
    });
  }

  // Computed only now, so it covers every value-level issue above. A field
  // flagged `missing`, `duplicate`, `empty-value` or `invalid-value` already has
  // the most specific complaint available, so it is not also reported by the
  // schema pass below -- one problem yields one issue.
  const flagged = new Set(issues.map((issue) => issue.field));

  // Validate against the schema even when value-level issues exist, so callers
  // receive every problem in one ParseError instead of only the first few.
  const result = ParsedNoticeSchema.safeParse({ train, station, expectedTime, reason });
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path.join(".") || "$text";
      if (flagged.has(field)) continue;
      issues.push({ field, code: "invalid-value", message: issue.message });
    }
    throw new ParseError(issues);
  }

  if (issues.length > 0) throw new ParseError(issues);

  return result.data;
}
