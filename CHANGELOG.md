# Changelog

All notable changes to `@zelthr/topup` will be documented in this file.

## [Unreleased] — whole-baht OCR amounts

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

## [Unreleased] — review-driven correctness & hardening

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

## [Unreleased] — hardening & OCR performance

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

## [Unreleased] — security hardening

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

## [Unreleased] — v1.0.0 (release preparation)

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