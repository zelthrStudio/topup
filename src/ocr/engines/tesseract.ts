import * as fs from 'node:fs';
import * as path from 'node:path';

const TESSERACT_TIMEOUT_MS = 30_000;
const TESSERACT_MAX_CONSECUTIVE_FAILURES = 3;
const TESSERACT_MAX_WORKERS = Number(
  process.env.TESSERACT_MAX_WORKERS ?? process.env.TESSERACT_WORKERS ?? 3
);

const DEBUG = process.env.TOPUP_DEBUG === '1';
function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log('[topup:tesseract]', ...args);
}

export class TesseractTimeoutError extends Error {}

// Prefer a local eng.traineddata next to the package root (offline, no CDN);
// fall back to the tesseract.js CDN when the file is missing.
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const LOCAL_LANG_DIR = [path.join(PACKAGE_ROOT, 'assets'), PACKAGE_ROOT].find((dir) =>
  fs.existsSync(path.join(dir, 'eng.traineddata'))
);

interface TesseractWorker {
  recognize(input: Buffer): Promise<{ data: { text: string } }>;
  setParameters(params: Record<string, unknown>): Promise<void>;
  terminate(): Promise<void>;
}

interface TesseractModule {
  createWorker(
    langs?: string,
    oem?: number,
    options?: { langPath?: string; gzip?: boolean }
  ): Promise<TesseractWorker>;
}

let tesseractModulePromise: Promise<TesseractModule> | null = null;

function getTesseractModule(): Promise<TesseractModule> {
  if (!tesseractModulePromise) {
    tesseractModulePromise = import('tesseract.js')
      .catch((error) => {
        tesseractModulePromise = null;
        throw error;
      })
      .then((mod) => mod as unknown as TesseractModule);
  }
  return tesseractModulePromise;
}

async function spawnTesseractWorker(): Promise<TesseractWorker> {
  const { createWorker } = await getTesseractModule();
  const worker = await createWorker(
    'eng',
    undefined,
    LOCAL_LANG_DIR ? { langPath: LOCAL_LANG_DIR, gzip: false } : undefined
  );
  await worker.setParameters({ tessedit_char_whitelist: '0123456789,.' });
  return worker;
}

const tesseractWorkers = new Set<TesseractWorker>();
const tesseractIdle: TesseractWorker[] = [];
const tesseractWaiters: Array<{
  resolve: (worker: TesseractWorker) => void;
  reject: (err: Error) => void;
}> = [];
const tesseractWorkerFailures = new WeakMap<TesseractWorker, number>();
let tesseractSpawning = 0;
let tesseractBootstrapPromise: Promise<void> | null = null;
let tesseractShuttingDown = false;

function ensureTesseractPool(): Promise<void> {
  if (!tesseractBootstrapPromise) {
    tesseractBootstrapPromise = (async () => {
      const worker = await spawnTesseractWorker();
      tesseractWorkers.add(worker);
      tesseractIdle.push(worker);
    })().catch((error) => {
      tesseractBootstrapPromise = null;
      throw error;
    });
  }
  return tesseractBootstrapPromise;
}

async function acquireTesseractWorker(): Promise<TesseractWorker> {
  await ensureTesseractPool();
  const idleWorker = tesseractIdle.pop();
  if (idleWorker) return idleWorker;
  if (tesseractWorkers.size + tesseractSpawning < TESSERACT_MAX_WORKERS) {
    tesseractSpawning += 1;
    try {
      const worker = await spawnTesseractWorker();
      tesseractWorkers.add(worker);
      return worker;
    } finally {
      tesseractSpawning -= 1;
    }
  }
  return new Promise<TesseractWorker>((resolve, reject) => tesseractWaiters.push({ resolve, reject }));
}

function releaseTesseractWorker(worker: TesseractWorker): void {
  const waiter = tesseractWaiters.shift();
  if (waiter) waiter.resolve(worker);
  else tesseractIdle.push(worker);
}

function recognizeWithTimeout(worker: TesseractWorker, buf: Buffer): Promise<{ data: { text: string } }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TesseractTimeoutError(`Tesseract recognize timed out after ${TESSERACT_TIMEOUT_MS} ms`)),
      TESSERACT_TIMEOUT_MS
    );
  });
  return Promise.race([worker.recognize(buf), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function runTesseractOCR(buf: Buffer): Promise<string> {
  let worker: TesseractWorker | null = null;
  try {
    worker = await acquireTesseractWorker();
    const { data } = await recognizeWithTimeout(worker, buf);
    tesseractWorkerFailures.delete(worker);
    releaseTesseractWorker(worker);
    worker = null;
    return data.text;
  } catch (err) {
    debugLog('recognize failed:', err);
    if (worker) {
      const failures = (tesseractWorkerFailures.get(worker) ?? 0) + 1;
      const isTimeout = err instanceof TesseractTimeoutError;
      if (isTimeout || failures >= TESSERACT_MAX_CONSECUTIVE_FAILURES) {
        tesseractWorkerFailures.delete(worker);
        tesseractWorkers.delete(worker);
        try {
          await worker.terminate();
        } catch {
          // worker already gone
        }
        worker = null;
        void spawnTesseractWorker()
          .then((replacement) => {
            // Don't resurrect workers if the pool was torn down while we were
            // spawning a replacement.
            if (tesseractShuttingDown) {
              void replacement.terminate().catch(() => {});
              return;
            }
            tesseractWorkers.add(replacement);
            releaseTesseractWorker(replacement);
          })
          .catch((error) => {
            debugLog('worker replacement failed:', error);
          });
      } else {
        tesseractWorkerFailures.set(worker, failures);
        releaseTesseractWorker(worker);
      }
      worker = null;
    }
    return '';
  }
}

/** Warm up the worker pool so the first call is fast (lazy, no-op if idle). */
export function warmupTesseract(): Promise<void> {
  return ensureTesseractPool();
}

/** Shut down the worker pool; call on app shutdown / test teardown. */
export async function terminateTesseractPool(): Promise<void> {
  tesseractShuttingDown = true;
  const workers = Array.from(tesseractWorkers);
  tesseractWorkers.clear();
  tesseractIdle.length = 0;
  // Callers queued for a worker must not hang forever: reject them so their
  // awaits settle instead of being silently discarded.
  const waiters = tesseractWaiters.splice(0);
  tesseractWaiters.length = 0;
  for (const waiter of waiters) {
    waiter.reject(new Error('tesseract: worker pool shut down'));
  }
  tesseractSpawning = 0;
  tesseractBootstrapPromise = null;
  tesseractModulePromise = null;
  await Promise.allSettled(workers.map((worker) => worker.terminate()));
  tesseractShuttingDown = false;
}