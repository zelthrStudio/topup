# Changelog

All notable changes to `@zelthr/topup` will be documented in this file.

## [Unreleased] — PromptPay QR generation

### Added
- **`getQrCodePromptPay(id, options)`** generates PromptPay QR codes via the
  org's own **`@zelthr/qrcode`** generator: mobile numbers, national ID / tax
  ID (13 digits) and e-wallet IDs (15 digits) are validated and normalized
  (BOT 13-digit target format). Returns the EMVCo payload, the QR module
  matrix and ready-to-render **PNG and SVG** output. Dynamic (amount) and
  static (no amount) QRs are supported with an optional `maxAmount` override;
  invalid IDs, amounts or render options throw `ValidationError`.
- **`MAX_PROMPTPAY_AMOUNT`** — the BOT PromptPay per-transaction limit
  (`200000` Baht), used as the default `maxAmount`.

### Changed
- **Next.js / web-framework support.** The package now ships an ESM facade
  (`dist/index.mjs`) wired through the `exports` map (`import`/`require`
  conditions) with `sideEffects: false` for tree-shaking — ESM named imports
  work out of the box in Next.js (route handlers, server components and
  `'use client'` components), Vite and Node ESM.
- **Node-only dependencies are now loaded lazily.** `sharp` (libvips),
  `@zelthr/request`, `tesseract.js`, `node:fs`/`node:path` and the OCR engines
  load only when their code path is actually called, through dynamic
  `import()` calls that bundlers cannot see. Importing the package no longer
  loads any native addon, and browser bundles (which only use
  `getQrCodePromptPay` / `decodeQr`-adjacent APIs) contain **no** sharp,
  onnxruntime or tesseract.js code (verified: 31.6 kB Vite client bundle,
  Next.js client chunks clean). Local OCR / slip-image APIs remain
  server-only by nature and throw at call time in browsers.

## [Unreleased] — QR scanning on @zelthr/qrcode

### Changed
- QR image scanning now uses the org's own zero-dependency **`@zelthr/qrcode`**
  (OpenCV WASM + WeChat QR detector) instead of the vendored
  `qr-scanner-wechat` dependency — same detector, one fewer third-party
  runtime dependency. The scanner stays lazily loaded through a real
  `import()` (the package is ESM-only), so the CommonJS build and first-call
  latency are unchanged.

## [v1.0.8] - 2026-08-15 — outbound transport on @zelthr/request

### Changed
- The HTTP client (`post()`, used by `truemoney()` and `bank()`) now sends
  every request through **`@zelthr/request`** (the monorepo HTTP client,
  `^1.1.2`) instead of Node's built-in `fetch`. All values are passed as
  library options: POST method, JSON-serialized body with
  `Content-Type: application/json`, `timeout`, `maxBytes` (response body
  budget, default 32 MiB), `followRedirect: false` (never re-POST a slip
  image / gift code to a redirected host) and `gzip: true` (decode compressed
  responses).

### Fixed
- Redirects are no longer transport errors: a 3xx (e.g. 307) arrives as a
  normal response and surfaces as `HttpError` with the status code — the
  previous `fetch` `redirect: 'error'` path reported it as a generic
  "request failed (TypeError)". The body is never re-POSTed (unchanged).
- Timeout errors are mapped from the library's `ETIMEDOUT` /
  `ESOCKETTIMEDOUT` to `TimeoutError`; oversized response bodies
  (`EBODYLIMIT`) map to `HttpError` mentioning the cap. Both keep the
  redacted-URL error messages (no gift code / phone in logs, M-4).
- Error-message redaction is now covered by a dedicated timeout-path test
  (secret path segments must never appear in messages).

## [v1.0.7] - 2026-08-15 — audit round 3 (report-1: leaks, caps, HEIC, drift)

### Security
- **Leak:** `post()` error messages redact the request URL to origin + first
  path segment — the TrueMoney gift code and phone number (path segments)
  no longer reach consumer logs / error trackers (report-1 M-4).
