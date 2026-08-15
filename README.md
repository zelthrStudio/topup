# @zelthr/topup

TrueMoney gift-code redemption and Thai bank-slip verification for Node.js.

- **TrueMoney redemption** — redeem a gift code / gift URL to any 10-digit Thai mobile number, with an optional expected-amount check.
- **Slip verification (Slip Verify)** — verify a Thai bank transfer slip photo via a partner Slip Verify API, using either remote OCR, local QR decode + local amount OCR, or a fully manual amount.
- **Local QR decoding** — PromptPay EMVCo and Thai bank slip-check (Mini-QR) decoding with CRC-16 verification, plus strict parsing mode.
- **Local OCR amount extraction** — QR-first, then Guten OCR (ONNX), then tesseract fallback, with a fast amount-band fast path.

## Requirements

- Node.js **>= 18.17** (CommonJS; sharp 0.33 requires 18.17+)

## Installation

```bash
npm install @zelthr/topup
```

The package loads the ONNX model and spawns the tesseract worker pool lazily on
first local-OCR call — importing the package alone is cheap.

## Quick Start

```js
const { truemoney, bank, decodeQr, getSlipAmount } = require('@zelthr/topup');

// 1. Redeem a TrueMoney gift code
const res = await truemoney('ABCD1234EFGH', '0812345678');
// With expected amount (throws AmountMismatchError on mismatch):
const res2 = await truemoney('https://gift.truemoney.com/campaign/?v=XXXX', '0812345678', { amount: 100 });

// 2. Verify a bank slip (remote OCR mode)
const slip = await bank(fs.readFileSync('slip.jpg').toString('base64'), 'OCR');

// 3. Decode a QR payload
const qr = await decodeQr(fs.readFileSync('slip.jpg'));
console.log(qr.slipCheck);   // { version, bankCode, reference, country, crc, crcValid }
console.log(qr.emvco);       // PromptPay EMVCo, when present
```

## API

### `truemoney(codeOrLink, phone, options?)`

Redeems a TrueMoney gift code.

| arg | type | description |
| --- | --- | --- |
| `codeOrLink` | `string` | Gift code (`ABCD1234EFGH`) or full gift URL (URL-encoded automatically). |
| `phone` | `string` | 10-digit Thai mobile number (`08x...`). Whitespace is normalized. |
| `options.amount` | `number` | Optional. If set, the redeemed amount is compared and a mismatch throws `AmountMismatchError` (`slug === 'amount-mismatch'`). |

Returns the parsed upstream JSON response.

### `bank(data, mode, amount?)`

Verifies a bank slip photo through a partner Slip Verify API.

| arg | type | description |
| --- | --- | --- |
| `data` | `string` | Base64 image data (or `data:` URI). In `MANUAL` mode without an image, the raw QR payload string. |
| `mode` | `'OCR' \| 'LOCALOCR' \| 'MANUAL'` | Remote OCR / local QR+amount OCR then API / amount supplied manually. |
| `amount` | `number` | Explicit amount (required for `MANUAL` without an image). |

Throws `ValidationError` on bad input, oversized images, or non-image data, and
`HttpError` (with `.status`, `.slug`, `.body`) on upstream failures.

### `decodeQr(imageBuffer)`

Scans an image for a QR code and returns a `DecodedQr`:

```ts
{ raw: string; emvco?: EmvcoQr; slipCheck?: SlipCheckQr; crcValid?: boolean }
```

### `parseEmvco(payload, options?)` / `parseSlipCheck(payload, options?)`

Parse a QR payload string. Pass `{ strict: true }` to throw `QrParseError` on
malformed/duplicate/truncated TLV structure and `CrcValidationError` on a CRC
mismatch. Lenient (default) tolerates malformed tails.

### `getSlipAmount(imageBuffer, bankCode?, options?)`

Locally extracts candidate amounts from a slip image via OCR. Returns:

```ts
{ success: boolean; amounts: number[]; source?: 'fast'|'guten'|'tesseract'; confidence?: number; error?: string }
```

`source` tells you which strategy found the amounts; `confidence` is the real
mean line confidence from Guten (undefined for tesseract).

### Low-level helpers

- `verifyCrc(payload, tag)` / `crc16ccitt(input)` — CRC-16/CCITT-FALSE verification.
- `warmupAmountExtractor()` — pre-load ONNX model + tesseract workers before first call.
- `terminateAmountExtractor()` — release workers on app shutdown.
- `TMN_BASE` / `SLIP_BASE` — base URL constants (override with env vars, below).

