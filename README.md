# @zelthr/topup

A thin, dependency-light Node.js client for the [zelthrStudio Open API gateway](https://zelthr.rest/docs) — TrueMoney gift-code redemption and Thai bank-slip verification, served from `https://api.zelthr.rest`.

The package does **no local work**: every call is forwarded to the gateway, which talks to the TrueMoney core and runs the full slip OCR pipeline itself. No image scanning, no QR parsing, no native binaries — just two clean API calls.

## Endpoints

| Function | Gateway route | Purpose |
| --- | --- | --- |
| `truemoney(code, phone, options?)` | `POST /tmn` | Check / redeem a TrueMoney voucher code |
| `bank(data)` | `POST /slip` | Verify a Thai bank transfer slip from an image |

## Requirements

- Node.js **>= 20.9**

## Installation

```bash
npm install @zelthr/topup
```

No install scripts, no native binaries, no model files — installs on any platform in seconds.

## Quick Start

### TrueMoney voucher redemption

```js
const { truemoney } = require('@zelthr/topup');

// Redeem a gift code to a 10-digit Thai mobile number
const res = await truemoney('ABCD1234EFGH', '0812345678');

// Gift URLs work too, and you can verify the redeemed amount
const res2 = await truemoney('https://gift.truemoney.com/campaign/?v=XXXX', '0812345678', { amount: 100 });
// throws AmountMismatchError if the code redeemed a different amount
```

### Bank slip verification

```js
const { bank } = require('@zelthr/topup');
const fs = require('node:fs');

const img = 'data:image/jpeg;base64,' + fs.readFileSync('slip.jpg').toString('base64');
const res = await bank(img);
// { success: true, amount: 80, ... } — the verified slip result
```

Bare base64 strings are wrapped as `data:image/jpeg;base64,...` automatically.

## API

### `truemoney(codeOrLink, phone, options?)`

Redeems a TrueMoney voucher via `POST /tmn`.

| arg | type | description |
| --- | --- | --- |
| `codeOrLink` | `string` | Gift code (e.g. `ABCD1234EFGH`) or full gift URL. |
| `phone` | `string` | 10-digit Thai mobile number (`08x...`); whitespace is normalized. |
| `options.amount` | `number` | Optional. If set, the redeemed amount is compared against it and a mismatch throws `AmountMismatchError` (`slug === 'amount-mismatch'`). |

Under the hood:

```
POST https://api.zelthr.rest/tmn
{ "code": "ABCD1234EFGH", "mobile": "0812345678" }
```

Returns the gateway JSON response (the upstream redeem result as-is). A non-existent voucher is a normal `200` with `status.code === 'VOUCHER_NOT_FOUND'` — HTTP 4xx/5xx means the request itself was rejected or the upstream failed.

### `bank(data)`

Verifies a Thai bank transfer slip via `POST /slip`. The gateway decodes the QR, extracts the amount and verifies it upstream.

| arg | type | description |
| --- | --- | --- |
| `data` | `string` | Slip image as a base64 string or a full `data:` URI (e.g. `data:image/jpeg;base64,...`). |

Under the hood:

```
POST https://api.zelthr.rest/slip
{ "img": "data:image/jpeg;base64,/9j/4AAQ..." }
```

Returns the upstream verified-slip result as-is. Throws `ValidationError` on empty input or oversized payloads, and `HttpError` on gateway failures (e.g. `400 invalid-image`, `429` rate limit, `503` OCR pipeline busy).

### Low-level helpers

- `post(url, body?, options?)` — shared POST helper used by both clients (JSON body, 30 s deadline, 32 MiB body cap, redirects disabled).
- `TMN_BASE` / `SLIP_BASE` — gateway base URL constants (`https://api.zelthr.rest`), overridable via env vars below.

## Error handling

All errors extend a common base and are exported:

| Error | Meaning |
| --- | --- |
| `TopupError` | Base class — catch this for broad handling. |
| `ValidationError` | Invalid caller input (empty code, bad phone, ...). |
| `TimeoutError` | Request exceeded its deadline (30 s default). |
| `HttpError` | Non-2xx or transport failure, with `.status`, `.slug`, `.body`. |
| `AmountMismatchError` | Extends `HttpError`; the code redeemed a different amount than expected (`slug === 'amount-mismatch'`). |
| `AmountVerificationError` | Extends `HttpError`; amount verification was requested but no amount could be extracted from the response. |

```js
const { truemoney, AmountMismatchError } = require('@zelthr/topup');

try {
  await truemoney(code, phone, { amount: 100 });
} catch (err) {
  if (err instanceof AmountMismatchError) {
    console.error(`redeemed ${err.body ? JSON.stringify(err.body) : '?'} instead of 100 THB`);
  }
}
```

## Rate limits

The gateway enforces per-IP limits — tmn: 60/min, slip: 20/min — and returns `429` with `Retry-After` when exceeded, surfaced as an `HttpError` with `slug === 'rate-limited'`.

## Environment variables

| var | effect |
| --- | --- |
| `TMN_API_URL` | Override the gateway base URL for `truemoney()` (default `https://api.zelthr.rest`). |
| `SLIP_API_URL` | Override the gateway base URL for `bank()` (default `https://api.zelthr.rest`). |

## Security

- Gift codes, phone numbers and slip images travel in the JSON body over TLS only — redirects are disabled and ambient proxies (`HTTP_PROXY`/`HTTPS_PROXY`) are explicitly ignored, so a 307/308 can never re-POST your data to another host.
- Error messages redact the request URL and cap server-controlled text; oversized error bodies are truncated to a 64 KB preview.

## License

MIT