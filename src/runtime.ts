// Transpile Statespace components with jco and run them in worker threads.
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { transpileBytes } from '@bytecodealliance/jco-transpile';
import { FunctionError, FunctionTimeout, type JsonValue } from './errors.js';

const modules = new Map<string, Promise<string>>();
const directories = new Set<string>();
process.once('exit', () => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});
const SUPPORTED_WASI_IMPORTS = new Set([
  'wasi:cli/environment',
  'wasi:cli/exit',
  'wasi:cli/stdin',
  'wasi:cli/stdout',
  'wasi:cli/stderr',
  'wasi:cli/terminal-input',
  'wasi:cli/terminal-output',
  'wasi:cli/terminal-stdin',
  'wasi:cli/terminal-stdout',
  'wasi:cli/terminal-stderr',
  'wasi:io/error',
  'wasi:io/poll',
  'wasi:io/streams',
  'wasi:clocks/monotonic-clock',
  'wasi:clocks/wall-clock',
  'wasi:random/random',
  'wasi:filesystem/types',
  'wasi:filesystem/preopens',
]);

async function modulePath(bytes: Uint8Array): Promise<string> {
  const hash = createHash('sha256').update(bytes).digest('hex');
  let pending = modules.get(hash);
  if (pending === undefined) {
    pending = (async () => {
      const result = await transpileBytes(bytes, {
        name: 'component',
        wasiShim: false,
        instantiation: 'async',
      });
      for (const name of result.imports) {
        if (!supportedWasiImport(name)) {
          throw new FunctionError(
            `component imports unsupported host capability: ${name}`,
          );
        }
      }
      const directory = await mkdtemp(join(tmpdir(), 'statespace-component-'));
      directories.add(directory);
      for (const [name, content] of Object.entries(result.files)) {
        if (name.endsWith('.d.ts')) continue;
        if (name.includes('/') || name.includes('\\') || name === '..') {
          throw new FunctionError('invalid transpiled component path');
        }
        await writeFile(join(directory, name), content);
      }
      const file = Object.keys(result.files).find((name) =>
        name.endsWith('.js'),
      );
      if (file === undefined)
        throw new FunctionError('component has no JavaScript binding');
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      return join(directory, file);
    })();
    modules.set(hash, pending);
    pending.catch(() => modules.delete(hash));
  }
  return pending;
}

function supportedWasiImport(name: string): boolean {
  return SUPPORTED_WASI_IMPORTS.has(name);
}

/**
 * Run a component's `execute` once in a worker thread, which is terminated
 * when the timeout elapses. The guest has no filesystem, network, or
 * environment access.
 */
export async function executeComponent(
  bytes: Uint8Array,
  inputs: JsonValue,
  timeout: number,
): Promise<JsonValue> {
  const started = performance.now();
  const path = await modulePath(bytes);
  const remaining = timeout - (performance.now() - started);
  if (remaining <= 0) {
    throw new FunctionTimeout('component exceeded its timeout');
  }
  return new Promise<JsonValue>((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { path, input: JSON.stringify(inputs) },
      execArgv: [],
      stdin: true,
      stdout: true,
      stderr: true,
    });
    worker.stdin?.end();
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (error?: Error, value?: JsonValue): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error !== undefined) reject(error);
      else resolve(value ?? null);
    };
    const timer = setTimeout(
      () => finish(new FunctionTimeout('component exceeded its timeout')),
      remaining,
    );
    worker.once('message', (message: { value?: JsonValue; error?: string }) => {
      if (message.error !== undefined) finish(new FunctionError(message.error));
      else finish(undefined, message.value);
    });
    worker.once('error', (error) => finish(new FunctionError(error.message)));
    worker.once('exit', (code) => {
      finish(new FunctionError(`component worker exited with code ${code}`));
    });
  });
}
