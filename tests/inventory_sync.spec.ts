import { describe, expect, it } from 'vitest'
import { createInventoryTracker } from '../src/inventory'
import {
  createInventorySync,
  INVENTORY_INITIAL_BACKOFF_MS,
  MIN_SEND_INTERVAL_MS,
} from '../src/inventory_sync'
import { createInventorySender, type FetchLike } from '../src/sender'
import { BOAT_DELTAS, SALT, sourceDelta, sourcesTree } from './helpers/inventory'
import { SELF, T0 } from './helpers/runtime'

type Step = { status: number; body?: unknown; headers?: Record<string, string> } | Error

function setup(script: Step[] = [{ status: 201, body: { created: 1, updated: 0, gone: 0 } }]) {
  const clock = { now: T0 }
  const calls: Array<{ url: string; init: RequestInit; body: { devices: unknown[] } }> = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) })
    const step = script.length > 1 ? script.shift()! : script[0]!
    if (step instanceof Error) throw step
    return new Response(step.body === undefined ? null : JSON.stringify(step.body), {
      status: step.status,
      headers: { 'content-type': 'application/json', ...(step.headers ?? {}) },
    })
  }
  const tracker = createInventoryTracker({
    selfContext: SELF,
    hideSerialNumbers: false,
    salt: SALT,
    readSources: () => sourcesTree(),
  })
  const logs: string[] = []
  const sync = createInventorySync({
    tracker,
    sender: createInventorySender({
      endpoint: 'http://fleetai.test/api/instruments/inventory',
      token: 'fai_ing_test',
      userAgent: 'signalk-fleetai/test',
      fetch,
    }),
    log: { debug: (m) => void logs.push(m), error: (m) => void logs.push(`ERROR ${m}`) },
    now: () => clock.now,
  })
  return { clock, calls, tracker, sync, logs }
}

describe('inventory sync — when it is sent', () => {
  it('sends nothing while no device is known', async () => {
    const { sync, calls } = setup()
    expect(await sync.run()).toEqual({ kind: 'idle' })
    expect(calls).toHaveLength(0)
  })

  it('sends the full state with the token as soon as devices are known', async () => {
    const { sync, calls, tracker, clock } = setup()
    for (const delta of BOAT_DELTAS) tracker.observeDelta(delta, clock.now)

    expect(await sync.run()).toEqual({ kind: 'sent', created: 1, updated: 0, gone: 0 })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('http://fleetai.test/api/instruments/inventory')
    expect(call.init.method).toBe('POST')
    expect(call.init.headers).toMatchObject({
      Authorization: 'Bearer fai_ing_test',
      'Content-Type': 'application/json',
      'User-Agent': 'signalk-fleetai/test',
    })
    expect(call.init.redirect).toBe('manual')
    expect(Object.keys(call.body)).toEqual(['devices'])
    expect(call.body.devices).toHaveLength(4)
  })

  it('does not resend an unchanged inventory, however often it is asked', async () => {
    const { sync, calls, tracker, clock } = setup()
    tracker.observeDelta(BOAT_DELTAS[0]!, clock.now)
    await sync.run()
    for (let i = 0; i < 5; i += 1) {
      clock.now += MIN_SEND_INTERVAL_MS
      tracker.observeDelta(BOAT_DELTAS[0]!, clock.now)
      expect(await sync.run()).toEqual({ kind: 'idle' })
    }
    expect(calls).toHaveLength(1)
  })

  it('sends at most once a minute: a change inside the minute waits for the minute', async () => {
    const { sync, calls, tracker, clock } = setup()
    tracker.observeDelta(BOAT_DELTAS[0]!, clock.now)
    await sync.run()

    clock.now += 10_000
    tracker.observeDelta(BOAT_DELTAS[1]!, clock.now) // a new device
    expect(await sync.run()).toEqual({ kind: 'idle' })
    clock.now += 40_000
    tracker.observeDelta(
      sourceDelta('can0.34', { 'electrical.batteries.house.current': 3 }),
      clock.now
    ) // a new path
    expect(await sync.run()).toEqual({ kind: 'idle' })
    expect(calls).toHaveLength(1)

    clock.now += 10_000 // 60 s after the first attempt
    expect((await sync.run()).kind).toBe('sent')
    expect(calls).toHaveLength(2)
    // Both changes travel together, as the complete state.
    expect(calls[1]!.body.devices).toHaveLength(2)
    expect(JSON.stringify(calls[1]!.body)).toContain('electrical.batteries.house.current')
  })

  it('announces a disappearance after ten minutes — and an empty list once everything is gone', async () => {
    const { sync, calls, tracker, clock } = setup()
    tracker.observeDelta(BOAT_DELTAS[0]!, clock.now)
    tracker.observeDelta(BOAT_DELTAS[1]!, clock.now)
    await sync.run()

    clock.now += 9 * 60_000
    tracker.observeDelta(BOAT_DELTAS[1]!, clock.now) // the battery keeps talking
    expect(await sync.run()).toEqual({ kind: 'idle' }) // engine silent for 9 min: still there

    clock.now += 2 * 60_000
    tracker.observeDelta(BOAT_DELTAS[1]!, clock.now)
    expect((await sync.run()).kind).toBe('sent')
    expect(calls.at(-1)!.body.devices).toHaveLength(1)

    clock.now += 11 * 60_000
    expect((await sync.run()).kind).toBe('sent')
    expect(calls.at(-1)!.body).toEqual({ devices: [] })
  })

  it('only one request at a time', async () => {
    const { sync, tracker, clock, calls } = setup()
    tracker.observeDelta(BOAT_DELTAS[0]!, clock.now)
    const [first, second] = await Promise.all([sync.run(), sync.run()])
    expect([first.kind, second.kind].sort()).toEqual(['idle', 'sent'])
    expect(calls).toHaveLength(1)
  })
})

