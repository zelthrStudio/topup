'use strict';
// Generates dist/index.mjs — an ESM facade over the CommonJS build. The
// package is compiled once (CJS); the wrapper gives ESM consumers (Next.js,
// Vite, Node ESM) named imports with a single source of truth.
//
// The list below mirrors src/index.ts exports. Keep in sync when the public
// surface changes (the api-surface test asserts the runtime surface too).

const fs = require('node:fs');
const path = require('node:path');

const EXPORTS = [
  // clients
  'truemoney',
  'TMN_BASE',
  'bank',
  'SLIP_BASE',
  'post',
  // errors
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