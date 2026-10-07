// The Statespace client: configuration, experiments, and event delivery.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { Eligibility, type GroupConfig } from './assignment.js';
import {
  type JsonObject,
  type JsonValue,
  PermanentError,
  StatespaceError,
} from './errors.js';
import { Experiment } from './experiment.js';
import { executeComponent } from './runtime.js';

const DEFAULT_ENDPOINT = 'https://api.statespace.com';
const USER_AGENT = 'statespace-typescript/0.1.1';
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_BATCH = 100;
const MAX_QUEUED = 10_000;
const REFRESH_MILLISECONDS = 60_000;

export interface ClientOptions {
  /** Defaults to `SSP_API_KEY`, then the session saved by `ssp login`. */
  apiKey?: string;
  /** Defaults to `STATESPACE_URL`, then the saved session's endpoint. */
  endpoint?: string;
}

/** @internal A published version as the SDK reads it. */
export interface Config {
  name: string;
  version: number;
  status: string;
  salt: string;
  groups: GroupConfig[];
  eligibility: Eligibility;
  staleAfter: number;
  fetchedAt: number;
}

interface QueuedEvent {
  kind: 'run' | 'outcome';
  event: JsonObject;
}

/**
 * Connects an application to Statespace. A client keeps one handle per
 * experiment, refreshes configurations in the background, and delivers
 * events in batches. Call `flush()` before a short-lived process exits.
 */
export class Client {
  readonly #key: string;
  readonly #endpoint: string;
  readonly #experiments = new Map<string, Promise<Experiment>>();
  readonly #artifacts = new Map<string, Promise<Uint8Array>>();
  readonly #queue: QueuedEvent[] = [];
  readonly #timers: Array<ReturnType<typeof setInterval>>;
  #delivery: Promise<void> | undefined;
  #dropped = 0;

  public constructor(options: ClientOptions = {}) {
    const saved = savedLogin();
    const key = options.apiKey ?? process.env.SSP_API_KEY ?? saved.token;
    if (key === undefined || key.length === 0) {
      throw new StatespaceError('set SSP_API_KEY or run `ssp login`');
    }
    this.#key = key;
    this.#endpoint = (
      options.endpoint ??
      process.env.STATESPACE_URL ??
      saved.endpoint ??
      DEFAULT_ENDPOINT
    ).replace(/\/$/, '');
    this.#timers = [
      setInterval(() => void this.#deliver(), 1_000),
      setInterval(() => void this.#refresh(), REFRESH_MILLISECONDS),
    ];
    for (const timer of this.#timers) timer.unref();
  }

  /** Return the handle for one experiment, loading it on first use. */
  public experiment(name: string): Promise<Experiment> {
    let experiment = this.#experiments.get(name);
    if (experiment === undefined) {
      experiment = Experiment.load(this, name);
      this.#experiments.set(name, experiment);
      experiment.catch(() => this.#experiments.delete(name));
    }
    return experiment;
  }

  /**
   * Wait until queued events are delivered. Resolves to false on timeout or
   * if any event was dropped since the last flush.
   */
  public async flush(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.#queue.length > 0 || this.#delivery !== undefined) {
      if (Date.now() >= deadline) return false;
      await (this.#delivery ?? this.#deliver());
    }
    const dropped = this.#dropped;
    this.#dropped = 0;
    return dropped === 0;
  }

  /** Flush events and stop background work. */
  public async close(): Promise<void> {
    for (const timer of this.#timers) clearInterval(timer);
    await this.flush();
  }

  /** @internal */
  public async load(name: string): Promise<Config> {
    const raw = (await this.#json(
      `/v1/runtime/experiments/${encodeURIComponent(name)}`,
    )) as {
      name: string;
      version: number;
      status: string;
      salt: string;
      eligibility: string | null;
      groups: GroupConfig[];
      stale_after_seconds?: number;
    };
    const config: Config = {
      name: raw.name,
      version: raw.version,
      status: raw.status,
      salt: raw.salt,
      groups: raw.groups,
      eligibility: new Eligibility(raw.eligibility),
      staleAfter: (raw.stale_after_seconds ?? 48 * 3600) * 1_000,
      fetchedAt: Date.now(),
    };
    await Promise.all(
      raw.groups.flatMap((group) =>
        Object.values(group.parameters)
          .filter((parameter) => parameter.kind === 'function')
          .map((parameter) => this.#artifact(parameter.sha256 ?? '')),
      ),
    );
    return config;
  }

  /** @internal */
  public async execute(
    sha256: string,
    input: JsonValue,
    timeoutMs: number,
  ): Promise<JsonValue> {
    return executeComponent(await this.#artifact(sha256), input, timeoutMs);
  }

  /** @internal Queue an event without ever blocking or failing the caller. */
  public enqueue(kind: 'run' | 'outcome', event: JsonObject): void {
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) {
      throw new RangeError('an event must serialize to at most 64 KiB');
    }
    if (this.#queue.length >= MAX_QUEUED) {
      console.warn(`statespace: the event queue is full; dropping a ${kind}`);
      this.#dropped += 1;
      return;
    }
    this.#queue.push({ kind, event });
    if (this.#queue.length >= MAX_BATCH) void this.#deliver();
  }

  #artifact(sha256: string): Promise<Uint8Array> {
    let artifact = this.#artifacts.get(sha256);
    if (artifact === undefined) {
      artifact = this.#request(`/v1/runtime/artifacts/${sha256}`, {
        timeoutMs: 60_000,
      }).then(async (response) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        const actual = createHash('sha256').update(bytes).digest('hex');
        if (actual !== sha256) {
          throw new StatespaceError(
            `component ${sha256} does not match its hash`,
          );
        }
        return bytes;
      });
      this.#artifacts.set(sha256, artifact);
      artifact.catch(() => this.#artifacts.delete(sha256));
    }
    return artifact;
  }

  async #refresh(): Promise<void> {
    for (const pending of this.#experiments.values()) {
      const experiment = await pending.catch(() => undefined);
      await experiment?.refresh();
    }
  }

