import { describe, expect, it } from 'vitest'
import {
  createInventoryTracker,
  DEVICE_GONE_AFTER_MS,
  hashSerial,
  MAX_DEVICES,
  MAX_PATHS_PER_DEVICE,
  n2kDeviceId,
  type InventoryDevice,
} from '../src/inventory'
import { BOAT_DELTAS, sourceDelta, sourcesTree } from './helpers/inventory'
import { SELF, T0 } from './helpers/runtime'

function tracker(options: { hide?: boolean; sources?: unknown } = {}) {
  return createInventoryTracker({
    selfContext: SELF,
    hideSerialNumbers: options.hide ?? false,
    readSources: () => options.sources ?? sourcesTree(),
  })
}

function byAddress(devices: InventoryDevice[], address: number) {
  const device = devices.find((d) => d.address === address)
  if (!device) throw new Error(`no device at ${address}`)
  return device
}

describe('inventory — building from the sources tree', () => {
  it('lists NMEA 2000 devices with their metadata and the catalog paths of their $source', () => {
    const t = tracker()
    for (const delta of BOAT_DELTAS) t.observeDelta(delta, T0)
    const { devices } = t.snapshot(T0).payload

    expect(devices).toHaveLength(4)
    expect(byAddress(devices, 12)).toMatchObject({
      label: 'Volvo Penta EVC',
      manufacturer: 'Volvo Penta',
      model: 'EVC',
      serialNumber: 'SN-0042',
      function: 'Engine',
      bus: 'n2k',
      paths: [
        'propulsion.port.coolantTemperature',
        'propulsion.port.revolutions',
        'propulsion.port.runTime',
      ],
    })
    expect(byAddress(devices, 34).paths).toEqual([
      'electrical.batteries.house.capacity.stateOfCharge',
      'electrical.batteries.house.voltage',
    ])
    // No serial in the tree: the key is left out, not sent as empty text.
    expect(byAddress(devices, 41)).not.toHaveProperty('serialNumber')
  })

  it('describes a NMEA 0183 connection by its label and the sentences seen', () => {
    const t = tracker()
    t.observeDelta(BOAT_DELTAS[3]!, T0)
    const [gps] = t.snapshot(T0).payload.devices
    expect(gps).toMatchObject({
      deviceId: 'nmea0183-ttyUSB0',
      label: 'NMEA 0183 ttyUSB0 (GGA, RMC)',
      bus: 'nmea0183',
      paths: ['navigation.position', 'navigation.speedOverGround'],
    })
    expect(gps).not.toHaveProperty('address')
  })

  it('reads the sentence from the delta source object when the tree has none', () => {
    const t = tracker({ sources: {} })
    t.observeDelta(
      {
        context: SELF,
        updates: [
          {
            source: { label: 'serial1', type: 'NMEA0183', talker: 'II', sentence: 'DPT' },
            values: [{ path: 'environment.depth.belowTransducer', value: 4.2 }],
          },
        ],
      },
      T0
    )
    expect(t.snapshot(T0).payload.devices[0]).toMatchObject({
      deviceId: 'nmea0183-serial1',
      label: 'NMEA 0183 serial1 (DPT)',
    })
  })

  it('ignores what is not a catalog measurement of a bus device', () => {
    const t = tracker()
    t.observeDelta(sourceDelta('can0.12', { 'design.length': 12 }), T0) // not in the catalog
    t.observeDelta(sourceDelta('can0.12', { 'notifications.fire': { state: 'alarm' } }), T0)
    t.observeDelta(sourceDelta('derived-data', { 'navigation.speedOverGround': 3 }), T0) // a plugin
    t.observeDelta(sourceDelta('unknown.99', { 'navigation.speedOverGround': 3 }), T0)
    t.observeDelta(sourceDelta('can0.12', { 'navigation.log': null }), T0)
    t.observeDelta(
      sourceDelta('can0.12', { 'navigation.log': 5 }, 'vessels.urn:mrn:imo:mmsi:244630000'),
      T0
    ) // an AIS target
    expect(t.snapshot(T0).payload.devices).toEqual([])
  })

  it('keeps announcing a device whose metadata is missing, by address', () => {
    const t = tracker({ sources: { can0: { type: 'NMEA2000' } } })
    t.observeDelta(sourceDelta('can0.77', { 'navigation.log': 1 }), T0)
    const [device] = t.snapshot(T0).payload.devices
    expect(device).toMatchObject({ label: 'NMEA 2000 device 77', bus: 'n2k', address: 77 })
    expect(device!.deviceId).toMatch(/^n2k-[0-9a-f]{16}$/)
  })

  it('survives a broken or throwing sources reader', () => {
    const t = createInventoryTracker({
      selfContext: SELF,
      hideSerialNumbers: false,
      readSources: () => {
        throw new Error('boom')
      },
    })
    t.observeDelta(sourceDelta('can0.12', { 'navigation.log': 1 }, SELF), T0)
    expect(t.snapshot(T0).payload.devices).toEqual([]) // unknown bus: nothing to announce
  })

  it('strips control characters and caps text at 120 characters', () => {
    const t = tracker({
      sources: {
        can0: {
          type: 'NMEA2000',
          '5': { n2k: { manufacturerName: 'Acme\u0000\n Corp', productName: 'x'.repeat(300) } },
        },
      },
    })
    t.observeDelta(sourceDelta('can0.5', { 'navigation.log': 1 }), T0)
    const [device] = t.snapshot(T0).payload.devices
    expect(device!.manufacturer).toBe('Acme Corp')
    expect(device!.model).toHaveLength(120)
    expect(device!.label.length).toBeLessThanOrEqual(120)
  })
})

