import { describe, expect, it } from 'vitest'
import { createRuntime } from '../src/runtime'
import { createSender } from '../src/sender'
import { aisDelta, harness, scriptedFetch, selfDelta, SELF, T0 } from './helpers/runtime'

const MIN = 60_000

describe('runtime — windows to batches', () => {
  it('sends one value per path per window, recordedAt at window start, and splits at 500', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: { accepted: 1, ignored: 0 } }])
    const h = harness({ fetch })

    for (let i = 0; i < 600; i++)
      h.runtime.handleDelta(selfDelta(`electrical.batteries.b${i}.voltage`, 12 + i))
    h.runtime.handleDelta(selfDelta('navigation.speedOverGround', 2))
    h.clock.now = T0 + 30_000
    h.runtime.handleDelta(selfDelta('navigation.speedOverGround', 4))
    h.runtime.handleDelta(
      aisDelta('244630000', [
        { path: 'navigation.position', value: { latitude: 43, longitude: 5 } },
        { path: 'name', value: 'X' },
      ])
    )

    await h.runtime.tick() // T0+30s: nothing closed yet
    expect(calls).toHaveLength(0)

    h.clock.now = T0 + MIN
    await h.runtime.tick()
    expect(calls.map((c) => c.body.samples.length)).toEqual([500, 101])
    const all = calls.flatMap(
      (c) =>
        c.body.samples as Array<{
          path: string
          recordedAt: string
          value?: number
          valueJson?: unknown
        }>
    )
    expect(all.find((s) => s.path === 'navigation.speedOverGround')).toEqual({
      path: 'navigation.speedOverGround',
      recordedAt: '2026-10-25T10:00:00.000Z',
      value: 3,
    })
    expect(all.find((s) => s.path === 'ais.244630000')).toBeUndefined() // AIS: one sighting per 5-minute window

    h.clock.now = T0 + 5 * MIN
    await h.runtime.tick()
    expect(calls).toHaveLength(3)
    expect(calls[2]!.body.samples).toEqual([
      {
        path: 'ais.244630000',
        recordedAt: '2026-10-25T10:00:00.000Z',
        valueJson: {
          name: 'X',
          latitude: 43,
          longitude: 5,
          sogMs: null,
          cogRad: null,
          shipType: null,
          shipTypeName: null,
          cpaM: null,
          tcpaS: null,
        },
      },
    ])
    expect(new Set(calls.map((c) => c.body.batchId)).size).toBe(3)
    expect(calls.every((c) => /^[0-9a-f-]{36}$/.test(c.body.batchId))).toBe(true)
    expect(h.runtime.state().queued).toBe(0)
    expect(h.statuses.at(-1)).toMatch(/^Last batch accepted just now$/)
  })

  it('an unknown path is never sent, the extra allow-list is', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200 }])
    const h = harness({ fetch, config: { paths: ['steering.rudderAngle'] } })
    h.runtime.handleDelta(selfDelta('design.length', 12))
    h.runtime.handleDelta(selfDelta('steering.rudderAngle', 0.2))
    h.runtime.handleDelta(selfDelta('ais.123456789', { latitude: 1, longitude: 1 }))
    h.clock.now = T0 + MIN
    await h.runtime.tick()
    expect(calls[0]!.body.samples).toEqual([
      { path: 'steering.rudderAngle', recordedAt: '2026-10-25T10:00:00.000Z', value: 0.2 },
    ])
  })
})

