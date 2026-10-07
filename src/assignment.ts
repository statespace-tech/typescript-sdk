// Stable assignment and eligibility, identical in every Statespace SDK.

import { createHash } from 'node:crypto';
import { parse } from '@marcbachmann/cel-js';
import type { JsonObject } from './errors.js';

export interface Parameter {
  kind: 'value' | 'function';
  value?: unknown;
  sha256?: string;
}

export interface GroupConfig {
  name: string;
  ranges: Array<[number, number]>;
  parameters: Record<string, Parameter>;
}

/**
 * Map a subject to a uniform point in [0, 1). The first 64 bits of
 * SHA-256(salt:subject_id) keep 53 bits, which a double holds exactly.
 */
export function bucket(salt: string, subjectId: string): number {
  const digest = createHash('sha256').update(`${salt}:${subjectId}`).digest();
  return Number(digest.readBigUInt64BE(0) >> 11n) / 2 ** 53;
}

/** The group whose ranges contain `point`, or control. */
export function choose(groups: GroupConfig[], point: number): GroupConfig {
  const match = groups.find((group) =>
    group.ranges.some(([start, end]) => start <= point && point < end),
  );
  const control = groups.find((group) => group.name === 'control');
  const chosen = match ?? control;
  if (chosen === undefined)
    throw new Error('the configuration has no control group');
  return chosen;
}

/** A CEL expression over `context`, compiled once per configuration. */
export class Eligibility {
  readonly #program: ((context: JsonObject) => unknown) | undefined;

  public constructor(expression: string | null) {
    this.#program = expression === null ? undefined : parse(expression);
  }

  /** Whether the context is eligible. Throws if evaluation fails. */
  public evaluate(context: JsonObject): boolean {
    return this.#program === undefined || this.#program({ context }) === true;
  }
}
