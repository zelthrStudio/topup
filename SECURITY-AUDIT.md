# Security Audit — @zelthr/topup

**Date:** 2026-08-17
**Scope:** `@zelthr/topup@2.0.0` — gateway-client release (no local scanning).

## Result

`npm audit --omit=dev` → **0 findings**. The dependency tree is one small
pure-JS package (`@zelthr/request`) — no native binaries, no install scripts,
no OCR engines, no model files.

## What changed since 1.x

v1.x shipped `sharp`, `onnxruntime-node`, `tesseract.js` and `@gutenye/ocr-node`
and the audit documents the libvips CVEs (GIF/TIFF/VIPS decoders) and the
`adm-zip` zip-bomb advisory that came with them. v2.0.0 **removes all of them**:
the package is now a thin client for the zelthrStudio Open API gateway, which
runs the OCR pipeline server-side. Those findings no longer apply.

## Runtime attack surface (v2)

- **Gift codes, phone numbers, slip images** are sent in the JSON body over TLS
  only. Redirects are disabled (`followRedirect: false`), so a 307/308 can never
  re-POST a slip image or gift code to a redirected host.
- **Ambient proxies are disabled** (`proxy: null`): `HTTP_PROXY`/`HTTPS_PROXY`
  env vars are ignored, so sensitive payloads cannot be routed through a proxy
  the operator did not deliberately configure.
- **Error messages redact URLs** (origin + first path segment only) and cap
  server-controlled text at 2000 chars; oversized error bodies are truncated to
  a 64 KB preview (never `JSON.parse`d beyond that).
- **Memory guard:** `bank()` caps the image payload at 40 MB of base64 before it
  is sent; oversized input throws `ValidationError` client-side.
- **No local parsing of untrusted images** — image bytes are forwarded to the
  gateway, so a crafted image can never reach a decoder in the consumer's
  process.
- The gateway enforces per-IP rate limits (tmn: 200/min, slip: 100/min) and
  rejects with `429` + `Retry-After` when exceeded.

## Non-security notes

- No process-exit concerns: no worker pools, no native handles. The package can
  be imported and dropped from memory at any time.
- No QR/image parsing ships in this package at all — all decoding and OCR
  happens inside the gateway.

## Revisit

- [ ] Re-check `npm audit` before each release (expected to stay at 0 findings
      while the tree stays at this single pure-JS dependency).