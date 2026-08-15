/** QR domain facade — public parsers, decoder and their types. */
export { decodeQr } from './scan';
export { parseEmvco } from './parse';
export { verifyCrc, crc16ccitt } from './crc';
export type { DecodedAccount, DecodedQr } from './parse';
export type { EmvcoAccount, EmvcoQr } from './emvco';
export type { SlipCheckQr } from './slipcheck';
export { parseSlipCheck } from './slipcheck';