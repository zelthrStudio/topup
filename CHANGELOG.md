# Changelog

All notable changes to `@zelthr/topup` will be documented in this file.

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