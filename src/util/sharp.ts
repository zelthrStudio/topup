import { dynamicImport } from './dynamic-import';

// sharp is a native (libvips) Node-only dependency. Loading it statically
// would (a) slow every consumer's module load with native addon setup and
// (b) break browser/edge bundles that import this package (e.g. for
// getQrCodePromptPay). It is therefore loaded lazily on first use through a
// real dynamic import() that bundlers cannot see, so bundling never pulls
// sharp into the graph. Server runtimes resolve the import at call time.
//
// sharp's types use `export =` (a CJS function with statics), so the module
// namespace IS the callable factory. Node's CJS-ESM interop additionally
// exposes it as the namespace `default` — hence the `default ?? mod` fallback.
export type SharpModule = typeof import('sharp');
export type SharpInstance = import('sharp').Sharp;
export type SharpFactory = SharpModule;

let sharpPromise: Promise<SharpModule> | null = null;

export function getSharp(): Promise<SharpModule> {
  if (!sharpPromise) {
    // A rejected import is not cached: a transient failure (WASM init OOM,
    // disk hiccup, antivirus lock) must not permanently brick image
    // processing until the process restarts — the next call retries.
    sharpPromise = (dynamicImport('sharp') as Promise<SharpModule>).catch((error) => {
      sharpPromise = null;
      throw error;
    });
  }
  return sharpPromise;
}

/** The sharp callable factory (module.exports, exposed as `default` by Node
 *  CJS-ESM interop). */
export async function sharpFactory(): Promise<SharpFactory> {
  const mod = await getSharp();
  return ((mod as { default?: SharpFactory }).default ?? mod) as SharpFactory;
}