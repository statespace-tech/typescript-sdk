/** Limit each guest linear memory before native WebAssembly compilation. */
export function memoryLimitPages(): number {
  const raw = process.env.STATESPACE_MAX_MEMORY_BYTES;
  const bytes = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(bytes) && bytes >= 65536
    ? Math.min(65536, Math.floor(bytes / 65536))
    : 4096;
}

export function capModuleMemory(
  bytes: Uint8Array,
  pages: number,
): Uint8Array<ArrayBuffer> {
  let offset = 8;
  const read = (): number => {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error('truncated Wasm module');
      value += (byte & 127) * 2 ** (7 * index);
      if ((byte & 128) === 0) {
        if (value > 0xffffffff) throw new Error('invalid Wasm integer');
        return value;
      }
    }
    throw new Error('invalid Wasm integer');
  };
  const encode = (value: number): number[] => {
    const result: number[] = [];
    do {
      const byte = value % 128;
      value = Math.floor(value / 128);
      result.push(byte | (value > 0 ? 128 : 0));
    } while (value > 0);
    return result;
  };
  const chunks: Uint8Array[] = [bytes.slice(0, 8)];
  while (offset < bytes.length) {
    const start = offset;
    const id = bytes[offset++];
    const size = read();
    const end = offset + size;
    if (end > bytes.length) throw new Error('truncated Wasm section');
    if (id === 5) {
      const count = read();
      const payload = encode(count);
      for (let index = 0; index < count; index += 1) {
        const flags = read();
        if (flags !== 0 && flags !== 1)
          throw new Error('unsupported Wasm memory type');
        const minimum = read();
        const maximum = flags === 1 ? read() : pages;
        if (minimum > pages)
          throw new Error('Wasm memory exceeds configured limit');
        payload.push(
          1,
          ...encode(minimum),
          ...encode(Math.min(maximum, pages)),
        );
      }
      if (offset !== end) throw new Error('invalid Wasm memory section');
      chunks.push(Uint8Array.from([5, ...encode(payload.length), ...payload]));
    } else {
      offset = end;
      chunks.push(bytes.slice(start, end));
    }
  }
  const result = new Uint8Array(
    chunks.reduce((size, chunk) => size + chunk.length, 0),
  );
  let destination = 0;
  for (const chunk of chunks) {
    result.set(chunk, destination);
    destination += chunk.length;
  }
  return result;
}

export function installImportedMemoryLimit(pages: number): void {
  const OriginalMemory = WebAssembly.Memory;
  WebAssembly.Memory = class extends OriginalMemory {
    constructor(descriptor: WebAssembly.MemoryDescriptor) {
      if (descriptor.initial > pages)
        throw new Error('Wasm memory exceeds configured limit');
      super({
        ...descriptor,
        maximum: Math.min(descriptor.maximum ?? pages, pages),
      });
    }
  };
}