describe('runtime — replay and backoff', () => {
  it('replays the same batch (same batchId, same samples) after a 503, in order, with exponential backoff capped at 5 min', async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 200 },
    ])
    const h = harness({ fetch })

    h.runtime.handleDelta(selfDelta('navigation.headingTrue', 100))
    h.clock.now = T0 + MIN
    await h.runtime.tick()
    expect(calls).toHaveLength(1)
    expect(h.runtime.state()).toMatchObject({
      queued: 1,
      nextAttemptAtMs: T0 + MIN + 5_000,
      backoffMs: 10_000,
    })
    expect(h.statuses.at(-1)).toMatch(/^Waiting for network \(1 batch queued\)/)

    // Too early: no new attempt, but the next window is queued behind.
    h.runtime.handleDelta(selfDelta('navigation.headingTrue', 200))
    h.clock.now = T0 + MIN + 2_000
    await h.runtime.tick()
    expect(calls).toHaveLength(1)

    h.clock.now = T0 + 2 * MIN
    await h.runtime.tick()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body).toEqual(calls[0]!.body)
    expect(h.runtime.state().queued).toBe(2)
    expect(h.statuses.at(-1)).toMatch(/Waiting for network \(2 batches queued\)/)

    h.clock.now = T0 + 3 * MIN
    await h.runtime.tick() // third failure → backoff 40 s
    h.clock.now = T0 + 4 * MIN
    await h.runtime.tick() // success on the head, then the second batch drains immediately
    expect(calls).toHaveLength(5)
    expect(calls[3]!.body.batchId).toBe(calls[0]!.body.batchId)
    expect(calls[4]!.body.samples).toEqual([
      { path: 'navigation.headingTrue', recordedAt: '2026-10-25T10:01:00.000Z', value: 200 },
    ])
    expect(h.runtime.state()).toMatchObject({ queued: 0, backoffMs: 5_000, nextAttemptAtMs: null })
  })

  it('backoff doubles up to the 5-minute cap', async () => {
    const { fetch } = scriptedFetch([new TypeError('fetch failed')])
    const h = harness({ fetch })
    h.runtime.handleDelta(selfDelta('navigation.headingTrue', 1))
    const expected = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]
    for (const delay of expected) {
      h.clock.now = (h.runtime.state().nextAttemptAtMs ?? T0) + MIN
      await h.runtime.tick()
      expect(h.runtime.state().nextAttemptAtMs).toBe(h.clock.now + delay)
    }
  })

  it('429 waits exactly Retry-After', async () => {
    const { fetch } = scriptedFetch([
      {
        status: 429,
        body: { error: 'rate_limited', retryAfter: 90 },
        headers: { 'retry-after': '90' },
      },
      { status: 200 },
    ])
    const h = harness({ fetch })
    h.runtime.handleDelta(selfDelta('navigation.headingTrue', 1))
    h.clock.now = T0 + MIN
    await h.runtime.tick()
    expect(h.runtime.state().nextAttemptAtMs).toBe(T0 + MIN + 90_000)
  })

  it('401 / 403 / 409 stop the plugin with an explicit error and keep the queue on disk', async () => {
    for (const [status, error, headline] of [
      [401, 'unauthorized', 'Token rejected'],
      [403, 'plan_not_allowed', 'Stopped'],
      [409, 'source_disabled', 'Stopped'],
    ] as const) {
      const { fetch, calls } = scriptedFetch([{ status, body: { error } }])
      const h = harness({ fetch })
      h.runtime.handleDelta(selfDelta('navigation.headingTrue', 1))
      h.clock.now = T0 + MIN
      await h.runtime.tick()
      expect(calls).toHaveLength(1)
      expect(h.errors).toHaveLength(1)
      expect(h.errors[0]).toMatch(new RegExp(`^${headline}`))
      expect(h.fatal).toHaveLength(1)
      expect(h.runtime.state()).toMatchObject({ fatal: true, queued: 1 })

      // No loop: further ticks and deltas do nothing.
      h.runtime.handleDelta(selfDelta('navigation.headingTrue', 2))
      h.clock.now = T0 + 10 * MIN
      await h.runtime.tick()
      expect(calls).toHaveLength(1)
      expect(h.statuses.filter((s) => s.startsWith('Last batch'))).toHaveLength(0)
    }
  })

  it('422 logs the batch, abandons it, and stops sending the refused path', async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 422, body: { error: 'path_not_allowed', path: 'navigation.headingTrue' } },
      { status: 200 },
    ])
    const h = harness({ fetch })
    h.runtime.handleDelta(selfDelta('navigation.headingTrue', 1))
    h.runtime.handleDelta(selfDelta('navigation.speedOverGround', 1))
    h.clock.now = T0 + MIN
    await h.runtime.tick()
    expect(calls).toHaveLength(1)
    expect(h.runtime.state()).toMatchObject({
      queued: 0,
      fatal: false,
      rejectedPaths: ['navigation.headingTrue'],
    })
    expect(h.logs.find((l) => l.includes('abandoned'))).toContain('"navigation.headingTrue"')

    h.runtime.handleDelta(selfDelta('navigation.headingTrue', 2))
    h.runtime.handleDelta(selfDelta('navigation.speedOverGround', 2))
    h.clock.now = T0 + 2 * MIN
    await h.runtime.tick()
    expect(calls[1]!.body.samples.map((s) => (s as { path: string }).path)).toEqual([
      'navigation.speedOverGround',
    ])
  })
})

