// Experiments, assignments, and the parameter values a group receives.

import { randomUUID } from 'node:crypto';
import {
  bucket,
  choose,
  type GroupConfig,
  type Parameter,
} from './assignment.js';
import type { Client, Config } from './client.js';
import {
  FunctionTimeout,
  type JsonObject,
  type JsonValue,
  PermanentError,
} from './errors.js';

/** The outcome recorded when a parameter falls back to the application's default. */
export const ERROR_OUTCOME = 'statespace.error';
const DEFAULT_TIMEOUT_MILLISECONDS = 5_000;

export interface AssignOptions {
  /** The JSON the experiment's eligibility rule reads. */
  context?: JsonObject;
}

export interface FunctionOptions {
  /** The time limit for one call. Defaults to 5000. */
  timeoutMs?: number;
}

/** One experiment. Get one with `experiment(name)`. */
export class Experiment {
  public readonly name: string;
  readonly #client: Client;
  #config: Config | undefined;

  private constructor(
    client: Client,
    name: string,
    config: Config | undefined,
  ) {
    this.name = name;
    this.#client = client;
    this.#config = config;
  }

  /** @internal */
  public static async load(client: Client, name: string): Promise<Experiment> {
    if (name.length === 0)
      throw new RangeError('experiment name must not be empty');
    try {
      return new Experiment(client, name, await client.load(name));
    } catch (error) {
      if (error instanceof PermanentError) throw error;
      console.warn(
        `statespace: serving defaults for ${name}: ${String(error)}`,
      );
      return new Experiment(client, name, undefined);
    }
  }

  /** @internal Keep serving the last configuration when a refresh fails. */
  public async refresh(): Promise<void> {
    try {
      this.#config = await this.#client.load(this.name);
    } catch (error) {
      console.warn(
        `statespace: could not refresh ${this.name}: ${String(error)}`,
      );
    }
  }

  /**
   * Assign a subject to a group and record the assignment. The same subject
   * always gets the same group. While the experiment is not running, or for
   * ineligible subjects, the group has no parameters, so every read returns
   * the application's default.
   */
  public assign(subjectId: string, options: AssignOptions = {}): Group {
    if (subjectId.length === 0)
      throw new RangeError('subjectId must not be empty');
    const context = structuredClone(options.context ?? {});
    const config = this.#config;
    if (config === undefined || config.status !== 'running') {
      return new Group(this, subjectId, null, {});
    }
    if (Date.now() - config.fetchedAt > config.staleAfter) {
      console.warn(
        `statespace: the ${this.name} configuration is stale; serving defaults`,
      );
      return new Group(this, subjectId, null, {});
    }
    let reason: 'assigned' | 'ineligible' | 'eligibility-error';
    try {
      reason = config.eligibility.evaluate(context) ? 'assigned' : 'ineligible';
    } catch (error) {
      console.warn(
        `statespace: eligibility failed for ${this.name}: ${String(error)}`,
      );
      reason = 'eligibility-error';
    }
    const assigned: GroupConfig | undefined =
      reason === 'assigned'
        ? choose(config.groups, bucket(config.salt, subjectId))
        : undefined;
    this.#client.enqueue('run', {
      id: `run_${randomUUID().replaceAll('-', '')}`,
      experiment: config.name,
      version: config.version,
      subject_id: subjectId,
      group: assigned?.name ?? null,
      reason,
      context,
      timestamp: new Date().toISOString(),
    });
    return new Group(
      this,
      subjectId,
      assigned?.name ?? null,
      assigned?.parameters ?? {},
    );
  }

  /**
   * Record an outcome, such as a click or a purchase, for a subject. Outcomes
   * can come from any process; results count each one for the group the
   * subject was assigned to before it.
   */
  public log(subjectId: string, name: string, data: JsonObject = {}): void {
    if (subjectId.length === 0 || name.length === 0) {
      throw new RangeError('subjectId and name must not be empty');
    }
    this.#client.enqueue('outcome', {
      id: `out_${randomUUID().replaceAll('-', '')}`,
      experiment: this.name,
      subject_id: subjectId,
      name,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  /** @internal */
  public execute(
    sha256: string,
    input: JsonValue,
    timeoutMs: number,
  ): Promise<JsonValue> {
    return this.#client.execute(sha256, input, timeoutMs);
  }
}

/**
 * The group a subject was assigned to. `name` is the group's name,
 * `"control"`, or `null` when the subject is not in the experiment. Every read
 * takes the application's default, which is returned for control, for
 * parameters the group does not set, and when a value has the wrong type or
 * a function fails.
 */
export class Group {
  public readonly name: string | null;
  readonly #experiment: Experiment;
  readonly #subjectId: string;
  readonly #parameters: Record<string, Parameter>;

  /** @internal */
  public constructor(
    experiment: Experiment,
    subjectId: string,
    name: string | null,
    parameters: Record<string, Parameter>,
  ) {
    this.name = name;
    this.#experiment = experiment;
    this.#subjectId = subjectId;
    this.#parameters = parameters;
  }

  /** The group's value for `name`, or `fallback`. */
  public value<T>(name: string, fallback: T): T {
    const parameter = this.#parameters[name];
    if (parameter === undefined) return fallback;
    if (parameter.kind !== 'value') {
      this.#error(name, 'type', 'is a function; read it with function()');
      return fallback;
    }
    if (!matches(parameter.value, fallback)) {
      this.#error(name, 'type', `is not a ${kind(fallback)}`);
      return fallback;
    }
    return parameter.value as T;
  }

  /**
   * The group's function for `name`, or `fallback`. The function takes and
   * returns JSON values, runs locally in a sandbox, and falls back to
   * `fallback` if it fails. Calls always return a promise.
   */
  public function<I extends JsonValue, O extends JsonValue>(
    name: string,
    fallback: (input: I) => O | Promise<O>,
    options: FunctionOptions = {},
  ): (input: I) => Promise<O> {
    const parameter = this.#parameters[name];
    if (parameter === undefined) return async (input) => fallback(input);
    if (parameter.kind !== 'function' || parameter.sha256 === undefined) {
      this.#error(name, 'type', 'is a value; read it with value()');
      return async (input) => fallback(input);
    }
    const sha256 = parameter.sha256;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MILLISECONDS;
    return async (input) => {
      const started = performance.now();
      try {
        return (await this.#experiment.execute(sha256, input, timeoutMs)) as O;
      } catch (error) {
        const failure = error instanceof FunctionTimeout ? 'timeout' : 'failed';
        this.#error(name, failure, String(error), performance.now() - started);
        return fallback(input);
      }
    };
  }

  #error(
    parameter: string,
    error: string,
    detail: string,
    durationMs?: number,
  ): void {
    console.warn(
      `statespace: ${parameter} in ${this.name}: ${error} ${detail}`,
    );
    this.#experiment.log(this.#subjectId, ERROR_OUTCOME, {
      group: this.name,
      parameter,
      error,
      ...(durationMs === undefined
        ? {}
        : { duration_ms: Math.round(durationMs * 1000) / 1000 }),
    });
  }
}

function kind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Whether a JSON value can stand in for the fallback's type. */
function matches(value: unknown, fallback: unknown): boolean {
  return (
    fallback === null ||
    fallback === undefined ||
    kind(value) === kind(fallback)
  );
}
