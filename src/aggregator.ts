import type { AggregateKind, WindowRule } from './catalog'
import type { JsonValue, Sample } from './types'

/**
 * One value per path and per window (mirrors FleetAi's `inertia/lib/signalk/aggregator.ts`).
 *
 * `recordedAt` is the **server's clock floored to the window start**, never the
 * Signal K `timestamp` (NMEA sentence time, arbitrary). Flooring makes replays
 * idempotent: the same window yields the same `(path, recordedAt)` on the server.
 */

interface WindowState {
  path: string
  startMs: number
  windowMs: number
  aggregate: AggregateKind
  count: number
  sum: number
  max: number
  last: number | null
  json: JsonValue | null
}

function toSample(state: WindowState): Sample {
  const recordedAt = new Date(state.startMs).toISOString()
  if (state.json !== null) return { path: state.path, recordedAt, valueJson: state.json }
  let value = state.last
  if (state.aggregate === 'mean' && state.count > 0) value = state.sum / state.count
  if (state.aggregate === 'max' && state.count > 0) value = state.max
  return { path: state.path, recordedAt, value }
}

export function createAggregator() {
  const open = new Map<string, WindowState>()
  let ready: Sample[] = []

  function push(
    path: string,
    sample: { value: number | null; valueJson: JsonValue | null },
    rule: WindowRule,
    atMs: number
  ) {
    const startMs = Math.floor(atMs / rule.windowMs) * rule.windowMs
    const current = open.get(path)
    if (current && current.startMs !== startMs) {
      ready.push(toSample(current))
      open.delete(path)
    }

    let state = open.get(path)
    if (!state) {
      state = {
        path,
        startMs,
        windowMs: rule.windowMs,
        aggregate: rule.aggregate,
        count: 0,
        sum: 0,
        max: Number.NEGATIVE_INFINITY,
        last: null,
        json: null,
      }
      open.set(path, state)
    }

    if (sample.valueJson !== null) {
      state.json = sample.valueJson
      return
    }
    if (sample.value === null) return
    state.count += 1
    state.sum += sample.value
    state.max = Math.max(state.max, sample.value)
    state.last = sample.value
  }

  /** Closed windows (and, with `force`, the open ones too — used on stop). */
  function flush(nowMs: number, options: { force?: boolean } = {}): Sample[] {
    for (const [path, state] of open) {
      if (options.force || state.startMs + state.windowMs <= nowMs) {
        ready.push(toSample(state))
        open.delete(path)
      }
    }
    const out = ready
    ready = []
    return out
  }

  function size(): number {
    return open.size + ready.length
  }

  return { push, flush, size }
}

export type Aggregator = ReturnType<typeof createAggregator>

/** Max samples per batch accepted by the server (`TELEMETRY_MAX_BATCH_SIZE`). */
export const MAX_BATCH_SIZE = 500

/** Splits samples into batches the server accepts (≤ 500), preserving order. */
export function chunkSamples(samples: Sample[], size: number = MAX_BATCH_SIZE): Sample[][] {
  const chunks: Sample[][] = []
  for (let index = 0; index < samples.length; index += size) {
    chunks.push(samples.slice(index, index + size))
  }
  return chunks
}