- **Leak:** oversized error response bodies (>64 KB) are no longer attached to
  `HttpError` nor JSON-parsed; a capped `bodyPreview` string is kept instead
  (report-1 L-9).
- **Supply chain:** `sharp` bumped to ^0.35.3 (root and via `overrides`) —
  clears the libvips decode CVEs (CVE-2026-33327/33328/35590/35591) from
  `npm audit`; the magic-byte sniff gate stays regardless. sharp ≥0.35 needs
  Node ≥20.9, so **Node 18 support is dropped** (Node 18 is EOL since April
  2025); `engines` is now `>=20.9` and the CI matrix runs 20/22/24.
- **DX/security:** HEIC/AVIF inputs (iPhone/Android camera defaults) now
  raise a clear error in `decodeQr` / `getSlipAmount` / `bank()` instead of a
  silent "no QR found" / "unsupported format" (report-1 B18).

### Correctness
- **Dates:** slash dates ("25/12/2567") and dot dates ("25.12.67") can no
  longer be misread as amounts; `extractAmounts()` input is capped at 8192
  chars against regex backtracking (report-1 B2, L-5).
- **TLV:** length fields must be two decimal digits — "1x" no longer
  silently parses as 1 (report-1 A3).
- **Slip-check drift:** header recognition reads the tag-00 length and inner
  version dynamically (`isSlipCheckPayload`); a future format version or a
  4-digit bank code keeps parsing (report-1 B5).
- **MANUAL mode:** long EMVCo payloads (000201 prefix) are treated as QR
  data even when their length is a multiple of 4 (report-1 L-7/B24).
- `getSlipAmount`/`decodeRaw` enforce the same dimension/pixel caps as the
  QR decoder (report-1 L-3/B10).
- `TESSERACT_LANG_PATH` env override for bundled consumers whose `__dirname`
  no longer points at the package (report-1 B16).

## [v1.0.6] - 2026-08-15 — audit round 2 (CRC, redirects, budgets)

### Fixed
- **Correctness:** `crc16ccitt()` now checksums the payload's **UTF-8 bytes**
  (ISO/IEC 13239) instead of UTF-16 code units. Thai merchant names (tag 59)
  on real merchant QRs made the old checksum differ from the one the banks
  compute, rejecting valid slips with `CrcValidationError`.
- **Security:** `resolveAmount()` trusts the QR amount only when the payload
  carries no CRC claim or the claimed tag-63 CRC verifies — a tampered
  payload with a wrong CRC can no longer override what OCR reads from the
  actual slip.
- **Security:** tag-54 amounts must be plain numeric strings (≤13 digits,
  2 decimals); exponent/garbage values like "1e+21" can no longer reach the
  Slip Verify URL path.
- **Security:** the HTTP client sets `redirect: 'error'` — a 307/308 from a
  compromised API can no longer re-POST the slip image / gift code to an
  attacker-controlled host.
- **Security:** `decodeQr()` enforces dimension/pixel caps (16384 px,
  40 MP) and a 30 s scan deadline; a pathological image can no longer force
  a multi-hundred-MB RGBA decode or an unbounded WASM detect.
- **Availability:** tesseract worker creation races a 60 s deadline and
  fails fast when the shipped `eng.traineddata` is missing (no silent CDN
  hang); worker-pool waiters time out after 90 s instead of waiting forever
  when a replacement spawn fails.
- **Availability:** `getSlipAmount()` races an overall 60 s pipeline deadline
  (`options.timeoutMs`) — the sequential engine attempts can no longer chain
  into minutes of CPU.
- `HttpError` messages are capped at 2000 chars (server-controlled text is
  no longer logged verbatim in full).
- `extractRedeemAmount()` also recognizes `redeemed_amount`.
- `parseTlv()` caps nesting at 32 levels — crafted deep nesting can no
  longer overflow the stack.
