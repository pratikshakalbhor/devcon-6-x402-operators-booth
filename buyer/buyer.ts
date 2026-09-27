import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { loadBuyerConfig } from "../src/config.js";
import { BulkItemSchema, ParsedNoticeSchema } from "../src/schema.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

const USAGE = `Usage: npm run buyer -- [good|bad|bulk]

  good   Pay for one parseable notice. Expects 200 and a settled payment.
  bad    Pay for a deliberately broken notice. Expects 422 and NO charge.
  bulk   Pay one flat fee for a 3-item batch, mixing good and bad notices.
         Expects 200, a settled payment, and per-item ok flags.

Environment (from .env):
  BUYER_PRIVATE_KEY  required, 0x + 64 hex. Testnet key with test USDC only.
  BUYER_BASE_URL     default http://localhost:4021
  NETWORK            default eip155:84532 (Base Sepolia). Must match the server.
  RPC_URL            optional, e.g. https://sepolia.base.org
`;

type Mode = "good" | "bad" | "bulk";

/** The payment-wrapped fetch returned by `wrapFetchWithPayment`. */
type Pay = ReturnType<typeof wrapFetchWithPayment>;

/** Shape of the 422 body, so the demo can prove the server's error contract. */
const parseFailureSchema = z.object({
  error: z.literal("notice_not_parseable"),
  message: z.string(),
  issues: z.array(z.object({ field: z.string(), code: z.string(), message: z.string() })),
});

const readSample = (name: string): Promise<string> => readFile(path.join(PROJECT_ROOT, "samples/notices", name), "utf8");

/**
 * Reads the settlement receipt the server returns in `PAYMENT-RESPONSE`.
 *
 * Returns `undefined` when the header is absent, which is the signal that the
 * server cancelled the payment: x402 only emits a receipt once it settles.
 */
function readSettlement(response: Response): string | undefined {
  const header = response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
  if (header === null) return undefined;

  try {
    const settlement = decodePaymentResponseHeader(header);
    if (settlement.transaction === undefined) {
      return `no transaction (${settlement.errorReason ?? "payment not settled"})`;
    }
    return `${settlement.transaction} on ${settlement.network}`;
  } catch (error) {
    return `undecodable PAYMENT-RESPONSE header: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function describePayment(response: Response): string {
  const settlement = readSettlement(response);
  if (settlement !== undefined) return `SETTLED ${settlement}`;
  // A cancelled payment produces no receipt at all, so spell that out rather
  // than leaving a bare status code the reader has to interpret.
  return response.status >= 400 ? "NOT SETTLED (payment cancelled, nothing charged)" : "no settlement header";
}

/** `good`: a notice that parses. 200, settled, response validated client-side. */
async function runGood(pay: Pay, baseUrl: string): Promise<void> {
  const notice = await readSample("delay-1-mumbai-rajdhani.txt");
  const response = await pay(`${baseUrl}/parse`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ notice }),
  });

  console.log(`  status      HTTP ${response.status}`);
  console.log(`  payment     ${describePayment(response)}`);

  const body: unknown = await response.json();
  if (!response.ok) {
    console.error("\n  Expected 200 but the server refused. Body:\n");
    console.error(JSON.stringify(body, null, 2));
    process.exitCode = 1;
    return;
  }

  // Re-validate against the schema the server publishes, so this doubles as a
  // check that the client can rely on the documented shape.
  const { data } = (body as { data: unknown });
  const parsed = ParsedNoticeSchema.parse(data);
  console.log("\n  parsed notice (validated against ParsedNoticeSchema):\n");
  console.log(JSON.stringify(parsed, null, 2));
  console.log("\n  OK: paid request settled and returned schema-valid JSON.");
}

/** `bad`: a notice that cannot parse. 422, cancelled, nothing charged. */
async function runBad(pay: Pay, baseUrl: string): Promise<void> {
  const notice = await readSample("bad-1-unrecognised.txt");
  const response = await pay(`${baseUrl}/parse`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ notice }),
  });

  console.log(`  status      HTTP ${response.status}`);
  console.log(`  payment     ${describePayment(response)}`);

  const body: unknown = await response.json();
  if (response.status !== 422) {
    console.error(`\n  Expected 422 (unparseable notice) but got HTTP ${response.status}. Body:\n`);
    console.error(JSON.stringify(body, null, 2));
    process.exitCode = 1;
    return;
  }

  const failure = parseFailureSchema.parse(body);
  console.log(`\n  error       ${failure.error}`);
  console.log(`  message     ${failure.message}`);
  console.log("\n  issues:\n");
  console.log(JSON.stringify(failure.issues, null, 2));
  console.log("\n  OK: the booth could not read the notice, so it returned 422 and");
  console.log("  CANCELLED the payment. No USDC moved. This is the intended");
  console.log("  'no charge on an unreadable notice' behaviour.");
  // Non-zero on purpose: the 422 is the point of this demo, and a CI job should
  // be able to assert on it.
  process.exitCode = 1;
}

/** `bulk`: one flat fee for the batch, settled even though one item fails. */
async function runBulk(pay: Pay, baseUrl: string): Promise<void> {
  const good = await readSample("delay-1-mumbai-rajdhani.txt");
  const bad = await readSample("bad-2-bad-time.txt");
  const hindi = await readSample("delay-2-hindi-mandovi.txt");

  const response = await pay(`${baseUrl}/parse/bulk`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ notices: [good, bad, hindi] }),
  });

  console.log(`  status      HTTP ${response.status}`);
  console.log(`  payment     ${describePayment(response)}`);

  const body: unknown = await response.json();
  if (!response.ok) {
    console.error("\n  Expected 200 but the server refused. Body:\n");
    console.error(JSON.stringify(body, null, 2));
    process.exitCode = 1;
    return;
  }

  const { results } = (body as { results: unknown });
  const items = z.array(BulkItemSchema).parse(results);
  console.log("\n  results (one flat batch fee, charged regardless of item count):\n");
  console.log(JSON.stringify(items, null, 2));

  const failures = items.filter((item) => !item.ok).length;
  console.log(
    `\n  OK: ${items.length - failures}/${items.length} parsed. The batch still returned` +
      ` HTTP 200, so the flat fee SETTLED even though ${failures} item(s) were unreadable.`,
  );
}

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? "good") as Mode;
  if (mode !== "good" && mode !== "bad" && mode !== "bulk") {
    console.error(`Unknown mode "${process.argv[2]}".\n\n${USAGE}`);
    process.exit(1);
  }

  const config = loadBuyerConfig();
  const account = privateKeyToAccount(config.privateKey);
  const client = new x402Client().register(
    config.network,
    new ExactEvmScheme(account, config.rpcUrl === undefined ? undefined : { rpcUrl: config.rpcUrl }),
  );
  const pay = wrapFetchWithPayment(fetch, client);

  console.log(`buyer     ${account.address}`);
  console.log(`network   ${config.network}`);
  console.log(`server    ${config.baseUrl}`);
  console.log(`mode      ${mode}\n`);

  if (mode === "good") await runGood(pay, config.baseUrl);
  else if (mode === "bad") await runBad(pay, config.baseUrl);
  else await runBulk(pay, config.baseUrl);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
