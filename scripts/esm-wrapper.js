'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXPORTS = [
  'truemoney',
  'TMN_BASE',
  'bank',
  'SLIP_BASE',
  'post',
  'TopupError',
  'ValidationError',
  'TimeoutError',
  'HttpError',
  'AmountMismatchError',
  'AmountVerificationError',
];

const lines = [
  "import cjs from './index.js'",
  'export default cjs',
  ...EXPORTS.map((name) => `export const ${name} = cjs.${name}`),
  '',
];

const out = path.join(__dirname, '..', 'dist', 'index.mjs');
fs.writeFileSync(out, lines.join('\n'));
console.log(`esm-wrapper: wrote ${path.relative(process.cwd(), out)} (${EXPORTS.length} named exports)`);