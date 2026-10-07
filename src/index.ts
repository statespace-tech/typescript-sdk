/**
 * Run Statespace experiments on parameter values and functions.
 *
 * ```ts
 * import { experiment } from '@statespace-tech/sdk';
 *
 * const ranking = await experiment('ranking');
 * const group = ranking.assign('u_42', { context: { country: 'US' } });
 * const rank = group.function('ranker', rerank);
 * const topK = group.value('top_k', 20);
 * ranking.log('u_42', 'click');
 * ```
 */

import { Client } from './client.js';
import type { Experiment } from './experiment.js';

export { Client, type ClientOptions } from './client.js';
export { type JsonObject, type JsonValue, StatespaceError } from './errors.js';
export {
  type AssignOptions,
  ERROR_OUTCOME,
  Experiment,
  type FunctionOptions,
  Group,
} from './experiment.js';

let defaultClient: Client | undefined;

function client(): Client {
  defaultClient ??= new Client();
  return defaultClient;
}

/**
 * The experiment `name` from the default client, which reads `SSP_API_KEY`
 * and `STATESPACE_URL`, or the session saved by `ssp login`. Handles are
 * cached, so call this anywhere.
 */
export function experiment(name: string): Promise<Experiment> {
  return client().experiment(name);
}

/** Wait until queued events are delivered. Resolves to false on timeout or loss. */
export function flush(timeoutMs?: number): Promise<boolean> {
  return client().flush(timeoutMs);
}