describe('inventory — device id and serial number', () => {
  it('derives a stable id from manufacturer + model + serial, whatever the address', () => {
    const a = tracker()
    a.observeDelta(BOAT_DELTAS[0]!, T0)
    const moved = tracker({
      sources: {
        can0: {
          type: 'NMEA2000',
          '88': {
            n2k: { manufacturerName: 'volvo penta', productName: 'EVC ', serialNumber: 'sn-0042' },
          },
        },
      },
    })
    moved.observeDelta(sourceDelta('can0.88', { 'propulsion.port.runTime': 1 }), T0)

    const idA = a.snapshot(T0).payload.devices[0]!.deviceId
    expect(idA).toMatch(/^n2k-[0-9a-f]{16}$/)
    expect(moved.snapshot(T0).payload.devices[0]!.deviceId).toBe(idA)
    expect(idA).toBe(
      n2kDeviceId({
        manufacturer: 'Volvo Penta',
        model: 'EVC',
        serialNumber: 'SN-0042',
        fallback: '',
      })
    )
  })

  it('never puts the serial number in the id and respects the validator charset', () => {
    const t = tracker()
    for (const delta of BOAT_DELTAS) t.observeDelta(delta, T0)
    for (const device of t.snapshot(T0).payload.devices) {
      expect(device.deviceId).toMatch(/^[0-9A-Za-z][0-9A-Za-z_:.-]*$/)
      expect(device.deviceId.length).toBeLessThanOrEqual(64)
      expect(device.deviceId).not.toContain('SN-0042')
      expect(device.deviceId).not.toContain('HQ2100AB')
    }
  })

  it('sends the serial in clear by default', () => {
    const t = tracker()
    t.observeDelta(BOAT_DELTAS[0]!, T0)
    expect(t.snapshot(T0).payload.devices[0]!.serialNumber).toBe('SN-0042')
  })

  it('"hide" replaces the serial by a hash — in clear nowhere in the payload', () => {
    const t = tracker({ hide: true })
    for (const delta of BOAT_DELTAS) t.observeDelta(delta, T0)
    const { payload, signature } = t.snapshot(T0)
    const engine = byAddress(payload.devices, 12)
    expect(engine.serialNumber).toBe(hashSerial('SN-0042'))
    expect(engine.serialNumber).toMatch(/^h:[0-9a-f]{8}$/)
    expect(signature).not.toContain('SN-0042')
    expect(signature).not.toContain('HQ2100AB')
    // Hiding the serial does not change the id: the same device stays the same device.
    const clear = tracker()
    clear.observeDelta(BOAT_DELTAS[0]!, T0)
    expect(engine.deviceId).toBe(clear.snapshot(T0).payload.devices[0]!.deviceId)
  })

  it('hashes the same serial the same way, and different serials differently', () => {
    expect(hashSerial('SN-0042')).toBe(hashSerial(' sn-0042 '))
    expect(hashSerial('SN-0042')).not.toBe(hashSerial('SN-0043'))
  })

  it('tells two identical serial-less devices apart (no duplicate_device)', () => {
    const t = tracker({
      sources: {
        can0: {
          type: 'NMEA2000',
          '10': { n2k: { manufacturerName: 'Yanmar', productName: 'Gateway' } },
          '11': { n2k: { manufacturerName: 'Yanmar', productName: 'Gateway' } },
        },
      },
    })
    t.observeDelta(sourceDelta('can0.10', { 'propulsion.port.runTime': 1 }), T0)
    t.observeDelta(sourceDelta('can0.11', { 'propulsion.starboard.runTime': 1 }), T0)
    const ids = t.snapshot(T0).payload.devices.map((d) => d.deviceId)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('inventory — fallback on PGN 126996 / 60928', () => {
  const productInfo = (src: number) => ({
    pgn: 126996,
    src,
    fields: { 'Model ID': 'TLM100', 'Model Serial Code': 'TL-777' },
  })
  const addressClaim = (src: number) => ({
    pgn: 60928,
    src,
    fields: { 'Manufacturer Code': 'Maretron', 'Device Function': 'Fluid level' },
  })

  it('fills the metadata the sources tree does not carry', () => {
    const t = tracker({ sources: { can0: { type: 'NMEA2000' } } })
    t.observeDelta(sourceDelta('can0.41', { 'tanks.fuel.0.currentLevel': 0.5 }), T0)
    t.observePgn(productInfo(41), T0)
    t.observePgn(addressClaim(41), T0)
    expect(t.snapshot(T0).payload.devices[0]).toMatchObject({
      label: 'Maretron TLM100',
      manufacturer: 'Maretron',
      model: 'TLM100',
      serialNumber: 'TL-777',
      function: 'Fluid level',
      address: 41,
      paths: ['tanks.fuel.0.currentLevel'],
    })
  })

  it('announces a device known only by its PGNs, with no path yet', () => {
    const t = tracker({ sources: {} })
    t.observePgn(productInfo(41), T0)
    t.observePgn(addressClaim(41), T0)
    expect(t.snapshot(T0).payload.devices).toMatchObject([
      { model: 'TLM100', bus: 'n2k', address: 41, paths: [] },
    ])
  })

  it('hides a PGN serial number too, and accepts snake/camel field spellings', () => {
    const t = tracker({ hide: true, sources: {} })
    t.observePgn(
      { pgn: 126996, src: 3, fields: { modelId: 'X1', model_serial_code: 'SECRET' } },
      T0
    )
    const [device] = t.snapshot(T0).payload.devices
    expect(device).toMatchObject({ model: 'X1', serialNumber: hashSerial('SECRET') })
    expect(JSON.stringify(device)).not.toContain('SECRET')
  })

  it('ignores other PGNs and malformed messages', () => {
    const t = tracker({ sources: {} })
    t.observePgn({ pgn: 127488, src: 3, fields: {} }, T0)
    t.observePgn({ pgn: 126996, src: 'x', fields: {} }, T0)
    t.observePgn({ pgn: 126996, src: 999, fields: {} }, T0)
    t.observePgn(null, T0)
    t.observePgn('nope', T0)
    expect(t.snapshot(T0).payload.devices).toEqual([])
  })

  it('prefers the sources tree over the PGN when both know a field', () => {
    const t = tracker()
    t.observeDelta(BOAT_DELTAS[0]!, T0)
    t.observePgn(
      { pgn: 126996, src: 12, fields: { 'Model ID': 'OTHER', 'Model Serial Code': 'Z' } },
      T0
    )
    expect(byAddress(t.snapshot(T0).payload.devices, 12)).toMatchObject({
      model: 'EVC',
      serialNumber: 'SN-0042',
    })
  })
})

describe('inventory — appearance, disappearance, limits', () => {
  it('drops a device silent for more than ten minutes, keeps one seen since', () => {
    const t = tracker()
    t.observeDelta(BOAT_DELTAS[0]!, T0) // engine
    t.observeDelta(BOAT_DELTAS[1]!, T0 + 5 * 60_000) // battery

    const justBefore = t.snapshot(T0 + DEVICE_GONE_AFTER_MS)
    expect(justBefore.payload.devices).toHaveLength(2)

    const after = t.snapshot(T0 + DEVICE_GONE_AFTER_MS + 1)
    expect(after.payload.devices.map((d) => d.address)).toEqual([34])
    expect(after.signature).not.toBe(justBefore.signature)
  })

  it('brings a device back when it talks again', () => {
    const t = tracker()
    t.observeDelta(BOAT_DELTAS[0]!, T0)
    expect(t.snapshot(T0 + DEVICE_GONE_AFTER_MS + 1).payload.devices).toEqual([])
    t.observeDelta(BOAT_DELTAS[0]!, T0 + DEVICE_GONE_AFTER_MS + 2)
    expect(t.snapshot(T0 + DEVICE_GONE_AFTER_MS + 3).payload.devices).toHaveLength(1)
  })

  it('a new path changes the signature, repeated deltas do not', () => {
    const t = tracker()
    t.observeDelta(BOAT_DELTAS[0]!, T0)
    const first = t.snapshot(T0).signature
    t.observeDelta(BOAT_DELTAS[0]!, T0 + 1000)
    expect(t.snapshot(T0 + 1000).signature).toBe(first)
    t.observeDelta(sourceDelta('can0.12', { 'propulsion.port.oilPressure': 3e5 }), T0 + 2000)
    expect(t.snapshot(T0 + 2000).signature).not.toBe(first)
  })

  it('caps at 64 devices and 100 paths per device (FleetAi limits)', () => {
    const tree: Record<string, unknown> = { can0: { type: 'NMEA2000' } }
    const t = tracker({ sources: tree })
    for (let src = 0; src < 80; src += 1) {
      t.observeDelta(sourceDelta(`can0.${src}`, { 'navigation.log': src }), T0 + src)
    }
    const values: Record<string, unknown> = {}
    for (let i = 0; i < 150; i += 1) values[`electrical.batteries.b${i}.voltage`] = 12
    t.observeDelta(sourceDelta('can0.200', values), T0 + 1000)

    const { devices } = t.snapshot(T0 + 1000).payload
    expect(devices).toHaveLength(MAX_DEVICES)
    expect(devices.find((d) => d.address === 200)!.paths).toHaveLength(MAX_PATHS_PER_DEVICE)
    // The most recently seen win: the oldest addresses are the ones left out.
    expect(devices.some((d) => d.address === 0)).toBe(false)
  })
})
