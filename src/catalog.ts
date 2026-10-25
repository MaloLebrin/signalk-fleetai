/**
 * FleetAi path catalog — a **closed allow-list** mirrored from
 * `shared/constants/instruments.ts` and `inertia/lib/signalk/path_catalog.ts`
 * in the FleetAi repository. The server refuses a whole batch when one path is
 * not in this list (`422 path_not_allowed`), so the plugin never sends a path
 * it does not know.
 *
 * Units are left exactly as Signal K emits them (SI: Hz, K, Pa, m/s, rad, m³, ratios).
 */

export type AggregateKind = 'last' | 'mean' | 'max'
export type ValueKind = 'number' | 'json'

export interface PathSpec {
  /** Pattern with `<id>`, `<type>`, `<zone>` for free segments and `<path>` for a sub-tree. */
  pattern: string
  valueKind: ValueKind
  /** Catalog cadence in seconds (`0` = every change, alarms only). */
  intervalS: number
  aggregate: AggregateKind
}

function numeric(pattern: string, intervalS = 60, aggregate: AggregateKind = 'last'): PathSpec {
  return { pattern, valueKind: 'number', intervalS, aggregate }
}

function json(pattern: string, intervalS = 60): PathSpec {
  return { pattern, valueKind: 'json', intervalS, aggregate: 'last' }
}

export const PATH_CATALOG: readonly PathSpec[] = [
  // Propulsion — one engine per <id> (port, starboard, 0…)
  numeric('propulsion.<id>.runTime', 300, 'last'),
  numeric('propulsion.<id>.revolutions', 60, 'mean'),
  numeric('propulsion.<id>.temperature', 60, 'max'),
  numeric('propulsion.<id>.coolantTemperature', 60, 'max'),
  numeric('propulsion.<id>.oilPressure', 60, 'mean'),
  numeric('propulsion.<id>.fuel.rate', 60, 'mean'),
  numeric('propulsion.<id>.oilTemperature', 60, 'max'),
  numeric('propulsion.<id>.exhaustTemperature', 60, 'max'),
  numeric('propulsion.<id>.coolantPressure', 60, 'mean'),
  numeric('propulsion.<id>.boostPressure', 60, 'mean'),
  numeric('propulsion.<id>.engineLoad', 60, 'mean'),
  numeric('propulsion.<id>.alternatorVoltage', 60, 'mean'),

  // Navigation
  json('navigation.position', 60),
  numeric('navigation.speedOverGround', 30, 'mean'),
  numeric('navigation.courseOverGroundTrue', 60, 'last'),
  numeric('navigation.headingTrue', 60, 'last'),
  numeric('navigation.headingMagnetic', 60, 'last'),
  numeric('navigation.speedThroughWater', 30, 'mean'),
  numeric('navigation.log', 300, 'last'),
  numeric('navigation.trip.log', 300, 'last'),

  // Electrical — one battery / device per <id>
  numeric('electrical.batteries.<id>.voltage', 60, 'mean'),
  numeric('electrical.batteries.<id>.current', 60, 'mean'),
  numeric('electrical.batteries.<id>.capacity.stateOfCharge', 300, 'last'),
  numeric('electrical.batteries.<id>.temperature', 60, 'last'),
  numeric('electrical.batteries.<id>.capacity.timeRemaining', 300, 'last'),
  numeric('electrical.batteries.<id>.capacity.stateOfHealth', 3600, 'last'),
  numeric('electrical.solar.<id>.panelVoltage', 60, 'mean'),
  numeric('electrical.solar.<id>.panelCurrent', 60, 'mean'),
  numeric('electrical.solar.<id>.current', 60, 'mean'),
  numeric('electrical.chargers.<id>.voltage', 60, 'mean'),
  numeric('electrical.chargers.<id>.current', 60, 'mean'),
  numeric('electrical.inverters.<id>.dc.voltage', 60, 'mean'),
  numeric('electrical.inverters.<id>.dc.current', 60, 'mean'),
  numeric('electrical.inverters.<id>.ac.realPower', 60, 'mean'),

  // Tanks — <type> (fuel, freshWater, blackWater…) then <id>
  numeric('tanks.<type>.<id>.currentLevel', 300, 'last'),
  numeric('tanks.<type>.<id>.capacity', 3600, 'last'),
  numeric('tanks.<type>.<id>.currentVolume', 300, 'last'),

  // Environment
  numeric('environment.wind.speedApparent', 30, 'max'),
  numeric('environment.wind.speedTrue', 30, 'max'),
  numeric('environment.wind.angleApparent', 60, 'last'),
  numeric('environment.wind.angleTrueWater', 60, 'last'),
  numeric('environment.wind.directionTrue', 60, 'last'),
  numeric('environment.depth.belowTransducer', 30, 'mean'),
  numeric('environment.depth.belowKeel', 30, 'mean'),
  numeric('environment.depth.belowSurface', 30, 'mean'),
  numeric('environment.water.temperature', 60, 'last'),
  numeric('environment.outside.temperature', 60, 'last'),
  numeric('environment.outside.pressure', 60, 'last'),
  numeric('environment.wind.speedOverGround', 30, 'max'),
  numeric('environment.wind.angleTrueGround', 60, 'last'),
  numeric('environment.wind.directionMagnetic', 60, 'last'),
  numeric('environment.outside.relativeHumidity', 300, 'last'),
  numeric('environment.inside.temperature', 300, 'mean'),
  numeric('environment.inside.relativeHumidity', 300, 'last'),
  numeric('environment.inside.<zone>.temperature', 300, 'max'),
  numeric('environment.inside.<zone>.relativeHumidity', 300, 'last'),
  numeric('environment.tide.heightNow', 300, 'last'),

  // Signal K alarms: `{ state, message, method }` under any `notifications.<path>` — every change.
  json('notifications.<path>', 0),
]

