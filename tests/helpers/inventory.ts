import { SELF } from './runtime'
import type { Delta } from '../../src/types'

export const SALT = '0123456789abcdef0123456789abcdef'

/** A `sources` tree shaped like the one the Signal K server keeps. */
export function sourcesTree(): Record<string, unknown> {
  return {
    can0: {
      type: 'NMEA2000',
      '12': {
        n2k: {
          src: '12',
          manufacturerName: 'Volvo Penta',
          productName: 'EVC',
          serialNumber: 'SN-0042',
          deviceFunction: 'Engine',
        },
      },
      '34': {
        n2k: {
          src: '34',
          manufacturerName: 'Victron Energy',
          productName: 'BMV-712',
          serialNumber: 'HQ2100AB',
          deviceFunction: 'Battery',
        },
      },
      '41': {
        n2k: {
          src: '41',
          manufacturerName: 'Maretron',
          productName: 'TLM100',
          deviceFunction: 'Fluid level',
        },
      },
    },
    ttyUSB0: {
      label: 'ttyUSB0',
      type: 'NMEA0183',
      GP: { sentences: { GGA: '2026-10-25T10:00:00Z', RMC: '2026-10-25T10:00:00Z' } },
    },
  }
}

/** A delta from one source: `$source` like the server writes it. */
export function sourceDelta(
  source: string,
  values: Record<string, unknown>,
  context: string = SELF
): Delta {
  return {
    context,
    updates: [
      {
        $source: source,
        timestamp: '2026-10-25T10:00:00Z',
        values: Object.entries(values).map(([path, value]) => ({ path, value })),
      },
    ],
  }
}

/** Feeds the three NMEA 2000 devices and the GPS of the fixture boat. */
export const BOAT_DELTAS: Delta[] = [
  sourceDelta('can0.12', {
    'propulsion.port.revolutions': 41.6,
    'propulsion.port.coolantTemperature': 350,
    'propulsion.port.runTime': 7200,
  }),
  sourceDelta('can0.34', {
    'electrical.batteries.house.voltage': 12.8,
    'electrical.batteries.house.capacity.stateOfCharge': 0.9,
  }),
  sourceDelta('can0.41', { 'tanks.fuel.0.currentLevel': 0.5 }),
  sourceDelta('ttyUSB0.GP', {
    'navigation.position': { latitude: 43.29, longitude: 5.37 },
    'navigation.speedOverGround': 2.5,
  }),
]
