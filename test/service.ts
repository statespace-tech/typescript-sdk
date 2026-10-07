// A fake Statespace service for SDK tests.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const IDENTITY = readFileSync(
  new URL('./fixtures/identity.wasm', import.meta.url),
);
export const IDENTITY_SHA256 = createHash('sha256')
  .update(IDENTITY)
  .digest('hex');

type Json = Record<string, unknown>;

export class Service {
  public readonly experiments = new Map<string, Json>();
  public readonly runs: Json[] = [];
  public readonly outcomes: Json[] = [];
  public endpoint = '';
  #server: Server | undefined;

  public publish(
    name: string,
    status: string,
    groups: Record<string, [number[][], Json]>,
  ): void {
    this.experiments.set(name, {
      name,
      version: 1,
      status,
      eligibility: 'context.country == "US"',
      salt: 'salt',
      groups: [
        { name: 'control', ranges: [], parameters: {} },
        ...Object.entries(groups).map(([group, [ranges, parameters]]) => ({
          name: group,
          ranges,
          parameters,
        })),
      ],
      stale_after_seconds: 172800,
    });
  }

  public async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const name = decodeURIComponent(request.url?.split('/').pop() ?? '');
        if (request.method === 'POST') {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            runs: Json[];
            outcomes: Json[];
          };
          this.runs.push(...body.runs);
          this.outcomes.push(...body.outcomes);
          response.writeHead(202).end('{"accepted":1}');
        } else if (
          request.url?.startsWith('/v1/runtime/experiments/') &&
          this.experiments.has(name)
        ) {
          response
            .writeHead(200)
            .end(JSON.stringify(this.experiments.get(name)));
        } else if (request.url === `/v1/runtime/artifacts/${IDENTITY_SHA256}`) {
          response
            .writeHead(200, { 'Content-Type': 'application/wasm' })
            .end(IDENTITY);
        } else {
          response.writeHead(404).end('{"error":"not found"}');
        }
      });
    });
    await new Promise<void>((resolve) =>
      this.#server?.listen(0, '127.0.0.1', resolve),
    );
    this.endpoint = `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => this.#server?.close(() => resolve()));
  }
}