## OCR pipeline

`bank(data, 'LOCALOCR')` and `getSlipAmount()` try strategies in order:

1. **QR-first** — if the image contains a slip-check QR, the bank code drives the crop profile and, when present, the amount is taken from the EMVCo tag.
2. **Fast amount band** — the bottom-right amount band is OCR-ed at reduced scale (much faster than a full-image pass).
3. **Profiled full-image Guten** — bank-specific brightness/contrast/threshold enhancement then Guten OCR (ONNX).
4. **Tesseract** — CPU fallback with a bounded worker pool and per-worker timeout/replacement.

Engines initialize lazily; call `warmupAmountExtractor()` for latency-critical paths.

## Error handling

All errors extend a common base and are exported:

- `TopupError` — base class (`instanceof` for broad catches).
- `ValidationError` — invalid caller input.
- `QrParseError` — QR payload could not be parsed.
- `CrcValidationError` — CRC/structural verification failed.
- `OcrError` / `OcrTimeoutError` — OCR engine failure / deadline exceeded.
- `HttpError` — non-2xx or transport failure, with `.status`, `.slug`, `.body`.
- `TimeoutError` — request exceeded its deadline (30 s default).
- `AmountMismatchError` — extends `HttpError`, `slug === 'amount-mismatch'`.

```js
try {
  await truemoney(code, phone, { amount: 100 });
} catch (err) {
  if (err instanceof require('@zelthr/topup').AmountMismatchError) { /* ... */ }
}
```

## Performance

- Fast path: ~380–700 ms per slip (amount-band OCR only).
- Full pipeline (Guten full-image): ~700–1500 ms per pass; tesseract fallback ~1–2 s.
- The OCR engines are lazy; nothing is loaded at import time.

## Environment variables

| var | effect |
| --- | --- |
| `TMN_API_URL` | Override TrueMoney base URL (default `https://api.zelthr.rest`). |
| `SLIP_API_URL` | Override the Slip Verify base URL. |
| `TOPUP_DEBUG=1` | Enable internal debug logging. |
| `TESSERACT_MAX_WORKERS` / `TESSERACT_WORKERS` | Cap the tesseract worker pool (default 3). |

## Troubleshooting

- **Import hangs / heavy on startup**: engines load lazily — only `warmupAmountExtractor()` or a local-OCR call triggers model/worker loading.
- **OCR misses the amount**: `getSlipAmount` falls back through all strategies; pass the bank code (e.g. `'004'`, `'025'`) to use the right enhancement profile. For bank `004` the image needs the profile's contrast/threshold.
- **Install scripts blocked on npm >= 11.9**: newer npm blocks lifecycle scripts by default unless covered by `allowScripts`. The installed package includes `eng.traineddata` and onnxruntime's platform binaries, so nothing is downloaded at install; but if an environment refuses the ONNX/sharp scripts, allow them:
  ```bash
  npm install-scripts approve onnxruntime-node sharp tesseract.js
  ```
  or add to `package.json`: `"allowScripts": { "onnxruntime-node": true, "sharp": true, "tesseract.js": true }`.
- **OCR offline**: the package ships `eng.traineddata` inside the tarball, so tesseract falls back to its CDN only if that file was removed.

## Known limitations

- **Format restriction:** only **JPEG, PNG and WebP** images are accepted. The input
  format is sniffed from magic bytes *before* any libvips decode, which also neutralizes
  the known libvips CVEs in sharp <0.35 (GIF/TIFF/VIPS decoders). See
  [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md) for the full assessment.
- **`npm audit` on a consumer tree** still reports the nested `sharp@0.33.5` pulled by
  `@gutenye/ocr-node` (no patched version fits its `^0.33.3` range). Runtime is protected
  by the format allowlist above; a consumer can optionally add a root-level
  `overrides` entry for a fully clean audit (documented in `SECURITY-AUDIT.md`).
- **Process exit:** local OCR keeps a tesseract worker pool alive; call
  `terminateAmountExtractor()` before the app exits.
- The package is CommonJS-only; ESM consumers use `import { bank } from '@zelthr/topup'`
  (verified supported via Node's named-import interop). There is no dual ESM/CJS build.

## License

MIT