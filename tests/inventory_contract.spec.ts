import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createInventoryTracker,
  type InventoryDevice,
  type InventoryPayload,
} from '../src/inventory'
import { BOAT_DELTAS, SALT, sourcesTree } from './helpers/inventory'
import { SELF, T0 } from './helpers/runtime'

/**
 * Contract with FleetAi. `signalk_plugin_inventory.json` is the fixture of
 * `boat-management` (`tests/fixtures/`, replayed there by
 * `inventory_ingest.spec.ts` through `ingestInventoryApiValidator`). The
 * rules below restate that validator and `shared/constants/instruments.ts`;
 * if FleetAi changes the contract, change the fixture and these rules together.
 */

const MAX_DEVICES = 64
const MAX_PATHS = 100
const TEXT_MAX = 120
const DEVICE_ID_MAX = 64
const TELEMETRY_PATH_MAX = 96
const BUSES = ['n2k', 'nmea0183', 'other']
const SLUG_OR_HASH = /^[0-9A-Za-z][0-9A-Za-z_:.-]*$/
const PLAIN_TEXT = /^[^\p{Cc}\p{Cf}]*$/u
const DEVICE_KEYS = [
  'deviceId',
  'label',
  'manufacturer',
  'model',
  'serialNumber',
  'function',
  'bus',
  'address',
  'paths',
]

/** Returns what `ingestInventoryApiValidator` would refuse (empty = accepted). */
function violations(payload: unknown): string[] {
  const problems: string[] = []
  const body = payload as InventoryPayload
  if (!Array.isArray(body?.devices)) return ['devices must be an array']
  if (body.devices.length > MAX_DEVICES) problems.push('too many devices')
  const ids = new Set<string>()
  body.devices.forEach((device, index) => {
    const at = `devices[${index}]`
    for (const key of Object.keys(device)) {
      if (!DEVICE_KEYS.includes(key)) problems.push(`${at}.${key} is not part of the contract`)
    }
    const id = device.deviceId
    if (typeof id !== 'string' || id === '' || id.length > DEVICE_ID_MAX || !SLUG_OR_HASH.test(id))
      problems.push(`${at}.deviceId`)
    if (ids.has(id)) problems.push(`${at}.deviceId duplicated`)
    ids.add(id)
    if (
      typeof device.label !== 'string' ||
      device.label.trim() === '' ||
      device.label.length > TEXT_MAX ||
      !PLAIN_TEXT.test(device.label)
    )
      problems.push(`${at}.label`)
    for (const key of ['manufacturer', 'model', 'serialNumber', 'function'] as const) {
      const value = device[key]
      if (value === undefined || value === null) continue
      if (typeof value !== 'string' || value.length > TEXT_MAX || !PLAIN_TEXT.test(value))
        problems.push(`${at}.${key}`)
    }
    if (!BUSES.includes(device.bus)) problems.push(`${at}.bus`)
    if (device.address !== undefined && device.address !== null) {
      if (!Number.isInteger(device.address) || device.address < 0 || device.address > 255)
        problems.push(`${at}.address`)
    }
    if (!Array.isArray(device.paths) || device.paths.length > MAX_PATHS)
      problems.push(`${at}.paths`)
    else if (
      device.paths.some((p) => typeof p !== 'string' || p === '' || p.length > TELEMETRY_PATH_MAX)
    )
      problems.push(`${at}.paths[]`)
  })
  return problems
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'signalk_plugin_inventory.json'), 'utf8')
) as InventoryPayload

function build(hide: boolean): InventoryPayload {
  const tracker = createInventoryTracker({
    selfContext: SELF,
    hideSerialNumbers: hide,
    salt: SALT,
    readSources: () => sourcesTree(),
  })
  for (const delta of BOAT_DELTAS) tracker.observeDelta(delta, T0)
  return tracker.snapshot(T0).payload
}

describe('inventory contract — FleetAi fixture', () => {
  it('the validator rules accept the FleetAi fixture (the rules below are faithful)', () => {
    expect(violations(fixture)).toEqual([])
    expect(violations({ devices: [{ ...fixture.devices[0], bus: 'usb' }] })).toContain(
      'devices[0].bus'
    )
    expect(violations({ devices: [{ ...fixture.devices[0], deviceId: 'bad id' }] })).toContain(
      'devices[0].deviceId'
    )
    expect(violations({ devices: [{ ...fixture.devices[0], extra: 1 }] })).not.toEqual([])
  })

  it.each([false, true])('a payload built by the plugin is accepted as is (hide=%s)', (hide) => {
    const payload = build(hide)
    expect(payload.devices).toHaveLength(fixture.devices.length)
    expect(violations(payload)).toEqual([])
    // Survives the JSON round trip untouched: what is posted is what is validated.
    expect(violations(JSON.parse(JSON.stringify(payload)))).toEqual([])
  })

  it('uses the fixture shape for the same boat: keys, buses, addresses, functions and paths', () => {
    const built = build(false)
    const find = (list: InventoryDevice[], bus: string, address: number | null | undefined) =>
      list.find((d) => d.bus === bus && (d.address ?? null) === (address ?? null))!

    for (const expected of fixture.devices) {
      const actual = find(built.devices, expected.bus, expected.address)
      expect(actual, `device ${expected.deviceId}`).toBeDefined()
      expect(actual.bus).toBe(expected.bus)
      expect(actual.manufacturer ?? null).toBe(expected.manufacturer ?? null)
      expect(actual.model ?? null).toBe(expected.model ?? null)
      expect(actual.function ?? null).toBe(expected.function ?? null)
      expect([...actual.paths].sort()).toEqual([...expected.paths].sort())
      expect(actual.deviceId).toMatch(expected.bus === 'n2k' ? /^n2k-[0-9a-f]{16}$/ : /^nmea0183-/)
      // Same keys as the fixture, apart from the serial number (the fixture shows it hashed on one device only).
      const keys = (d: InventoryDevice) =>
        Object.keys(d)
          .filter((k) => k !== 'serialNumber')
          .sort()
      expect(keys(actual).filter((k) => keys(expected).includes(k))).toEqual(keys(expected))
    }
  })

  it('with "hide", the fixture form of the serial number is produced (h:<8 hex>) and no clear serial is left', () => {
    const payload = build(true)
    const serials = payload.devices.flatMap((d) => (d.serialNumber ? [d.serialNumber] : []))
    expect(serials.length).toBeGreaterThan(0)
    for (const serial of serials) expect(serial).toMatch(/^h:[0-9a-f]{8}$/)
    expect(fixture.devices[0]!.serialNumber).toMatch(/^h:[0-9a-f]{8}$/)
    const text = JSON.stringify(payload)
    expect(text).not.toContain('SN-0042')
    expect(text).not.toContain('HQ2100AB')
  })
})