- `TESSERACT_MAX_WORKERS` is clamped to 1–8 (each worker holds ~200 MB).

## [v1.0.5] - 2026-08-15 — whole-baht OCR amounts

### Fixed
- **Correctness:** Thai slips that print whole baht without decimals (e.g.
  "5 บาท") are now extracted — previously `extractAmounts()` only matched
  `.XX` decimal amounts, so a real "5" was skipped while a date/time line
  ("14 ก.ย. 69 14:43") could be misread as "6914.43" and sent to the Slip
  Verify API. Verified end-to-end on a real 5-baht Paotang slip.
- Whole-baht candidates must be bounded by non-word characters: times
  ("14:43"), references ("50BPP03857", "25512636416"), account suffixes
  ("0471") and misread unit words ("U1n" for "บาท") can no longer become
  amounts.
- Currency stripping now removes only the `฿` symbol. Deleting a literal
  "B" forged a fake token boundary (e.g. "50BPP03857" → "50 …") that made
  reference numbers look like amounts.
- Amount-band (fast path) detections carry double agreement weight so the
  region purpose-built for the amount wins ties against full-image noise.

## [v1.0.4] - 2026-08-15 — review-driven correctness & hardening

### Fixed
- **Security:** `truemoney()` with an explicit `amount` now throws a new
  `AmountVerificationError` (slug `amount-unverifiable`) when the response
  contains no extractable redeemed amount — verification can no longer pass
  silently because a field was missing.
- **Security:** `extractRedeemAmount()` prefers direct top-level amount keys
  before the deep walk, so a nested fee breakdown iterated first can never
  shadow the real top-level amount.
- **Security:** OCR amount ties in `resolveAmount()` break toward the
  *smaller* amount — a misread that inflates a digit can no longer win ties.
- **Security:** `bank()` `amount` is bounded to `0..1,000,000,000` with at
  most 2 decimal places, so a huge/very small value can never be stringified
  into a mangled exponential-notation `/api/slip/:amt` URL.
- **Availability:** Guten/ONNX `detect()` calls now race a 30 s deadline and
  throw `OcrTimeoutError` (same pattern as tesseract) — a pathological input
  can no longer block `getSlipAmount()`/`bank()` forever.
- **Availability:** `terminateTesseractPool()` now *rejects* queued worker
  waiters instead of discarding them, so in-flight callers cannot hang on a
  promise that never settles during shutdown.
- `LOCALOCR` mode decodes the base64 payload once and reuses the buffer
  instead of decoding it twice per call.
- `readBody()` cancels the stream when the response exceeds `maxBytes`,
  releasing the connection promptly.
- `dataUriToBuffer()` rejects a malformed data URI (no comma) with a clear
  `ValidationError` instead of feeding the prefix into the base64 decoder.
- Bare-base64 image detection now requires a padded length (`% 4 === 0`), so
  a long raw EMVCo/slip-check QR payload can no longer be misclassified as
  image data in `MANUAL` mode.
- Defensive guard: the alt-profile OCR loop no longer indexes `altProfiles[0]`
  when the profile map would produce an empty list.

## [v1.0.3] - 2026-08-15 — hardening & OCR performance

### Fixed
- **Security:** EMVCo tag-54 amounts are trusted only when they parse to a
  finite number greater than zero — a `NaN`/zero/garbage tag can no longer
  reach amount checks or the Slip Verify URL. `resolveAmount()` additionally
  guards against a non-finite QR amount before preferring it.

### Changed
- `getSlipAmount()` now decodes the slip image **once** to raw RGBA pixels and
  derives every crop/band/resize/enhancement step from that single decode
  (previously each sharp() step re-decoded the full camera photo, i.e. 6–10
  full JPEG decodes per call). Measured ~437 ms per call warm (was dominated
  by repeated decodes).

## [v1.0.2] - 2026-08-15 — security hardening

