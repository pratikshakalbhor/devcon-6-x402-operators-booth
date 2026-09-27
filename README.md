# The Operator's Booth — Indian Railways delay-notice parser

## 1. Summary

This service accepts a free-text Indian Railways delay notice and returns
schema-validated structured JSON (`train`, `station`, `expectedTime`, `reason`),
normalising English and Devanagari input, 12-hour and 24-hour clocks, and
station codes. It exists for Meera's use case: a consumer who is deciding
whether to still board a train and needs the notice read reliably rather than
scraped. Calls are metered and sold per request over the [x402](https://x402.org)
protocol, so each parse is a real USDC transfer on Base Sepolia with no account,
API key or subscription. The single rule that defines the design is **a caller
pays only when the parser successfully reads the notice**: an unreadable notice
returns a `4xx`, and because x402 settles only on `2xx`, that response cancels
the payment automatically and costs the caller nothing.

## 2. Architecture

### Free vs paid, and where each is declared

Both live in `src/server.ts`. There is no separate router file.

| Kind     | Where declared                                     | Gated by                       |
| -------- | -------------------------------------------------- | ------------------------------ |
| Free     | `src/server.ts:127` `/health`, `src/server.ts:131` `/sample-notices` | nothing; registered before the x402 gate |
| Paid     | `src/server.ts:154` `POST /parse`, `src/server.ts:185` `POST /parse/bulk` | `app.use(paymentMiddleware(...))` at `src/server.ts:142` |

Order matters. `app.use(express.json(...))` is at `src/server.ts:125`, then the
two free `GET` handlers, then the x402 middleware at line 142, then the paid
handlers. Any request reaching a paid handler has already passed payment
verification, so an unpaid `POST /parse` never reaches its body validation.

`GET /sample-notices` lists **filenames only** and parses nothing, so the three
deliberately broken fixtures are listed without breaking boot and notice text —
the paid product — is not leaked for free.

### The verify-then-settle lifecycle

The mechanism is configured at `src/server.ts:142-151`:

```ts
app.use(
  paymentMiddleware(
    buildRoutes(config),                                    // src/server.ts:143
    new x402ResourceServer(
      new HTTPFacilitatorClient({ url: config.facilitatorUrl }),
    ).register(config.network, new ExactEvmScheme()),        // src/server.ts:147
    { appName: "Operators Booth (Railways)", testnet: config.network !== "eip155:1" && config.network !== "eip155:8453" },
    undefined,
    config.syncFacilitatorOnStart,                          // src/server.ts:150
  ),
);
```

The price table is `buildRoutes()` at `src/server.ts:254-289`, keyed
`"POST /parse"` (line 264) and `"POST /parse/bulk"` (line 276). It is built once
at construction from `config`, and it is the **only** place `payTo`, `network`
and price appear — no handler reads them from the request, so nothing a client
sends can change what it is charged or who is paid.

The lifecycle in this codebase:

1. **Verify.** An unpaid `POST /parse` passes through the free routes, hits
   `paymentMiddleware`, and is answered `402` with a challenge naming the
   network, the amount and the recipient. No handler has run.
2. **Retry.** The client signs an EIP-3009 `transferWithAuthorization` and
   re-sends the identical request with the payment in a header. The server asks
   the facilitator to check the signature and that the funds exist.
3. **Settle — conditional on the handler's status code.** The paid handler runs
   and returns a status, and that status is the settlement decision:
   - `2xx` → the facilitator moves USDC and the server appends a
     `PAYMENT-RESPONSE` header carrying the transaction hash.
   - anything else → the authorisation is cancelled and no USDC moves. This is
     not a refund; nothing was ever captured.

`src/server.ts:154-183` (`POST /parse`) is the concrete instance: an unreadable
notice takes the `res.status(422)` branch at line 165, which is not `2xx`, so
the middleware cancels. The comment at lines 162-164 records that intent.

### `X402_SYNC_ON_START` — the gotcha that caused a real bug

`paymentMiddleware`'s fifth argument is `config.syncFacilitatorOnStart`, from the
`X402_SYNC_ON_START` env var. Set it to `true` (the default). It is not
cosmetic: with `false`, the middleware never populates its
supported-payment-kinds map, so it cannot match the `exact` scheme against the
network and **every paid route fails**.

The behaviour, verified by running it:

- **Boot succeeds silently.** The server prints the same
  `[operators-booth] listening on ...` lines and exits 0. There is no warning.
- **The first paid request throws**, server-side:

  ```
  Error: Facilitator does not support exact on eip155:84532. Make sure to call initialize() to fetch supported kinds from facilitators.
      at x402ResourceServer.buildPaymentRequirements (node_modules/@x402/core/src/server/x402ResourceServer.ts:787:13)
      at x402ResourceServer.buildPaymentRequirementsFromOptions (node_modules/@x402/core/src/server/x402ResourceServer.ts:872:39)
      at x402HTTPResourceServer.processHTTPRequest (node_modules/@x402/core/src/http/x402HTTPResourceServer.ts:580:50)
  ```

- **The client sees a bare `500 {"error":"Internal Server Error"}`.** The cause
  is in the server log, not the response body.

Why the correct value is `true`: it is what calls `initialize()`, which fetches
the facilitator's advertised kinds at boot. The error text is misleading when
the network id is already correct, because it tells you to call a function the
flag controls. Check this flag before you check anything else.

## 3. Routes

Declared in `src/server.ts`; prices are the `config.ts` defaults, which
`.env.example` mirrors.

| Method | Path             | Free/Paid | Price             | Notes                                                                 |
| ------ | ---------------- | --------- | ----------------- | --------------------------------------------------------------------- |
| `GET`  | `/health`        | free      | —                 | `{"status":"ok"}`. Liveness only.                                    |
| `GET`  | `/sample-notices` | free     | —                 | Filenames of the 7 bundled fixtures. No parsing, no notice text.     |
| `POST` | `/parse`         | paid      | `PRICE_SINGLE` = `$0.001` | Body `{ "notice": string }` → `{"data": ParsedNotice}`. `422` if unreadable; payment cancelled. |
| `POST` | `/parse/bulk`    | paid      | `PRICE_BULK` = `$0.005`   | Body `{ "notices": string[] }` → `{"results": BulkItem[]}`. Flat fee per batch, not per item. |

There is no `/notices` route; the free listing is `/sample-notices`.

### Status codes

| Code  | When                                                                                          | Payment  |
| ----- | --------------------------------------------------------------------------------------------- | -------- |
| `200` | Notice parsed, or the batch was delivered                                                       | settles  |
| `400` | Missing/blank/oversized `notice`, wrong type, `notices` empty or non-array, over `MAX_BULK_ITEMS`, malformed JSON | cancelled |
| `404` | Unknown path                                                                                   | cancelled |
| `413` | Body over the cap                                                                              | cancelled |
| `422` | `POST /parse` only: notice present but unreadable. Body carries `issues[]`.                     | cancelled |
| `402` | Payment required, with the challenge. Normal for a first unpaid call; `curl` will stop here.     | not yet paid |
| `500` | Unexpected internal fault. Also every paid route when `X402_SYNC_ON_START=false`.                | cancelled |

## 4. Environment variables

Sourced from the `envSchema` in `src/config.ts:91-127` and `buyerSchema` at
`src/config.ts:201-219`. Validation runs at boot and reports **all** problems in
one throw rather than one restart at a time.

| Variable              | Required | Default                        | Meaning |
| --------------------- | -------- | ------------------------------ | ------- |
| `PAY_TO`              | **yes**  | —                              | 0x address that receives USDC. Validated as `^0x[0-9a-fA-F]{40}$`. |
| `PORT`                | no       | `4021`                         | Listen port. |
| `NETWORK`             | no       | `eip155:84532`                 | CAIP-2 id. Validated as `^eip155:\d+$`. |
| `FACILITATOR_URL`     | no       | `https://x402.org/facilitator` | Verifies and settles payments. Shared and rate limited. |
| `PRICE_SINGLE`        | no       | `$0.001`                       | `POST /parse` price. Optional `$`; positive, max 6 dp. |
| `PRICE_BULK`          | no       | `$0.005`                       | `POST /parse/bulk` price, per batch. |
| `MAX_NOTICE_LEN`      | no       | `2000`                         | Longest single notice, in characters. Over → `400`. |
| `MAX_BULK_ITEMS`      | no       | `10`                           | Max notices per batch. Over → `400`. |
| `X402_SYNC_ON_START`  | no       | `true`                         | Fetch facilitator kinds at boot. **Keep `true`** — see §2. |
| `MAX_TIMEOUT_SECONDS` | no       | `60`                           | Client's payment window. |
| `MAX_BODY_BYTES`      | no       | derived: `84096`               | Body cap. Omit and it is derived from the two limits above. |
| `BUYER_PRIVATE_KEY`   | buyer only | —                            | **Secret.** `^0x[0-9a-fA-F]{64}$`. Read only by `buyer/buyer.ts`. |
| `BUYER_BASE_URL`      | no       | `http://localhost:4021`        | Where the buyer points. Trailing slash stripped. |
| `RPC_URL`             | no       | —                              | e.g. `https://sepolia.base.org`. Only the buyer reads it. |

`NETWORK` must be CAIP-2. **The v1 name `base-sepolia` is rejected** by the
`/^eip155:\d+$/` check at `src/config.ts:103-105`, and the same value as a buyer
setting is rejected at `src/config.ts:208-212`. `eip155:84532` (Base Sepolia) is
the only value this repo is tested against; `eip155:11155111` (Sepolia) also
validates. A non-CAIP-2 name would leave the facilitator lookup empty and
reproduce the `does not support exact` failure in §2 for a different reason.

`BUYER_PRIVATE_KEY` is validated by a **separate** schema
(`src/config.ts:201-219`) that the server never reads, so the server boots with
no signing key present.

### Exact `PAY_TO` error messages

Verified output from `loadConfig()`:

**Missing:**

```
PAY_TO is required but was not set.
  Set it in .env, e.g. PAY_TO=0xYourRealPaymentAddressHere.
  This is the address that receives x402 payments. Never put a private key here.
```

**Still the `.env.example` placeholder:**

```
PAY_TO is still the .env.example placeholder (0xYourAddressHere).
  Replace it with the 0x address that should collect payments.
```

**Malformed, shown together with two other faults to demonstrate that validation
does not stop at the first error:**

```
Invalid configuration:
  - PORT: must be greater than zero
  - PAY_TO: must be 0x followed by 40 hex characters, e.g. 0x1234...cdef (no ENS names, no checksum requirement)
  - MAX_BULK_ITEMS: must be a whole number
```

## 5. Setup, from zero to running

Node.js 20.10+ (`node --version`).

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env` and set:

- `PAY_TO` — a Base Sepolia address that can receive USDC. An address only.
- `BUYER_PRIVATE_KEY` — only needed for the buyer in §7. A funded Base Sepolia
  testnet wallet, test funds only.

```bash
npm ci
npm run typecheck
npm run test
npm run dev
```

`npm ci` was verified on npm 9.2.0 / Node 22.22.1: 161 packages, 0
vulnerabilities, and **`--legacy-peer-deps` is not required** for this package.
(`npm install --legacy-peer-deps` was used during development for unrelated
reasons; the lockfile installs cleanly without it.) If you hit `EACCES … rmdir`
on `npm ci` and your checkout is on a Windows or WSL mount, delete
`node_modules` by hand first — npm cannot unlink directories on some of those
mounts.

Expected results:

```
npm run typecheck   # no output, exit 0
npm run test        # Test Files  3 passed (3)
                    #      Tests  109 passed (109)
```

`npm run dev` prints:

```
[operators-booth] listening on http://localhost:4021
[operators-booth] network=eip155:84532 payTo=0x...
[operators-booth] facilitator=https://x402.org/facilitator
[operators-booth] single=$0.001 bulk=$0.005 maxNoticeLen=2000 maxBulkItems=10 bodyCap=84096B
```

Scripts available, all from `package.json`: `dev`, `start`, `buyer`, `test`,
`test:watch`, `typecheck`. There is **no `lint` script** in this package; the
parent directory's ESLint config explicitly ignores `railways/`, so this
subproject is not linted.

### Why zod is pinned to `^3.25.76`

`@x402/core@2.27.0` depends on `zod@^3.24.2` (as do `@x402/evm` and
`@x402/extensions`). A bare `npm install zod` resolves to zod v4, which would
leave two zod instances in the tree. v4 changes `ZodError.issues`, so x402
would throw and catch errors that this code's zod cannot construct, and
validation would fail in ways that are very hard to read. Pinning to `^3.25.76`
satisfies `^3.24.2` and keeps a single zod. Verified installed: `3.25.76`.

## 6. Funding a testnet wallet

You need test ETH for gas and test USDC to pay with. Select **Base Sepolia** if
a faucet asks which chain.

- Circle USDC faucet, 20 USDC per address per 2 hours: <https://faucet.circle.com/>
- Coinbase Developer Platform faucet, ETH and USDC: <https://www.coinbase.com/developer-platform/products/faucet>
- Directory of Base testnet faucets: <https://docs.base.org/base-chain/network-information/network-faucets>

Confirm the wallet is funded before running the buyer, by opening the address on
<https://sepolia.basescan.org> and checking that it holds test USDC, or:

```bash
curl -s -X POST https://sepolia.base.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0xYOUR_ADDRESS","latest"]}'
```

A non-zero `result` is the confirmation. You also need the `PAY_TO` address to be
one you control if you want to see the incoming transfer; pointing `PAY_TO` at
the buyer wallet (as the runs below do) is valid and self-consistent, but then
the payment returns to the payer and there is no second address to inspect.

Note that a `402` challenge proves nothing about funding — the challenge is
issued before any money moves. You are funded enough once a run reports a
settlement transaction hash.

## 7. Verified run output

Server running per §5. All three runs below were executed back-to-back in a
single session against this exact repository, in the order `good`, `bad`, then
`bulk`, against one freshly started server. The two settlement hashes are
independently verifiable on Basescan without re-running anything.

### Good notice

```
$ npm run buyer -- good
  status      HTTP 200
  payment     SETTLED 0xc592bbcd86dc3ccd346e89d1a6b868d783b30508452980f0cb5c20935228f277 on eip155:84532
  parsed notice (validated against ParsedNoticeSchema):
  {
    "train": "12951",
    "station": "NDLS",
    "expectedTime": "19:45",
    "reason": "Signal failure beyond Faridabad"
  }
```

Acceptance: a readable notice is parsed, answered `200`, and charged exactly
`$0.001` — the on-chain transfer is `0.001 USDC` to the configured `PAY_TO`.

### Bad notice

```
$ npm run buyer -- bad
  status      HTTP 422
  payment     NOT SETTLED (payment cancelled, nothing charged)
  error       notice_not_parseable
  message     The notice could not be parsed, so the payment was not settled.
  issues:
  [
    {
      "field": "$text",
      "code": "unrecognized-document",
      "message": "no recognisable field labels in 2 line(s); expected \"Train No: 12951\" or \"स्टेशन: NDLS\" pairs"
    }
  ]
```

This exits non-zero on purpose, so CI can assert on it. Acceptance: the notice
was unparseable, the status is `422`, and there is **no** `PAYMENT-RESPONSE`
header and **no** on-chain transfer — the caller was not charged.

### Bulk

```
$ npm run buyer -- bulk
  status      HTTP 200
  payment     SETTLED 0x95c8c68f1fa76ba3aa6d1b3624ada17cf535b36a4d0e204055b0a2741c6fec19 on eip155:84532
  results (one flat batch fee, charged regardless of item count):
  [
    { "index": 0, "ok": true, "data": { "train": "12951", "station": "NDLS", "expectedTime": "19:45", "reason": "Signal failure beyond Faridabad" } },
    { "index": 1, "ok": false, "error": { "message": "Notice could not be parsed.", "issues": [ { "field": "expectedTime", "code": "invalid-value", "message": "\"sometime later today\" is not a recognisable time; use 24-hour HH:MM, 7:45 PM, or 0745 HRS" } ] } },
    { "index": 2, "ok": true, "data": { "train": "10103", "station": "MAO", "expectedTime": "22:40", "reason": "ट्रैक पर पेड़ गिरने के कारण यात्रा में देरी" } } }
  ]
  OK: 2/3 parsed. The batch still returned HTTP 200, so the flat fee SETTLED even though 1 item(s) were unreadable.
