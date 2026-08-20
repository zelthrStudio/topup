# @zelthr/topup

A thin, dependency-light Node.js client for the [zelthrStudio Open API gateway](https://zelthr.rest/docs) — TrueMoney gift-code redemption and Thai bank-slip verification, served from `https://api.zelthr.rest`.

The package does **no local work**: every call is forwarded to the gateway, which talks to the TrueMoney core and runs the full slip OCR pipeline itself. No image scanning, no QR parsing, no native binaries — just two clean API calls.

## Endpoints

Both services share the gateway's single unified verification endpoint (`POST /`); the gateway auto-detects which service to run from the request body.

| Function | Request body | Purpose |
| --- | --- | --- |
| `truemoney(code, phone, options?)` | `{ gift, phone }` | Check / redeem a TrueMoney voucher code |
| `bank(data, options?)` | `{ img }` | Verify a Thai bank transfer slip from an image |

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
// Automatically normalizes '081-234-5678', '+66812345678', ' 081 234 5678 ', etc.
const res = await truemoney('ABCD1234EFGH', '0812345678');

// Gift URLs work too, and you can verify the redeemed amount
const res2 = await truemoney('https://gift.truemoney.com/campaign/?v=XXXX', '+66812345678', { amount: 100 });
// throws AmountMismatchError if the code redeemed a different amount
```

### Bank slip verification

```js
const { bank } = require('@zelthr/topup');
const fs = require('node:fs');

// Pass a Buffer directly from fs.readFileSync:
const res = await bank(fs.readFileSync('slip.jpg'));
// { success: true, amount: 80, ... } — the verified slip result

// Or pass a base64 string / data URI:
const res2 = await bank('data:image/jpeg;base64,...');

// Optional amount verification:
const res3 = await bank(fs.readFileSync('slip.jpg'), { amount: 80 });
// throws AmountMismatchError if the verified slip amount differs
```

Bare base64 strings, `Buffer`, `Uint8Array`, and `ArrayBuffer` are handled automatically.

## API

### `truemoney(codeOrLink, phone, options?)`

Redeems a TrueMoney voucher via the unified endpoint (`POST /`).

| arg | type | description |
| --- | --- | --- |
| `codeOrLink` | `string` | Gift code (e.g. `ABCD1234EFGH`) or full gift URL. |
| `phone` | `string` | Optional. Thai mobile number (`08x...`, `+668x...`, `08x-xxx-xxxx`); formatting and whitespace are normalized automatically. If omitted, the server's configured wallet number is used. |
| `options.amount` | `number` | Optional. If set, the redeemed amount is compared against it and a mismatch throws `AmountMismatchError` (`slug === 'amount-mismatch'`). |
| `options.timeoutMs` | `number` | Optional request deadline in milliseconds (default: 30000). |
| `options.baseUrl` | `string` | Optional base URL override (default: `https://api.zelthr.rest`). |
| `options.headers` | `object` | Optional custom headers. |

Under the hood:

```
POST https://api.zelthr.rest/
{ "gift": "ABCD1234EFGH", "phone": "0812345678" }
```

Returns the gateway JSON response (the upstream redeem result as-is). A non-existent voucher is a normal `200` with `status.code === 'VOUCHER_NOT_FOUND'` — HTTP 4xx/5xx means the request itself was rejected or the upstream failed.

### `bank(data, options?)`

Verifies a Thai bank transfer slip via the unified endpoint (`POST /`). The gateway decodes the QR, extracts the amount and verifies it upstream.

| arg | type | description |
| --- | --- | --- |
| `data` | `string \| Buffer \| Uint8Array \| ArrayBuffer` | Slip image as a Buffer, Uint8Array, ArrayBuffer, base64 string, or `data:` URI. |
| `options.amount` | `number` | Optional expected amount (baht). Throws `AmountMismatchError` if verified slip amount does not match. |
| `options.timeoutMs` | `number` | Optional request deadline in milliseconds (default: 30000). |
| `options.baseUrl` | `string` | Optional base URL override (default: `https://api.zelthr.rest`). |
| `options.headers` | `object` | Optional custom headers. |

Under the hood:

```
POST https://api.zelthr.rest/
{ "img": "data:image/jpeg;base64,/9j/4AAQ..." }
```

Returns the upstream verified-slip result as-is. Throws `ValidationError` on empty input or oversized payloads, and `HttpError` on gateway failures (e.g. `400 invalid-image`, `422 qr-not-found`, `429 rate-limit-exceeded`, `502 upstream-error`).

### Low-level helpers

- `post(url, body?, options?)` — shared POST helper used by both clients (JSON body, 30 s deadline, 32 MiB body cap, redirects disabled).
- `TMN_BASE` / `SLIP_BASE` — gateway base URL constants (`https://api.zelthr.rest`), overridable via env vars below.

## Error handling

All errors extend a common base and are exported:

| Error | Meaning |
| --- | --- |
| `TopupError` | Base class — catch this for broad handling. |
| `ValidationError` | Invalid caller input (empty code, bad phone, invalid image, ...). |
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

The gateway enforces per-IP limits — tmn: 200/min, slip: 100/min — and returns `429` with a `Retry-After` header when exceeded, surfaced as an `HttpError` with `slug === 'rate-limit-exceeded'`.

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