import type { Delta, JsonValue } from './types'

/**
 * AIS targets (other `vessels.urn:mrn:imo:mmsi:<mmsi>` contexts). The plugin
 * keeps, per MMSI, the latest state of each useful field and emits one
 * `ais.<mmsi>` sample per window — the shape FleetAi's `parseAisTargetValue`
 * expects. A target without a position is never sent (the server would refuse
 * the whole batch).
 */

/** Beyond this, the oldest targets are forgotten (busy harbour). */
const MAX_TRACKED = 500

/** Paths subscribed under `vessels.*` for AIS targets. */
export const AIS_SUBSCRIBED_PATHS = [
  'navigation.position',
  'navigation.speedOverGround',
  'navigation.courseOverGroundTrue',
  'navigation.closestApproach',
  'design.aisShipType',
  'name',
] as const

export interface AisTargetValue {
  name: string | null
  latitude: number
  longitude: number
  sogMs: number | null
  cogRad: number | null
  shipType: number | null
  shipTypeName: string | null
  cpaM: number | null
  tcpaS: number | null
}

interface TrackedTarget {
  name: string | null
  latitude: number | null
  longitude: number | null
  sogMs: number | null
  cogRad: number | null
  shipType: number | null
  shipTypeName: string | null
  cpaM: number | null
  tcpaS: number | null
  seenAtMs: number
  /** Changed since the last snapshot. */
  dirty: boolean
}

const NAME_MAX_LENGTH = 120

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The MMSI of a Signal K context (`vessels.urn:mrn:imo:mmsi:244630000`), or `null`. */
export function mmsiFromContext(context: string | undefined): string | null {
  if (!context) return null
  const match = /^vessels\.urn:mrn:imo:mmsi:(\d{9})$/.exec(context)
  return match ? match[1]! : null
}

function emptyTarget(nowMs: number): TrackedTarget {
  return {
    name: null,
    latitude: null,
    longitude: null,
    sogMs: null,
    cogRad: null,
    shipType: null,
    shipTypeName: null,
    cpaM: null,
    tcpaS: null,
    seenAtMs: nowMs,
    dirty: false,
  }
}

function applyValue(target: TrackedTarget, path: string, value: unknown) {
  if (value === null || value === undefined) return
  switch (path) {
    case 'navigation.position':
      if (isRecord(value)) {
        const latitude = finite(value.latitude)
        const longitude = finite(value.longitude)
        if (latitude !== null && longitude !== null) {
          target.latitude = latitude
          target.longitude = longitude
          target.dirty = true
        }
      }
      return
    case 'navigation.speedOverGround':
      target.sogMs = finite(value) ?? target.sogMs
      target.dirty = true
      return
    case 'navigation.courseOverGroundTrue':
      target.cogRad = finite(value) ?? target.cogRad
      target.dirty = true
      return
    case 'name':
      if (typeof value === 'string') target.name = value
      return
    case '':
      // Some servers publish the vessel name at the root of the context.
      if (isRecord(value) && typeof value.name === 'string') target.name = value.name
      return
    case 'design.aisShipType':
      if (isRecord(value)) {
        const id = finite(value.id)
        target.shipType = id !== null && Number.isInteger(id) ? id : target.shipType
        if (typeof value.name === 'string') target.shipTypeName = value.name
      }
      return
    case 'navigation.closestApproach':
      if (isRecord(value)) {
        target.cpaM = finite(value.distance)
        target.tcpaS = finite(value.timeTo)
        target.dirty = true
      }
      return
    default:
  }
}

function toValue(state: TrackedTarget): AisTargetValue | null {
  if (state.latitude === null || state.longitude === null) return null
  if (Math.abs(state.latitude) > 90 || Math.abs(state.longitude) > 180) return null
  const name = state.name?.trim().slice(0, NAME_MAX_LENGTH) ?? ''
  const shipTypeName = state.shipTypeName?.trim().slice(0, 60) ?? ''
  return {
    name: name === '' ? null : name,
    latitude: state.latitude,
    longitude: state.longitude,
    sogMs: state.sogMs,
    cogRad: state.cogRad,
    shipType: state.shipType,
    shipTypeName: shipTypeName === '' ? null : shipTypeName,
    cpaM: state.cpaM,
    tcpaS: state.tcpaS,
  }
}

export function createAisTracker(selfContext: string | null) {
  const tracked = new Map<string, TrackedTarget>()

  /** Retains a target's delta; `false` when the delta is not an AIS target (or is the vessel itself). */
  function ingest(delta: Delta, nowMs: number): boolean {
    const mmsi = mmsiFromContext(delta.context)
    if (mmsi === null || delta.context === selfContext) return false

    const target = tracked.get(mmsi) ?? emptyTarget(nowMs)
    for (const update of delta.updates ?? []) {
      for (const entry of update.values ?? []) applyValue(target, entry.path, entry.value)
    }
    target.seenAtMs = nowMs
    tracked.set(mmsi, target)

    if (tracked.size > MAX_TRACKED) {
      const oldest = [...tracked.entries()].sort((a, b) => a[1].seenAtMs - b[1].seenAtMs)[0]
      if (oldest) tracked.delete(oldest[0])
    }
    return true
  }

  /**
   * Targets with a position that changed since the last call, as `(mmsi, value)` pairs.
   * Targets silent for `expiryMs` are forgotten.
   */
  function drain(nowMs: number, expiryMs: number): Array<{ mmsi: string; value: AisTargetValue }> {
    const out: Array<{ mmsi: string; value: AisTargetValue }> = []
    for (const [mmsi, state] of tracked) {
      if (nowMs - state.seenAtMs > expiryMs) {
        tracked.delete(mmsi)
        continue
      }
      if (!state.dirty) continue
      const value = toValue(state)
      if (value === null) continue
      state.dirty = false
      out.push({ mmsi, value })
    }
    return out
  }

  function size(): number {
    return tracked.size
  }

  return { ingest, drain, size }
}

export type AisTracker = ReturnType<typeof createAisTracker>

export function aisValueToJson(value: AisTargetValue): JsonValue {
  return { ...value }
}