  #deliver(): Promise<void> {
    this.#delivery ??= this.#send().finally(() => {
      this.#delivery = undefined;
    });
    return this.#delivery;
  }

  async #send(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, MAX_BATCH);
      const body = {
        runs: batch
          .filter((item) => item.kind === 'run')
          .map((item) => item.event),
        outcomes: batch
          .filter((item) => item.kind === 'outcome')
          .map((item) => item.event),
      };
      if (!(await this.#post(body))) this.#dropped += batch.length;
    }
  }

  /** Send one batch, retrying transient failures. */
  async #post(body: {
    runs: JsonObject[];
    outcomes: JsonObject[];
  }): Promise<boolean> {
    let delay = 500;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await this.#request('/v1/events', { method: 'POST', body });
        return true;
      } catch (error) {
        if (error instanceof PermanentError) {
          console.error(`statespace: events rejected: ${error.message}`);
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, delay).unref());
        delay = Math.min(delay * 2, 8_000);
      }
    }
    console.error('statespace: could not deliver events');
    return false;
  }

  async #json(path: string): Promise<unknown> {
    return (await this.#request(path)).json();
  }

  async #request(
    path: string,
    options: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<Response> {
    const method = options.method ?? 'GET';
    let response: Response;
    try {
      response = await fetch(`${this.#endpoint}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#key}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new StatespaceError(`${method} ${path} failed: ${String(error)}`);
    }
    if (!response.ok) {
      const message = `${method} ${path} returned HTTP ${response.status}`;
      const permanent =
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429;
      throw permanent
        ? new PermanentError(message)
        : new StatespaceError(message);
    }
    return response;
  }
}

/** Read the session saved by `ssp login`. */
function savedLogin(): { token?: string; endpoint?: string } {
  const base =
    platform() === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : platform() === 'win32'
        ? (process.env.APPDATA ?? '')
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  const path =
    process.env.STATESPACE_CONFIG ?? join(base, 'statespace', 'config.toml');
  try {
    const contents = readFileSync(path, 'utf8');
    const read = (key: string) =>
      new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, 'm').exec(contents)?.[1];
    const token = read('token');
    const endpoint = read('endpoint');
    return {
      ...(token === undefined ? {} : { token }),
      ...(endpoint === undefined ? {} : { endpoint }),
    };
  } catch {
    return {};
  }
}
