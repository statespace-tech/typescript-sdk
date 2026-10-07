import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { WASIShim } from '@bytecodealliance/preview2-shim/instantiation';

import {
  capModuleMemory,
  installImportedMemoryLimit,
  memoryLimitPages,
} from './memory.js';

interface Task {
  path: string;
  input: string;
}

async function run(task: Task): Promise<unknown> {
  const pages = memoryLimitPages();
  installImportedMemoryLimit(pages);
  const bindings = await import(pathToFileURL(task.path).href);
  const getCoreModule = async (path: string): Promise<WebAssembly.Module> => {
    if (path.includes('/') || path.includes('\\') || path === '..') {
      throw new Error('invalid core module path');
    }
    return WebAssembly.compile(
      capModuleMemory(await readFile(join(dirname(task.path), path)), pages),
    );
  };
  const wasi = new WASIShim({
    sandbox: { preopens: {}, env: {}, args: [], enableNetwork: false },
  });
  const imports: Record<string, unknown> = wasi.getImportObject();
  imports['wasi:cli/environment'] = {
    getEnvironment: () => [],
    getArguments: () => [],
    initialCwd: () => undefined,
  };
  const instance = await bindings.instantiate(getCoreModule, imports);
  if (typeof instance.execute !== 'function')
    throw new Error('component has no execute export');
  const output: unknown = await instance.execute(task.input);
  if (typeof output !== 'string')
    throw new Error('component returned a non-string value');
  return JSON.parse(output);
}

void run(workerData as Task).then(
  (value) => parentPort?.postMessage({ value }),
  (error: unknown) => parentPort?.postMessage({ error: String(error) }),
);
