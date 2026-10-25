import { catalogSpec, EXTRA_PATH_SPEC, type PathSpec } from './catalog'
import type { Delta, JsonValue } from './types'

/**
 * Signal K delta → catalog samples for the vessel itself. Anything the server
 * could not ingest is dropped here rather than making it refuse a whole batch:
 * paths outside the catalog, `null` / non-finite values, wrong value kind.
 */

export interface NormalizedSample {
  path: string
  spec: PathSpec
  value: number | null
  valueJson: JsonValue | null
}

export interface NormalizeOptions {
  /** `app.selfContext` (`vessels.urn:mrn:…`) — deltas without a context are the vessel itself. */
  selfContext: string | null
  /** Extra paths accepted beyond the catalog (numeric only). */
  isExtraPath?: (path: string) => boolean
  /** Paths the server already refused in this session (`422 path_not_allowed`). */
  isRejectedPath?: (path: string) => boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizePosition(value: unknown): JsonValue | null {
  if (!isRecord(value)) return null
  const { latitude, longitude } = value
  if (!finite(latitude) || !finite(longitude)) return null
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { latitude, longitude }
}

function normalizeNotification(value: unknown): JsonValue | null {
  if (!isRecord(value)) return null
  const state = typeof value.state === 'string' ? value.state : null
  if (state === null) return null
  const method = Array.isArray(value.method)
    ? value.method.filter((item): item is string => typeof item === 'string')
    : []
  return { state, message: typeof value.message === 'string' ? value.message : null, method }
}

export function isSelfDelta(delta: Delta, selfContext: string | null): boolean {
  if (!delta.context || delta.context === 'vessels.self') return true
  return selfContext !== null && delta.context === selfContext
}

export function normalizeDelta(delta: Delta, options: NormalizeOptions): NormalizedSample[] {
  if (!isSelfDelta(delta, options.selfContext)) return []

  const samples: NormalizedSample[] = []
  for (const update of delta.updates ?? []) {
    for (const entry of update.values ?? []) {
      if (typeof entry.path !== 'string' || entry.value === null || entry.value === undefined)
        continue
      if (options.isRejectedPath?.(entry.path)) continue
      // AIS paths are synthetic: never read them from the vessel's own tree.
      if (entry.path.startsWith('ais.')) continue

      let spec = catalogSpec(entry.path)
      if (!spec && options.isExtraPath?.(entry.path)) spec = EXTRA_PATH_SPEC
      if (!spec) continue

      if (spec.valueKind === 'number') {
        if (!finite(entry.value)) continue
        samples.push({ path: entry.path, spec, value: entry.value, valueJson: null })
        continue
      }
      const valueJson = entry.path.startsWith('notifications.')
        ? normalizeNotification(entry.value)
        : normalizePosition(entry.value)
      if (valueJson === null) continue
      samples.push({ path: entry.path, spec, value: null, valueJson })
    }
  }
  return samples
}
