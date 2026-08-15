// Real dynamic import — keeps ESM-only packages (@gutenye/ocr-node,
// qr-scanner-wechat) loadable from this CommonJS build on Node >= 18.
// require(esm) would need Node 22.12+, so the import() call is constructed
// via new Function to stop TypeScript from transpiling it to require.
export const dynamicImport = new Function('m', 'return import(m)') as (
  m: string
) => Promise<Record<string, any>>;