```

Acceptance: a 3-item batch mixing one unreadable notice still answers `200` and
settles `0.005 USDC` once, not `0.015` — the flat fee is independent of item
count and of per-item failures.

### Verify independently

- Good: <https://sepolia.basescan.org/tx/0xc592bbcd86dc3ccd346e89d1a6b868d783b30508452980f0cb5c20935228f277>
- Bulk: <https://sepolia.basescan.org/tx/0x95c8c68f1fa76ba3aa6d1b3624ada17cf535b36a4d0e204055b0a2741c6fec19>

Both are successful (`status 0x1`) `transferWithAuthorization` (`0xe3ee160e`)
calls against the Base Sepolia USDC contract
`0x036cbd53842c5426634e7929541ec2318f3dcf7e`, for `0.001` and `0.005` USDC
respectively — matching `PRICE_SINGLE` and `PRICE_BULK`. They landed in blocks
47357742 and 47357744, two blocks apart, which is consistent with the two paid
calls being made back-to-back in one session. In these runs `PAY_TO` was the
payer address `0xd700eeca36cbe92edbc4a0ae30b131c42760d4c9`, so payer and
recipient are the same wallet; that is why there is no separate receiving
account to inspect.

## 8. Design notes worth a judge's attention

### `/parse/bulk` returns `200` with mixed results, not `4xx`

This reads as a bug at first glance, so: it is deliberate. `/parse` sells a bet
that one notice is readable, and a losing bet must be free — that is the whole
"no charge on an unreadable notice" rule. `/parse/bulk` does not sell a notice,
it sells a batch-parse service. The request was well-formed, the work was done,
and the buyer is owed an answer for every item they submitted. So the call
answers `200` and settles the flat fee, and reports each item honestly via
`ok: true` with `data` or `ok: false` with `error`.

The consequence is that a 10-item batch of pure garbage still costs `PRICE_BULK`.
That is the price of not letting large batches become a free way to probe the
parser, and it is the number to weigh when setting `PRICE_BULK` against
`PRICE_SINGLE * MAX_BULK_ITEMS`. A client can still tell the two situations
apart: a `4xx`/`5xx` means the server is broken and nothing was charged, while a
`200` with `ok: false` means it worked and the input was bad.

### `station` is capped at 10 characters

`src/schema.ts:13-19` bounds `station` to 2–10 characters, so codes (`NDLS`, `MAO`,
`MMCT`) work and full names do not: `Hazrat Nizamuddin` is rejected. A
parenthesised code is preferred, so `NDLS (New Delhi)` yields `NDLS`. This is a
known scope boundary chosen for the 5-letter Indian Railways station-code
convention, not an oversight. Raise the cap in `src/schema.ts` if you want long
names.

### Other limitations found while testing

- **Unlabelled continuation lines are dropped.** A `reason` wrapped onto a line
  with no label loses the continuation. Joining arbitrary trailing lines would
  swallow footers and sign-offs, so the parser reads labelled lines only.
- **A `reason` over 500 characters fails the whole notice**, even when the
  notice is within `MAX_NOTICE_LEN` (2000). Two independent limits.
- **A repeated field is rejected, not resolved.** Two `Train No:` lines produce a
  `duplicate` issue, because there is no way to know which is authoritative.
- **The parser reports every problem at once**, one issue per field. A bad time
  no longer surfaces twice (specific message plus a raw zod complaint about
  `null`), which was a real defect found by the test suite.
- **A `500` bypasses this project's error handler.** When
  `X402_SYNC_ON_START=false`, the x402 middleware throws inside its own async
  path, so Express's default handler answers and the client gets
  `{"error":"Internal Server Error"}` rather than the `{"error":"internal_error"}`
  the handler at `src/server.ts:224-245` would produce. The cause is only in the
  server log.
- **The request body cap is derived, not fixed**:
  `4 KB + MAX_BULK_ITEMS * MAX_NOTICE_LEN * 4` = `84096` bytes. A hardcoded
  20 KB cap would reject requests the server's own field limits allow — a
  maximal legal batch is about 59 KB. Both directions were tested: a 59 KB batch
  is accepted, a 160 KB body gets `413`.
- **No linter is configured for this subproject**, and the parent ESLint config
  ignores `railways/` deliberately, because it would type-check this package
  against the wrong tsconfig.
- **Prices are hardcoded per route in `buildRoutes`**, not per-item. A future
  need for per-notice pricing would require changing the route table shape.

### Parser acceptance rules

| Field          | Required | Rule |
| -------------- | -------- | ---- |
| `train`        | yes      | 4 or 5 digits from a leading digit run. `12951 (Mumbai Rajdhani)` accepted; `1295a` and `129512` rejected. |
| `station`      | yes      | 2–10 chars, codes preferred. |
| `expectedTime` | yes      | Normalised to 24-hour `HH:MM` from `19:45`, `7:45 PM`, `7 PM`, `0915 HRS`, `0745`, Devanagari digits, `सायं`/`सुबह`. |
| `reason`       | no       | Free text, whitespace collapsed, 500 chars max. |

Labels: `Train No`, `Station`, `Expected Time`, `Reason` and the Hindi
`ट्रेन संख्या`, `स्टेशन`, `अनुमानित समय`, `कारण`. The separator (`:`, `-`, `–`) is
optional, and values may contain colons, which is why `Expected Time: 19:45` is
not mis-split at the first one. Issue codes: `missing`, `duplicate`,
`empty-value`, `invalid-value`, `unrecognized-document`.

## 9. Security

- **Secrets come from the environment only.** `BUYER_PRIVATE_KEY` is read by
  `buyer/buyer.ts` through `loadBuyerConfig` (`src/config.ts:229-251`), which
  uses a schema separate from the server's so no key is ever required to boot
  the server. Nothing is read from the request body, query string or headers
  except `notice` and `notices`.
- **`PAY_TO` is an address, never a key.** `src/config.ts:158-160` says so in
  the error text. `BUYER_PRIVATE_KEY` is the only signing key in the project.
- **`.env` is gitignored.** `.gitignore` lists `.env`, `.env.*` and
  `!.env.example`, so every `.env` variant is excluded and only the template is
  committable. `.env.example` contains placeholders only — its one
  `BUYER_PRIVATE_KEY` line is commented out and all-zero.
- **`chmod 600 .env`** before adding a key, as in §5. Worth doing: the parent
  directory's `.env` shipped world-readable (`-rwxrwxrwx`), which is harmless
  while it holds no key and not harmless once it does.
- **A secret scan across all non-`node_modules` files found nothing live.** No
  mnemonic or seed phrase anywhere, and the only 64-hex-character strings in the
  tree are the two all-zero `BUYER_PRIVATE_KEY` placeholders and the settlement
  transaction hashes quoted in §7, which are public on-chain data.
- **Caveat on that scan:** this checkout is **not a git repository** yet
  (`fatal: not a git repository`), so the scan covered the working tree rather
  than git-tracked files. Re-run it once the project is initialised and before
  your first push, since history is where secrets actually leak.
- The public facilitator at `https://x402.org/facilitator` is shared and rate
  limited, and it sees every payment's amount, sender and recipient. Use your own
  facilitator if that matters.
