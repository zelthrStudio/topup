# @zelthr/topup

TrueMoney gift-code redemption and Thai bank-slip verification for Node.js — through the [zelthrStudio Open API gateway](https://zelthr.rest/docs) (`https://api.zelthr.rest`).

- **TrueMoney redemption** — `truemoney()` posts to `POST /tmn` and redeems a gift code / gift URL to any 10-digit Thai mobile number, with an optional expected-amount check.
- **Slip verification** — `bank()` posts your slip image to `POST /slip`; the gateway runs the full OCR pipeline (QR decode, amount extraction, upstream verification) so **this package performs no local scanning and has no native dependencies**.
- **Pure QR utilities** — PromptPay EMVCo and Thai bank slip-check (Mini-QR) parsing with CRC-16 verification (strict mode), plus `getQrCodePromptPay` for generating PromptPay QR payloads (PNG/SVG).

## Requirements

- Node.js **>= 20.9**

## Installation

```bash
npm install @zelthr/topup
```

No install scripts, no native binaries, no model files — the tarball is tiny and installs on any platform.

## Quick Start

```js
const { truemoney, bank } = require('@zelthr/topup');

// 1. Redeem a TrueMoney gift code (gateway talks to the TrueMoney core)
const res = await truemoney('ABCD1234EFGH', '0812345678');
// With expected amount (throws AmountMismatchError on mismatch):
const res2 = await truemoney('https://gift.truemoney.com/campaign/?v=XXXX', '0812345678', { amount: 100 });

// 2. Verify a bank slip (the gateway scans the image for you)
const slip = await bank(fs.readFileSync('slip.jpg').toString('base64'));
```

## API

### `truemoney(codeOrLink, phone, options?)`

Redeems a TrueMoney gift code via the gateway (`POST /tmn`).

| arg | type | description |
| --- | --- | --- |
| `codeOrLink` | `string` | Gift code (`ABCD1234EFGH`) or full gift URL. |
| `phone` | `string` | 10-digit Thai mobile number (`08x...`). Whitespace is normalized. |
| `options.amount` | `number` | Optional. If set, the redeemed amount is compared and a mismatch throws `AmountMismatchError` (`slug === 'amount-mismatch'`). |

Returns the parsed gateway JSON response (the upstream redeem result as-is).

### `bank(data)`

Verifies a Thai bank transfer slip via the gateway (`POST /slip`). No local scanning happens — the gateway decodes the QR, extracts the amount and verifies it upstream.

| arg | type | description |
| --- | --- | --- |
| `data` | `string` | Slip image as a base64 string or a full `data:` URI (e.g. `data:image/jpeg;base64,...`). Bare base64 is wrapped as a JPEG data URI. |

Returns the upstream verified-slip result as-is. Throws `ValidationError` on empty input or oversized payloads, and `HttpError` (with `.status`, `.slug`, `.body`) on gateway failures (e.g. `400 invalid-image`, `429` rate limit, `5xx`).

### `parseEmvco(payload, options?)` / `parseSlipCheck(payload, options?)`

Parse a QR payload string. Pass `{ strict: true }` to throw `QrParseError` on malformed/duplicate/truncated TLV structure and `CrcValidationError` on a CRC mismatch. Lenient (default) tolerates malformed tails.

### `getQrCodePromptPay(target, options?)`

Generates a PromptPay QR payload (+ PNG/SVG) for a mobile number, national ID or e-wallet ID. `MAX_PROMPTPAY_AMOUNT` is the BOT 200,000 Baht limit.

### Low-level helpers

- `verifyCrc(payload, tag)` / `crc16ccitt(input)` — CRC-16/CCITT-FALSE verification.
- `post(url, body?, options?)` — the shared POST helper (deadline, body cap, redirects disabled).
- `TMN_BASE` / `SLIP_BASE` — base URL constants (override with env vars, below).

## Error handling

All errors extend a common base and are exported:

- `TopupError` — base class (`instanceof` for broad catches).
- `ValidationError` — invalid caller input.
- `QrParseError` — QR payload could not be parsed.
- `CrcValidationError` — CRC/structural verification failed.
- `HttpError` — non-2xx or transport failure, with `.status`, `.slug`, `.body`.
- `TimeoutError` — request exceeded its deadline (30 s default).
- `AmountMismatchError` — extends `HttpError`, `slug === 'amount-mismatch'`.
- `AmountVerificationError` — extends `HttpError`, `slug === 'amount-unverifiable'`.

```js
try {
  await truemoney(code, phone, { amount: 100 });
} catch (err) {
  if (err instanceof require('@zelthr/topup').AmountMismatchError) { /* ... */ }
}
```

## Environment variables

| var | effect |
| --- | --- |
| `TMN_API_URL` | Override the gateway base URL for `truemoney()` (default `https://api.zelthr.rest`). |
| `SLIP_API_URL` | Override the gateway base URL for `bank()` (default `https://api.zelthr.rest`). |

## Security

- Gift codes, phone numbers, slip images and tokens are sent in the JSON body / TLS only — never through a redirect (redirects are disabled) and never through ambient proxies (`proxy: null`).
- Error messages redact the request URL and cap server-controlled text; oversized error bodies are truncated to a 64 KB preview.
- The gateway enforces per-IP rate limits (tmn: 60/min, slip: 20/min) and returns `429` with `Retry-After` when exceeded.

See [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md) for the full assessment.

## License

MIT