describe('runtime — persistence across restarts', () => {
  it('a batch queued while offline is sent by the next run, before new ones', async () => {
    const offline = scriptedFetch([new TypeError('fetch failed')])
    const first = harness({ fetch: offline.fetch })
    first.runtime.handleDelta(selfDelta('navigation.headingTrue', 1))
    first.clock.now = T0 + MIN
    await first.runtime.tick()
    first.runtime.handleDelta(selfDelta('navigation.headingTrue', 2))
    first.runtime.stop() // force-closes the open window, no network
    expect(first.runtime.state().queued).toBe(2)
    expect(offline.calls).toHaveLength(1)

    const online = scriptedFetch([{ status: 200 }])
    const second = harness({ fetch: online.fetch, queueFilePath: first.queueFilePath })
    expect(second.runtime.state().queued).toBe(2)
    second.runtime.handleDelta(selfDelta('navigation.headingTrue', 3))
    second.clock.now = T0 + 3 * MIN
    await second.runtime.tick()
    expect(online.calls.map((c) => (c.body.samples[0] as { value: number }).value)).toEqual([
      1, 2, 3,
    ])
    expect(online.calls[0]!.body.batchId).toBe(offline.calls[0]!.body.batchId)
  })

  it('the queue is bounded: the oldest batches are dropped', async () => {
    const { fetch } = scriptedFetch([new TypeError('fetch failed')])
    const h = harness({ fetch, runtime: { maxQueuedBatches: 3 } })
    for (let i = 1; i <= 5; i++) {
      h.runtime.handleDelta(selfDelta('navigation.headingTrue', i))
      h.clock.now = T0 + i * MIN
      await h.runtime.tick()
    }
    expect(h.runtime.state()).toMatchObject({ queued: 3, dropped: 2 })
  })

  it('a second tick while a send is in flight does not send twice', async () => {
    let release: (() => void) | null = null
    const calls: unknown[] = []
    const sender = createSender({
      endpoint: 'http://x',
      token: 'fai_ing_x',
      fetch: (_url, init) => {
        calls.push(init.body)
        return new Promise((resolve) => {
          release = () => resolve(new Response('{"accepted":1,"ignored":0}', { status: 200 }))
        })
      },
    })
    const clock = { now: T0 }
    const runtime = createRuntime({
      config: { endpoint: 'http://x', token: 'fai_ing_x', periodSeconds: 60, paths: [] },
      selfContext: SELF,
      queueFilePath: `${harness({ fetch: scriptedFetch([{ status: 200 }]).fetch }).queueFilePath}.b`,
      sender,
      log: { debug: () => {}, error: () => {} },
      status: { setStatus: () => {}, setError: () => {} },
      now: () => clock.now,
    })
    runtime.handleDelta(selfDelta('navigation.headingTrue', 1))
    clock.now = T0 + MIN
    const first = runtime.tick()
    const second = runtime.tick()
    expect(calls).toHaveLength(1)
    release!()
    await Promise.all([first, second])
    expect(runtime.state().queued).toBe(0)
  })
})
