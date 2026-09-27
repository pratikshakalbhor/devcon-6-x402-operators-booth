import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HTTPFacilitatorClient, x402ResourceServer, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/express";
import express, { type ErrorRequestHandler, type Express, type Request, type Response } from "express";

import { loadConfig, type Config } from "./config.js";
import { ParseError, parseNotice } from "./parser.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAMPLES_DIR = "samples/notices";

/** Rejection reasons for a malformed request. Always 400, never 422. */
class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

/**
 * Filenames only. Notice text is the paid product, so the free listing must not
 * leak it, and nothing here is parsed, so a malformed sample cannot break boot.
 */
async function listSampleNotices(): Promise<readonly string[]> {
  const absolute = path.resolve(PROJECT_ROOT, SAMPLES_DIR);
  const entries = await readdir(absolute, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Validates the body of POST /parse. The price and payTo address are never read
 * from here: they are fixed in the route table at construction time from
 * config, so a request body cannot influence what it is charged.
 */
function readNotice(req: Request, config: Config): string {
  const body: unknown = req.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError("invalid_body", 'Body must be a JSON object of the form { "notice": "..." }.');
  }

  const notice = (body as Record<string, unknown>).notice;
  if (notice === undefined || notice === null) {
    throw new RequestError("missing_notice", 'Field "notice" is required.');
  }
  if (typeof notice !== "string") {
    throw new RequestError("invalid_notice", 'Field "notice" must be a string.');
  }
  if (notice.trim() === "") {
    throw new RequestError("empty_notice", 'Field "notice" must not be blank.');
  }
  if (notice.length > config.maxNoticeLen) {
    throw new RequestError(
      "notice_too_long",
      `Notice is ${notice.length} characters; the limit is ${config.maxNoticeLen}.`,
    );
  }

  return notice;
}

/** Validates the body of POST /parse/bulk before a single notice is parsed. */
function readNotices(req: Request, config: Config): readonly string[] {
  const body: unknown = req.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError("invalid_body", 'Body must be a JSON object of the form { "notices": ["..."] }.');
  }

  const notices = (body as Record<string, unknown>).notices;
  if (notices === undefined || notices === null) {
    throw new RequestError("missing_notices", 'Field "notices" is required.');
  }
  if (!Array.isArray(notices)) {
    throw new RequestError("invalid_notices", 'Field "notices" must be an array of strings.');
  }
  if (notices.length === 0) {
    throw new RequestError("empty_notices", 'Field "notices" must contain at least one notice.');
  }
  if (notices.length > config.maxBulkItems) {
    throw new RequestError(
      "too_many_notices",
      `Batch has ${notices.length} notices; the limit is ${config.maxBulkItems}.`,
    );
  }

  return notices.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new RequestError("invalid_notice", `notices[${index}] must be a string.`);
    }
    if (entry.length > config.maxNoticeLen) {
      throw new RequestError(
        "notice_too_long",
        `notices[${index}] is ${entry.length} characters; the limit is ${config.maxNoticeLen}.`,
      );
    }
    return entry;
  });
}

/** One settled batch is one answer, so a per-item failure is data, not an error. */
type BulkResult =
  | { readonly index: number; readonly ok: true; readonly data: ReturnType<typeof parseNotice> }
  | { readonly index: number; readonly ok: false; readonly error: { readonly message: string; readonly issues: readonly { field: string; code: string; message: string }[] } };

/**
 * Builds the express app: body cap, free routes, the x402 gate, then the paid
 * handlers. Every handler catches its own errors so a `ParseError` can never
 * reach express as an unhandled rejection or escape as a bare 200.
 */
