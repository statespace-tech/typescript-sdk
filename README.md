# Statespace for TypeScript

[![CI](https://github.com/statespace-tech/typescript-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/statespace-tech/typescript-sdk/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-007ec6?style=flat-square)](LICENSE)
[![npm](https://img.shields.io/npm/v/@statespace-tech/sdk?style=flat-square)](https://www.npmjs.com/package/@statespace-tech/sdk)

Run Statespace A/B tests on functions and values in Node.js applications. Each subject is
assigned to a group, reads that group's parameters, and falls back to your current code
everywhere else.

## Install

Install the SDK with npm. It requires Node.js 20 or later.

```shell
npm install @statespace-tech/sdk
```

Set an API key from `ssp key create --preset runtime`. Locally, the SDK uses your `ssp login` session.

```shell
export SSP_API_KEY=ssp_key_...
```

## Quickstart

Get an experiment once and keep it. The SDK refreshes its configuration in the background.

```typescript
import { experiment } from '@statespace-tech/sdk';

const ranking = await experiment('ranking');
```

Assign a subject. The same subject always gets the same group.

```typescript
const group = ranking.assign('user-42', { context: { country: 'US' } });
```

Read a value. The second argument is your current value, which control receives.

```typescript
const topK = group.value('top_k', 20);
```

Read a function. It runs in a sandboxed worker and falls back to your function if it fails.

```typescript
const rank = group.function('ranker', rerank);
const results = (await rank(items)).slice(0, topK);
```

Log outcomes for the subject, from this process or any other.

```typescript
ranking.log('user-42', 'click', { position: 3 });
```

Compare groups from the command line.

```shell
ssp experiment results ranking --outcome click
```

## Groups

`group.name` is the group's name, `'control'`, or `null` when the subject is not in the experiment.

```typescript
if (group.name !== null) console.log(`user-42 is in ${group.name}`);
```

A value must have the JSON type of its default. Otherwise you get the default, and the
SDK records a `statespace.error` outcome.

```typescript
const temperature = group.value('temperature', 0.7);
const prompt = group.value('prompt', DEFAULT_PROMPT);
```

A function takes one JSON value and returns one. Calls always return a promise.

```typescript
const score = group.function('scorer', scoreDefault, { timeoutMs: 50 });
await score({ query, items });
```

## Delivery

Events are sent in the background in batches. Flush before a short-lived process exits.

```typescript
import { flush } from '@statespace-tech/sdk';

await flush();
```

Use a client directly to configure credentials in code.

```typescript
import { Client } from '@statespace-tech/sdk';

const client = new Client({ apiKey: 'ssp_key_...' });
const ranking = await client.experiment('ranking');
```

## Guarantees

- Reads never throw because of Statespace. They return the default and log a warning.
  Only `experiment()` rejects, for an unknown experiment or an invalid key.
- Assignment is computed locally from a cached configuration, with no network call.
- Functions run in worker threads without file, network, or environment access, with 256
  MiB of memory by default (`STATESPACE_MAX_MEMORY_BYTES`).
- Python, TypeScript, and Go assign every subject to the same group.

## License

Apache-2.0