/** AIS targets travel under a synthetic `ais.<mmsi>` path, one sighting per 5-minute window. */
export const AIS_PATH_PREFIX = 'ais.'
export const AIS_SIGHTING_WINDOW_S = 300
export const AIS_SPEC: PathSpec = {
  pattern: 'ais.<mmsi>',
  valueKind: 'json',
  intervalS: AIS_SIGHTING_WINDOW_S,
  aggregate: 'last',
}

/** Max path length accepted by the server (`TELEMETRY_PATH_MAX_LENGTH`). */
export const PATH_MAX_LENGTH = 96

const SEGMENT = '[A-Za-z0-9_-]+'

function patternToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('.')
    .map((segment) => {
      if (segment === '<path>' || segment === '*') return `${SEGMENT}(?:\\.${SEGMENT})*`
      if (segment.startsWith('<') && segment.endsWith('>')) return SEGMENT
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('\\.')
  return new RegExp(`^${source}$`)
}

const COMPILED = PATH_CATALOG.map((spec) => ({ spec, regexp: patternToRegExp(spec.pattern) }))

/** The catalog entry accepting `path`, or `null`. */
export function catalogSpec(path: string): PathSpec | null {
  if (path.length === 0 || path.length > PATH_MAX_LENGTH) return null
  if (path.startsWith(AIS_PATH_PREFIX)) {
    return /^\d{9}$/.test(path.slice(AIS_PATH_PREFIX.length)) ? AIS_SPEC : null
  }
  const found = COMPILED.find(({ regexp }) => regexp.test(path))
  return found ? found.spec : null
}

/** Signal K wildcard for a catalog pattern (`propulsion.*.runTime`). */
export function wildcardPath(pattern: string): string {
  return pattern.replace(/<path>/g, '*').replace(/<[a-z]+>/g, '*')
}

/** Extra allow-list from the `paths` setting: exact paths or Signal K wildcards, numeric values only. */
export function extraPathMatcher(paths: readonly string[]): (path: string) => boolean {
  const regexps = paths
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0 && raw.length <= PATH_MAX_LENGTH)
    .map((raw) => patternToRegExp(raw))
  if (regexps.length === 0) return () => false
  return (path) => regexps.some((regexp) => regexp.test(path))
}

export interface WindowRule {
  windowMs: number
  aggregate: AggregateKind
  valueKind: ValueKind
}

/**
 * Window for a path: `periodSeconds` is the floor the user chose; the catalog
 * keeps slower cadences slower (engine hours every 5 min, tank capacity hourly).
 * Alarms are not averaged and go out at the next tick.
 */
export function windowRule(spec: PathSpec, periodSeconds: number): WindowRule {
  if (spec.intervalS === 0)
    return { windowMs: 1000, aggregate: spec.aggregate, valueKind: spec.valueKind }
  return {
    windowMs: Math.max(spec.intervalS, periodSeconds) * 1000,
    aggregate: spec.aggregate,
    valueKind: spec.valueKind,
  }
}

export const EXTRA_PATH_SPEC: PathSpec = {
  pattern: '<extra>',
  valueKind: 'number',
  intervalS: 60,
  aggregate: 'last',
}