export function createApp(config: Config): Express {
  const app = express();
  app.disable("x-powered-by");

  // Server-side ceiling, derived from MAX_NOTICE_LEN and MAX_BULK_ITEMS. A
  // body over this is refused by the parser before any handler runs.
  app.use(express.json({ limit: config.maxBodyBytes }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  app.get("/sample-notices", (_req: Request, res: Response) => {
    listSampleNotices()
      .then((files) => {
        res.json({ count: files.length, files });
      })
      .catch((error: unknown) => {
        console.error("[operators-booth] cannot list samples", error);
        res.status(500).json({ error: "samples_unavailable" });
      });
  });

  app.use(
    paymentMiddleware(
      buildRoutes(config),
      new x402ResourceServer(
        new HTTPFacilitatorClient({ url: config.facilitatorUrl }),
      ).register(config.network, new ExactEvmScheme()),
      { appName: "Operators Booth (Railways)", testnet: config.network !== "eip155:1" && config.network !== "eip155:8453" },
      undefined,
      config.syncFacilitatorOnStart,
    ),
  );

  app.post("/parse", (req: Request, res: Response) => {
    try {
      const notice = readNotice(req, config);
      let parsed;
      try {
        parsed = parseNotice(notice);
      } catch (error) {
        if (error instanceof ParseError) {
          // 4xx makes the x402 middleware cancel the authorization instead of
          // settling it, so a notice the booth cannot read costs the buyer
          // nothing. A 200 here would be paid for.
          res.status(422).json({
            error: "notice_not_parseable",
            message: "The notice could not be parsed, so the payment was not settled.",
            issues: error.issues,
          });
          return;
        }
        throw error;
      }
      res.status(200).json({ data: parsed });
    } catch (error) {
      if (error instanceof RequestError) {
        res.status(400).json({ error: error.code, message: error.message });
        return;
      }
      console.error("[operators-booth] POST /parse failed", error);
      res.status(500).json({ error: "internal_error" });
    }
  });

  app.post("/parse/bulk", (req: Request, res: Response) => {
    try {
      const notices = readNotices(req, config);

      const results: BulkResult[] = notices.map((notice, index) => {
        try {
          return { index, ok: true, data: parseNotice(notice) };
        } catch (error) {
          if (error instanceof ParseError) {
            return {
              index,
              ok: false,
              error: { message: "Notice could not be parsed.", issues: error.issues },
            };
          }
          throw error;
        }
      });

      // 200 even when every item failed: the batch itself was accepted and
      // delivered, so it settles. Per-item outcomes are reported honestly in
      // the body. See the README for why this differs from POST /parse.
      res.status(200).json({ results });
    } catch (error) {
      if (error instanceof RequestError) {
        res.status(400).json({ error: error.code, message: error.message });
        return;
      }
      console.error("[operators-booth] POST /parse/bulk failed", error);
      res.status(500).json({ error: "internal_error" });
    }
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  // Last resort. Handlers already catch their own failures; this exists so a
  // throw from middleware or a malformed JSON body cannot become a hang.
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof RequestError) {
      res.status(400).json({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof ParseError) {
      res.status(500).json({ error: "notice_parse_failed", issues: error.issues });
      return;
    }
    const status = (error as { status?: number }).status;
    if (status === 413) {
      res.status(413).json({ error: "body_too_large", message: "Request body exceeds the configured limit." });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: "invalid_json", message: "Request body is not valid JSON." });
      return;
    }
    console.error("[operators-booth] unhandled error", error);
    res.status(500).json({ error: "internal_error" });
  };
  app.use(onError);

  return app;
}

/**
 * The price table. Every value is read from config at construction time, so
 * nothing a client sends can change what it pays or who gets paid.
 */
function buildRoutes(config: Config): RoutesConfig {
  const accepts = (price: string) => ({
    scheme: "exact",
    network: config.network,
    payTo: config.payTo,
    price,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
  });

  return {
    "POST /parse": {
      accepts: accepts(config.priceSingle),
      resource: "https://operators-booth.local/parse",
      description: "Parse one Indian Railways delay notice into schema-valid JSON.",
      mimeType: "application/json",
      serviceName: "operators-booth-railways",
      tags: ["railways", "parse"],
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: { hint: "Pay to parse one delay notice, then repeat the same POST." },
      }),
    },
    "POST /parse/bulk": {
      accepts: accepts(config.priceBulk),
      resource: "https://operators-booth.local/parse/bulk",
      description: "Parse a batch of delay notices. Flat batch fee regardless of item count.",
      mimeType: "application/json",
      serviceName: "operators-booth-railways",
      tags: ["railways", "parse", "bulk"],
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: { hint: "Pay once for the whole batch, then repeat the same POST." },
      }),
    },
  };
}

function main(): void {
  const config = loadConfig();
  const app = createApp(config);
  const server = app.listen(config.port, () => {
    console.log(`[operators-booth] listening on http://localhost:${config.port}`);
    console.log(`[operators-booth] network=${config.network} payTo=${config.payTo}`);
    console.log(`[operators-booth] facilitator=${config.facilitatorUrl}`);
    console.log(
      `[operators-booth] single=${config.priceSingle} bulk=${config.priceBulk} ` +
        `maxNoticeLen=${config.maxNoticeLen} maxBulkItems=${config.maxBulkItems} bodyCap=${config.maxBodyBytes}B`,
    );
  });

  // A busy port surfaces as an 'error' event, not a throw, so without this the
  // process would die on an unhandled event instead of saying what to change.
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `[operators-booth] port ${config.port} is already in use.\n` +
          "  Stop the other process, or set PORT to a free port in .env.",
      );
    } else {
      console.error("[operators-booth] server error:", error.message);
    }
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    console.log(`[operators-booth] ${signal} received, closing`);
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

const entry = process.argv[1];
// Compared as a file URL because this project path contains spaces.
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  try {
    main();
  } catch (error: unknown) {
    console.error("[operators-booth] failed to start:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
