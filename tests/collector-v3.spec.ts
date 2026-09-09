/**
 * V3 log compatibility tests (DSH 0.1.5-alpha.1, SESSION_FORMAT_VERSION 3).
 *
 * The collector only reads type/seq/time plus, for three event types,
 * turn/step/usage/source/provider/model. Everything V3 adds -
 * system/message events, assistant/attempt events, the stream +
 * surfaceOp envelope fields, request/context.systemPromptUpdate - must be
 * ignored without changing the fold. Each test replays a control log and a
 * V3-shaped variant through the alpha (open) seam and requires identical
 * store records. No production change was needed for these to pass; they pin
 * the compatibility contract so a future host change fails loud here first.
 */
import { describe, expect, it } from 'vitest';
import { UsageCollector } from '../src/collector.ts';
import type { UsageSessionPersistence } from '../src/context-types.ts';

const T = new Date(2026, 7, 2, 12).getTime();

type Store = ConstructorParameters<typeof UsageCollector>[1] & {
  recorded: Array<Record<string, unknown>>;
};

function memoryStore(): Store {
  const recorded: Array<Record<string, unknown>> = [];
  return {
    recorded,
    seenSessions: async () => new Set<string>(),
    liveSequences: async () => new Map<string, number>(),
    markSeenSessions: async () => {},
    markLiveSequences: async () => {},
    count: async () => recorded.length,
    record: async (s: Record<string, unknown>) => { recorded.push(s); },
  } as unknown as Store;
}

function alphaPersistence(events: unknown[]) {
  let closed = 0;
  return {
    closed: () => closed,
    list: async () => [{ header: { id: 'V3' }, revision: 'r1' }],
    open: async (id: string, access: string) => ({
      id,
      header: { id },
      inheritedEventCount: 0,
      access,
      read: async (offset = 0, length = 500) => ({
        events: (events as unknown[]).slice(offset, offset + length),
        eventState: 'owned',
      }),
      close: async () => { closed++; },
    }),
  } as unknown as UsageSessionPersistence & { closed: () => number };
}

async function replay(events: unknown[]): Promise<Array<Record<string, unknown>>> {
  const store = memoryStore();
  const c = new UsageCollector({ on: () => {} } as never, store as never);
  const p = alphaPersistence(events);
  await c.backfill(p as unknown as UsageSessionPersistence, { list: () => [] } as never);
  expect(p.closed()).toBe(1);
  return store.recorded;
}

const controlLog = [
  { type: 'step/start', seq: 0, time: T, data: { turn: 1, step: 1 } },
  { type: 'request/context', seq: 1, time: T, data: { provider: 'p', model: 'm1' } },
  {
    type: 'assistant/message', seq: 2, time: T,
    data: {
      turn: 1, step: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
      message: { source: { provider: 'p', model: 'm1' } },
    },
  },
  { type: 'turn/end', seq: 3, time: T, data: { turn: 1, reason: { kind: 'completed' } } },
];

describe('V3 log compatibility', () => {
  it('ignores V3-only event types (system/message, assistant/attempt)', async () => {
    const variant = [
      controlLog[0],
      {
        type: 'system/message', seq: 1, time: T,
        data: { turn: 1, step: 1, message: { role: 'system', content: 'sys', source: { kind: 'plugin', plugin: 'p' } } },
      },
      { type: 'request/context', seq: 2, time: T, data: { provider: 'p', model: 'm1' } },
      { type: 'assistant/attempt', seq: 3, time: T, data: { turn: 1, step: 1, stream: [] } },
      {
        type: 'assistant/message', seq: 4, time: T,
        data: {
          turn: 1, step: 1,
          usage: { inputTokens: 10, outputTokens: 5 },
          message: { source: { provider: 'p', model: 'm1' } },
        },
      },
      { type: 'turn/end', seq: 5, time: T, data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    const control = await replay(controlLog);
    const v3 = await replay(variant);
    expect(control.length).toBeGreaterThan(0);
    expect(v3).toEqual(control);
  });

  it('backfills through open+read with no inspect property on the seam', async () => {
    const store = memoryStore();
    const c = new UsageCollector({ on: () => {} } as never, store as never);
    const p = alphaPersistence(controlLog);
    expect('inspect' in (p as object)).toBe(false);
    await c.backfill(p as unknown as UsageSessionPersistence, { list: () => [] } as never);
    expect(p.closed()).toBe(1);
    expect(store.recorded.length).toBeGreaterThan(0);
  });

  it('ignores V3 envelope extras (stream, surfaceOp, systemPromptUpdate)', async () => {
    const variant = [
      controlLog[0],
      {
        type: 'request/context', seq: 1, time: T,
        data: { provider: 'p', model: 'm1', systemPromptUpdate: 'in-history' },
      },
      {
        type: 'assistant/message', seq: 2, time: T,
        surfaceOp: 'append',
        data: {
          turn: 1, step: 1,
          usage: { inputTokens: 10, outputTokens: 5 },
          stream: [{ type: 'chunk', time: T, chunk: { type: 'usage' } }],
          message: { source: { provider: 'p', model: 'm1' } },
        },
      },
      controlLog[3],
    ];
    const control = await replay(controlLog);
    expect(await replay(variant)).toEqual(control);
  });
});
