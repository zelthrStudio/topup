# Security Audit — @zelthr/topup

**Date:** 2026-08-15
**Scope:** dependency tree of `@zelthr/topup@1.0.0` as installed from the published tarball.
**Commands:** `npm audit`, `npm audit --omit=dev`, `npm ls sharp onnxruntime-node adm-zip`.

## Result

| Finding | Source | Runtime-reachable? | Mitigated? | Status |
| --- | --- | --- | --- | --- |
| `adm-zip <0.6.0` zip bomb (GHSA-xcpc-8h2w-3j85) | `onnxruntime-node` ≥1.22 | **No** — adm-zip is used only in `script/install-utils.js` (install-time unpacking); never called at runtime | — | **Resolved** by pinning `onnxruntime-node` to `1.21.1` (direct dependency, deduped for consumers; no `adm-zip` in tree) |
| `sharp <0.35.0` → libvips CVEs CVE-2026-33327/33328/35590/35591 (GHSA-f88m-g3jw-g9cj) | `@gutenye/ocr-node` (nested `sharp@0.33.5`) | Partially — the affected loaders are **GIF/TIFF/VIPS** decoders | **Mitigated at runtime** — see below | Tree-level finding; no patched sharp inside guten's `^0.33.3` range |

## Assessment details

### 1. libvips CVEs via `sharp@0.33.5` (High, CVSS 7.0)

- The four CVEs are in libvips' **GIF, TIFF and VIPS** decoders (per the advisory workaround:
  block `VipsForeignLoadNsgif`, `VipsForeignLoadTiff`, `VipsForeignLoadVips`).
- **Runtime mitigation (implemented):** every image entry point (`bank()` and
  `getSlipAmount()`) now sniffs magic bytes via `src/util/image-format.ts` and rejects
  anything that is not **JPEG/PNG/WebP** *before* libvips/sharp is asked to decode.
  A crafted GIF/TIFF/VIPS never reaches the vulnerable decoders, regardless of which
  sharp copy ends up in a consumer's tree. JPEG/PNG/WebP are not part of this advisory.
- **Why the tree still shows it:** `@gutenye/ocr-node` requires `sharp ^0.33.3`, and npm
  does not propagate `overrides` from a dependency to the consumer's tree. A patched
  `sharp 0.35.x` cannot satisfy that range, so the nested copy remains.
- **Consumer hardening (optional, for strict audit policies):** a consumer can add a
  root-level override for a fully clean `npm audit`:
  ```json
  "overrides": { "@gutenye/ocr-node": { "sharp": "0.35.3" } }
  ```
  ⚠️ This loads two libvips versions in one process (0.35 + 0.33 nested) and triggers
  GLib warnings / can degrade Guten OCR. Prefer relying on the format allowlist instead.

### 2. `adm-zip` (High)

- `onnxruntime-node` ≥1.22 depends on `adm-zip <0.6.0`, which has a zip-bomb advisory.
- **Not runtime-reachable:** adm-zip appears only in `script/install-utils.js` — the
  npm *install* script. It is never `require()`d by any runtime OCR path, and the
  zip-bomb requires feeding a crafted zip to adm-zip (a supply-chain concern, not an
  application-input concern).
- **Action taken:** pinned `onnxruntime-node` to the exact `1.21.1` build (direct
  dependency). Consumers dedupe to it, removing `adm-zip` from the tree entirely
  (`npm audit --omit=dev` → 0 findings in a clean consumer install). `1.21.1` is the
  version this package is tested against.

## Non-security findings from the release hardening

- **Process exit:** local OCR spawns a tesseract worker pool that keeps the Node event
  loop alive. Consumers must call `terminateAmountExtractor()` on app shutdown (tests
  and the CI smoke test do this). Documented in README.

## Revisit

- [ ] Re-check `npm audit` before the next release; expected triggers for re-review:
  - a `sharp` release in the `0.33.x` line patching libvips, or a new `@gutenye/ocr-node`
    widening `sharp` to `^0.35` (then bump the direct dep and drop the format note),
  - an `onnxruntime-node` release that drops `adm-zip` (then unpin or bump `1.21.1`).
- [ ] File a tracking issue against `@gutenye/ocr-node` requesting a `sharp ^0.35`
      update once upstream publishes it.