// Real dynamic import — keeps the ESM-only package (@zelthr/request) loadable
// from this CommonJS build on Node >= 20.
// require(esm) would need Node 22.12+, so the import() call is constructed
// via new Function to stop TypeScript from transpiling it to require.
export const dynamicImport = new Function('m', 'return import(m)') as (
  m: string
) => Promise<Record<string, any>>;