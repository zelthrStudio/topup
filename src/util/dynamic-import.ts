export const dynamicImport = new Function('m', 'return import(m)') as (
  m: string
) => Promise<Record<string, any>>;