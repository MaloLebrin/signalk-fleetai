import { describe, expect, it } from 'vitest'
import { createSender } from '../src/sender'
import { scriptedFetch } from './helpers/runtime'

const batch = {
  batchId: '11111111-1111-4111-8111-111111111111',
  samples: [{ path: 'navigation.log', recordedAt: '2026-10-25T10:00:00.000Z', value: 1 }],
}

function sender(fetch: ReturnType<typeof scriptedFetch>['fetch']) {
  return createSender({
    endpoint: 'http://fleetai.test/api/instruments/ingest',
    token: 'fai_ing_abc',
    fetch,
    userAgent: 'signalk-fleetai/test',
  })
}

describe('sender — request shape', () => {
  it('posts JSON with the bearer token, batchId and samples, never sourceId', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: { accepted: 1, ignored: 0 } }])
    const outcome = await sender(fetch).send(batch)
    expect(outcome).toEqual({ kind: 'accepted', accepted: 1, ignored: 0 })
    const call = calls[0]!
    expect(call.url).toBe('http://fleetai.test/api/instruments/ingest')
    expect(call.init.method).toBe('POST')
    const headers = call.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer fai_ing_abc')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['User-Agent']).toBe('signalk-fleetai/test')
    expect(call.body).toEqual(batch)
    expect('sourceId' in call.body).toBe(false)
  })
})

describe('sender — one outcome per HTTP answer', () => {
  it.each([
    [200, { accepted: 0, ignored: 1 }, 'accepted'],
    [401, { error: 'unauthorized' }, 'fatal'],
    [403, { error: 'plan_not_allowed' }, 'fatal'],
    [404, { error: 'source_not_found' }, 'fatal'],
    [409, { error: 'source_disabled' }, 'fatal'],
    [413, { error: 'batch_too_large', max: 500 }, 'drop'],
    [422, { error: 'validation_failed' }, 'drop'],
    [429, { error: 'rate_limited', retryAfter: 7 }, 'retry'],
    [500, undefined, 'retry'],
    [502, 'not json', 'retry'],
    [302, undefined, 'retry'],
  ] as const)('HTTP %s → %s', async (status, body, kind) => {
    const { fetch } = scriptedFetch([{ status, body }])
    const outcome = await sender(fetch).send(batch)
    expect(outcome.kind).toBe(kind)
  })

  it('401 explains the token, 422 path_not_allowed names the path', async () => {
    const unauthorized = await sender(
      scriptedFetch([{ status: 401, body: { error: 'unauthorized' } }]).fetch
    ).send(batch)
    expect(unauthorized).toMatchObject({ kind: 'fatal', status: 401, error: 'unauthorized' })
    expect((unauthorized as { message: string }).message).toMatch(/Token rejected/)

    const refused = await sender(
      scriptedFetch([{ status: 422, body: { error: 'path_not_allowed', path: 'design.length' } }])
        .fetch
    ).send(batch)
    expect(refused).toMatchObject({
      kind: 'drop',
      status: 422,
      error: 'path_not_allowed',
      path: 'design.length',
    })
  })

  it('429 honours Retry-After (header in seconds, then body)', async () => {
    const header = await sender(
      scriptedFetch([
        {
          status: 429,
          body: { error: 'rate_limited', retryAfter: 60 },
          headers: { 'retry-after': '12' },
        },
      ]).fetch
    ).send(batch)
    expect(header).toMatchObject({ kind: 'retry', status: 429, retryAfterMs: 12_000 })
    const body = await sender(
      scriptedFetch([{ status: 429, body: { error: 'rate_limited', retryAfter: 60 } }]).fetch
    ).send(batch)
    expect(body).toMatchObject({ kind: 'retry', retryAfterMs: 60_000 })
  })

  it('a network failure or a timeout is a retry', async () => {
    const failing = await sender(scriptedFetch([new TypeError('fetch failed')]).fetch).send(batch)
    expect(failing).toMatchObject({ kind: 'retry', status: null, retryAfterMs: null })

    const hanging = createSender({
      endpoint: 'http://fleetai.test/x',
      token: 'fai_ing_abc',
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    const timedOut = await hanging.send(batch)
    expect(timedOut).toMatchObject({ kind: 'retry', status: null })
    expect((timedOut as { message: string }).message).toMatch(/timeout/)
  })
})