describe('inventory sync — answers', () => {
  it('backs off on 5xx / network errors and resends the same state', async () => {
    const { sync, calls, tracker, clock, logs } = setup([
      { status: 503 },
      new Error('ECONNRESET'),
      { status: 201, body: { created: 4, updated: 0, gone: 0 } },
    ])
    tracker.observeDelta(BOAT_DELTAS[0]!, clock.now)

    expect(await sync.run()).toEqual({ kind: 'deferred', message: 'HTTP 503 http_503' })
    clock.now += INVENTORY_INITIAL_BACKOFF_MS - 1
    expect(await sync.run()).toEqual({ kind: 'idle' })
    clock.now += 1
    expect((await sync.run()).kind).toBe('deferred')
    clock.now += INVENTORY_INITIAL_BACKOFF_MS // the back-off doubled: too early
    expect(await sync.run()).toEqual({ kind: 'idle' })
    clock.now += INVENTORY_INITIAL_BACKOFF_MS
    expect((await sync.run()).kind).toBe('sent')
    expect(calls).toHaveLength(3)
    expect(calls[2]!.body).toEqual(calls[0]!.body)
    expect(logs.some((line) => line.startsWith('ERROR'))).toBe(false)
  })

  it('honours Retry-After on 429', async () => {
    const { sync, calls, tracker, clock } = setup([
      { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '180' } },
      { status: 201, body: {} },
    ])
    tracker.observeDelta(BOAT_DELTAS[0]!, clock.now)
    expect((await sync.run()).kind).toBe('deferred')
    clock.now += 179_000
    expect(await sync.run()).toEqual({ kind: 'idle' })
    clock.now += 1000
    expect((await sync.run()).kind).toBe('sent')
    expect(calls).toHaveLength(2)
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'plan_not_allowed'],
    [404, 'source_not_found'],
    [409, 'source_disabled'],
  ])('%i %s is fatal and reported to the caller', async (status, error) => {
    const { sync, tracker, clock } = setup([{ status, body: { error } }])
    tracker.observeDelta(BOAT_DELTAS[0]!, clock.now)
    const result = await sync.run()
    expect(result).toMatchObject({ kind: 'fatal', outcome: { status, error } })
  })

  it('stays off for the session after a fatal answer (reported once)', async () => {
    const { sync, calls, tracker, clock } = setup([
      { status: 404, body: { error: 'source_not_found' } },
    ])
    tracker.observeDelta(BOAT_DELTAS[0]!, clock.now)
    expect((await sync.run()).kind).toBe('fatal')
    clock.now += 10 * MIN_SEND_INTERVAL_MS
    tracker.observeDelta(BOAT_DELTAS[1]!, clock.now)
    expect(await sync.run()).toEqual({ kind: 'idle' })
    expect(calls).toHaveLength(1)
  })

  it('a refused inventory (422) is logged without its content and not resent until it changes', async () => {
    const { sync, calls, tracker, clock, logs } = setup([
      { status: 422, body: { error: 'validation_failed', messages: [{ message: 'bad' }] } },
      { status: 201, body: {} },
    ])
    tracker.observeDelta(BOAT_DELTAS[0]!, clock.now)
    expect((await sync.run()).kind).toBe('refused')
    const error = logs.find((line) => line.startsWith('ERROR'))!
    expect(error).toContain('validation_failed')
    expect(error).not.toContain('SN-0042') // serial numbers never reach the log

    clock.now += 5 * MIN_SEND_INTERVAL_MS
    expect(await sync.run()).toEqual({ kind: 'idle' })
    expect(calls).toHaveLength(1)

    tracker.observeDelta(BOAT_DELTAS[1]!, clock.now) // the list changes: one more try
    expect((await sync.run()).kind).toBe('sent')
    expect(calls).toHaveLength(2)
  })

  it('treats 200 like 201 and tolerates an empty body', async () => {
    const { sync, tracker, clock } = setup([{ status: 200 }])
    tracker.observeDelta(BOAT_DELTAS[0]!, clock.now)
    expect(await sync.run()).toEqual({ kind: 'sent', created: 0, updated: 0, gone: 0 })
  })
})
