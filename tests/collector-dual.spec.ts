/**
 * Dual-path backfill tests (rc.1 inspect vs alpha open+read).
 * RED step: these fail before collector supports the alpha handle seam.
 */
import { describe, expect, it } from 'vitest';
import { UsageCollector } from '../src/collector.ts';
import type { UsageSessionPersistence } from '../src/context-types.ts';

const T = new Date(2026, 7, 2, 12).getTime();

function memoryStore() {
  const recorded: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const marked: string[][] = [];
  return {
    recorded, marked,
    seenSessions: async () => new Set(seen),
    liveSequences: async () => new Map<string, number>(),
    markSeenSessions: async (ids: Iterable<string>) => { const a=[...ids]; marked.push(a); for (const id of a) seen.add(id); },
    markLiveSequences: async () => {},
    count: async () => recorded.length,
    record: async (s: Record<string, unknown>) => { recorded.push(s); },
  } as unknown as ConstructorParameters<typeof UsageCollector>[1] & { recorded: Array<Record<string, unknown>>; marked: string[][] };
}

const fiveEvents = [
  { type: 'step/start', seq: 0, time: T, data: { turn: 1, step: 1 } },
  { type: 'assistant/message', seq: 1, time: T, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 }, message: { source: { provider: 'p', model: 'm1' } } } },
  { type: 'turn/end', seq: 2, time: T, data: { turn: 1, reason: { kind: 'completed' } } },
];

function alphaPersistence(events: unknown[], inherited = 0) {
  let closed = 0;
  const calls: unknown[] = [];
  return {
    closed: () => closed,
    calls,
    list: async (opts: unknown) => { calls.push(opts); return [{ header: { id: 'A1' }, revision: 'r1' }]; },
    open: async (id: string, access: string, opts: unknown) => {
      calls.push(['open', id, access, opts]);
      return {
        id, header: { id }, inheritedEventCount: inherited, access,
        read: async (offset = 0, length = 500) => ({ events: (events as unknown[]).slice(offset, offset + length), eventState: 'owned' }),
        close: async () => { closed++; },
      };
    },
  } as unknown as UsageSessionPersistence & { closed: () => number; calls: unknown[] };
}

describe('dual-path backfill: alpha handle seam', () => {
  it('replays snapshots via open+read and closes the handle', async () => {
    const store = memoryStore();
    const c = new UsageCollector({ on: () => {} } as never, store as never);
    const p = alphaPersistence(fiveEvents);
    await c.backfill(p as unknown as UsageSessionPersistence, { list: () => [] } as never);
    expect(store.recorded.length).toBe(3);
    expect(p.closed()).toBe(1);
    expect(store.marked).toEqual([['A1']]);
  });

  it('paginates long logs and skips the inherited prefix from the handle', async () => {
    const store = memoryStore();
    const c = new UsageCollector({ on: () => {} } as never, store as never);
    const p = alphaPersistence(fiveEvents, 2);
    // tiny pages force multiple read() calls; first two events are inherited
    const origOpen = (p as unknown as { open: Function }).open;
    (p as unknown as Record<string, unknown>).open = async (id: string, access: string) => {
      const h = await (origOpen as Function)(id, access);
      const inner = h as { read: Function };
      const first = inner.read.bind(h);
      inner.read = (off = 0) => first(off, 1);
      return h;
    };
    await c.backfill(p as unknown as UsageSessionPersistence, { list: () => [] } as never);
    // seq 0..1 skipped (inherited cut 2), only turn/end remains
    expect(store.recorded.length).toBe(1);
    expect(store.recorded[0]).toMatchObject({ turn: true });
  });

  it('passes abort via options object on the alpha path', async () => {
    const store = memoryStore();
    const c = new UsageCollector({ on: () => {} } as never, store as never);
    const p = alphaPersistence(fiveEvents);
    const controller = new AbortController();
    controller.abort();
    await c.backfill(p as unknown as UsageSessionPersistence, { list: () => [] } as never, controller.signal);
    expect(store.recorded.length).toBe(0);
  });

  it('keeps the rc.1 inspect path working (no open present)', async () => {
    const store = memoryStore();
    const c = new UsageCollector({ on: () => {} } as never, store as never);
    const legacy = {
      list: async () => [{ id: 'L1' }],
      inspect: async () => ({ meta: { id: 'L1' }, events: fiveEvents, inheritedEventCount: 0 }),
    } as unknown as UsageSessionPersistence;
    await c.backfill(legacy, { list: () => [] } as never);
    expect(store.recorded.length).toBe(3);
  });
});