### Fixed
- **Security:** `bank()` now rejects a non-finite/negative `amount` with
  `ValidationError`. Previously the `MANUAL`-mode amount was interpolated
  into the Slip Verify URL path unchecked, allowing path traversal and
  parameter injection (`/api/slip/{amount}/no_slip`).
- **Security:** `truemoney()` now always `encodeURIComponent`s the gift
  code/link into the API path. Codes containing `/`, `..`, `?` or `#` could
  previously alter the API route (path traversal / query injection).
- **Security:** `decodeQr()` now accepts image **bytes only** (a string path
  throws `ValidationError`, preventing arbitrary local file reads) and
  rejects non-JPEG/PNG/WebP buffers before libvips/sharp is asked to decode —
  closing the gap in the `SECURITY-AUDIT.md` mitigation for the nested
  `sharp@0.33.5` libvips CVEs (GIF/TIFF/VIPS decoders).
- **Security:** `post()` now caps the response body at 32 MiB by default
  (configurable via `maxBodyBytes`), throwing `HttpError` past the cap
  instead of buffering an unbounded response.
- `resolveAmount()` no longer blindly trusts the largest OCR reading: the
  amount reported by most strategies wins (per-strategy agreement counts are
  exposed on `AmountResult.counts`), with the largest likely amount as the
  tie-break — a single misread of an inflated figure can no longer drive the
  slip lookup on its own.
- `getSlipAmount()` exposes `counts` (how many strategies reported each
  amount) on the result — additive, non-breaking.

## [v1.0.0] - 2026-08-15 — release preparation

### Added
- Error hierarchy (`TopupError` base; `ValidationError`, `QrParseError`,
  `CrcValidationError`, `OcrError`/`OcrTimeoutError`, `TimeoutError`, `HttpError`,
  `AmountMismatchError`), exported from the public API.
- Strict QR parsing: `parseEmvco`/`parseSlipCheck` accept `{ strict: true }` and throw
  `QrParseError` / `CrcValidationError` on malformed/duplicate/truncated TLV or CRC mismatch.
- Image guard rails in `bank()`: base64/byte size caps, dimension and pixel limits, and a
  **magic-byte format allowlist** (JPEG/PNG/WebP only) applied before any libvips decode.
- `post(url, body?, { timeoutMs? })` — configurable request deadline (default 30 s) that
  throws `TimeoutError`.
- OCR result now reports `source` (`'fast' | 'guten' | 'tesseract'`) and real
  `confidence` (Guten mean line confidence).
- `warmupAmountExtractor()` / `terminateAmountExtractor()` for lazy pre-warm and worker
  teardown.
- GitHub Actions CI (Node 18/20/22/24 × ubuntu/windows/macos) including a consumer smoke
  test that installs the packed tarball and exercises CJS + ESM + real OCR.
- `SECURITY-AUDIT.md` with the dependency audit and revisit plan.

### Changed
- `BankMode` is now a closed union `'OCR' | 'LOCALOCR' | 'MANUAL'` (lowercase aliases
  removed) — **breaking** for callers relying on lowercase modes.
- Input-validation failures throw `ValidationError` instead of `TypeError` — **breaking**
  for code catching `TypeError`.
- HTTP failures throw `HttpError` (`.status`/`.slug`/`.body`) — the `slug` values are
  unchanged.
- Guten/tesseract console logging gated behind `TOPUP_DEBUG=1`.
- `eng.traineddata` shipped inside the tarball for offline tesseract OCR.
- `onnxruntime-node` pinned to `1.21.1` (removes vulnerable `adm-zip` from the tree).
- README expanded (requirements, env vars, troubleshooting, known limitations).

### Fixed
- `verifyCrc` now checks the CRC-tag length field (`…9104`) is present, matching the
  real SCB/BOT slip spec.
- Tesseract worker replacement no longer resurrects workers after pool teardown.
- `MAX_IMAGE_BYTES` is now the operative decoded-size limit (previously shadowed by the
  base64-length cap).
- CJS/ESM interop verified end-to-end against the installed tarball.