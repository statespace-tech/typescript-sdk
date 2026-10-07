import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { bucket, choose } from '../dist/assignment.js';
import { Client } from '../dist/index.js';
import { IDENTITY_SHA256, Service } from './service.js';

const US = { country: 'US' };
const TREATED = 'u_1'; // bucket 0.18, inside [0, 0.5)
const CONTROL = 'u_2'; // bucket 0.65

let service: Service;
let client: Client;

function publishRanking(status = 'running'): void {
  service.publish('ranking', status, {
    bm25: [
      [[0, 0.5]],
      {
        top_k: { kind: 'value', value: 50 },
        label: { kind: 'value', value: 'bm25' },
        ranker: { kind: 'function', sha256: IDENTITY_SHA256 },
      },
    ],
  });
}

beforeEach(async () => {
  service = new Service();
  await service.start();
  client = new Client({ apiKey: 'ssp_test', endpoint: service.endpoint });
});

afterEach(async () => {
  await client.close();
  await service.stop();
});

describe('assignment', () => {
  // Every SDK asserts these values, so a subject lands in the same group in
  // Python, TypeScript, and Go.
  test.each([
    ['salt', 'u_1', 0.18452190011276326],
    ['salt', 'u_2', 0.6489778519534802],
    ['3f9a', 'user-42', 0.19165740483602034],
  ])('bucket(%s, %s)', (salt, subject, expected) => {
    expect(bucket(salt, subject)).toBe(expected);
  });

  test('chooses the group covering the bucket', () => {
    const groups = [
      { name: 'control', ranges: [], parameters: {} },
      {
        name: 'bm25',
        ranges: [[0, 0.2]] as Array<[number, number]>,
        parameters: {},
      },
    ];
    expect(choose(groups, 0.1).name).toBe('bm25');
    expect(choose(groups, 0.5).name).toBe('control');
  });
});

describe('experiments', () => {
  test('groups return their values and control returns defaults', async () => {
    publishRanking();
    const ranking = await client.experiment('ranking');

    const treated = ranking.assign(TREATED, { context: US });
    expect(treated.name).toBe('bm25');
    expect(treated.value('top_k', 10)).toBe(50);
    expect(treated.value('missing', 'default')).toBe('default');
    expect(await treated.function('ranker', () => [])([3, 1, 2])).toEqual([
      3, 1, 2,
    ]);

    const control = ranking.assign(CONTROL, { context: US });
    expect(control.name).toBe('control');
    expect(control.value('top_k', 10)).toBe(10);
    const sort = (items: number[]) => [...items].sort();
    expect(await control.function('ranker', sort)([3, 1, 2])).toEqual([
      1, 2, 3,
    ]);

    expect(await client.flush()).toBe(true);
    expect(service.runs.map((run) => [run.subject_id, run.group])).toEqual([
      [TREATED, 'bm25'],
      [CONTROL, 'control'],
    ]);
  });

  test('wrong types fall back and are recorded', async () => {
    publishRanking();
    const group = (await client.experiment('ranking')).assign(TREATED, {
      context: US,
    });
    expect(group.value('top_k', 'ten')).toBe('ten');
    expect(group.value('ranker', 0)).toBe(0);
    expect(
      await group.function('top_k', (items: number[]) => items.length)([1]),
    ).toBe(1);
    expect(await client.flush()).toBe(true);
    expect(service.outcomes.map((outcome) => outcome.name)).toEqual([
      'statespace.error',
      'statespace.error',
      'statespace.error',
    ]);
  });

  test('ineligible and stopped experiments serve defaults', async () => {
    publishRanking();
    const outside = (await client.experiment('ranking')).assign(TREATED, {
      context: { country: 'CA' },
    });
    expect(outside.name).toBeNull();
    expect(outside.value('top_k', 10)).toBe(10);

    service.publish('stopped', 'stopped', {});
    expect(
      (await client.experiment('stopped')).assign(TREATED).name,
    ).toBeNull();
    expect(await client.flush()).toBe(true);
    expect(service.runs.map((run) => run.reason)).toEqual(['ineligible']);
  });

  test('outcomes need no assignment in the same process', async () => {
    publishRanking();
    (await client.experiment('ranking')).log('u_9', 'purchase', {
      value: 12.5,
    });
    expect(await client.flush()).toBe(true);
    expect(service.outcomes[0]).toMatchObject({
      subject_id: 'u_9',
      data: { value: 12.5 },
    });
  });
});
