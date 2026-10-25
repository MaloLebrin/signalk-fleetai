import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRuntime, type RuntimeOptions } from '../../src/runtime'
import { createSender, type FetchLike } from '../../src/sender'
import type { Delta, ResolvedConfig } from '../../src/types'

export const SELF = 'vessels.urn:mrn:imo:mmsi:227000001'
export const T0 = Date.parse('2026-10-25T10:00:00.000Z')

export function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    endpoint: 'http://fleetai.test/api/instruments/ingest',
    token: 'fai_ing_test',
    periodSeconds: 60,
    paths: [],
    ...overrides,
  }
}

export function selfDelta(path: string, value: unknown, context: string = SELF): Delta {
  return { context, updates: [{ timestamp: '2001-01-01T00:00:00Z', values: [{ path, value }] }] }
}

export function aisDelta(mmsi: string, values: Array<{ path: string; value: unknown }>): Delta {
  return { context: `vessels.urn:mrn:imo:mmsi:${mmsi}`, updates: [{ values }] }
}

export interface Harness {
  runtime: ReturnType<typeof createRuntime>
  clock: { now: number }
  statuses: string[]
  errors: string[]
  logs: string[]
  fatal: unknown[]
  queueFilePath: string
}

/** A runtime with a fake clock and a scripted `fetch`. */
export function harness(options: {
  fetch: FetchLike
  config?: Partial<ResolvedConfig>
  queueFilePath?: string
  runtime?: Partial<RuntimeOptions>
}): Harness {
  const clock = { now: T0 }
  const statuses: string[] = []
  const errors: string[] = []
  const logs: string[] = []
  const fatal: unknown[] = []
  const resolved = config(options.config)
  const queueFilePath =
    options.queueFilePath ?? join(mkdtempSync(join(tmpdir(), 'fleetai-queue-')), 'queue.json')
  const runtime = createRuntime({
    config: resolved,
    selfContext: SELF,
    queueFilePath,
    sender: createSender({
      endpoint: resolved.endpoint,
      token: resolved.token,
      fetch: options.fetch,
    }),
    log: { debug: (m) => void logs.push(m), error: (m) => void logs.push(`ERROR ${m}`) },
    status: { setStatus: (m) => void statuses.push(m), setError: (m) => void errors.push(m) },
    onFatal: (outcome) => void fatal.push(outcome),
    now: () => clock.now,
    ...options.runtime,
  })
  return { runtime, clock, statuses, errors, logs, fatal, queueFilePath }
}

/** A `fetch` that answers from a script, recording every call. */
export function scriptedFetch(
  script: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>
) {
  const calls: Array<{
    url: string
    init: RequestInit
    body: { batchId: string; samples: unknown[] }
  }> = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) })
    const step = script.length > 1 ? script.shift()! : script[0]!
    if (step instanceof Error) throw step
    return new Response(step.body === undefined ? null : JSON.stringify(step.body), {
      status: step.status,
      headers: { 'content-type': 'application/json', ...(step.headers ?? {}) },
    })
  }
  return { fetch, calls }
}
