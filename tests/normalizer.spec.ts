import { describe, expect, it } from 'vitest'
import { normalizeDelta } from '../src/normalizer'
import { createAisTracker } from '../src/ais_tracker'
import { aisDelta, SELF, selfDelta } from './helpers/runtime'

describe('normalizer — self deltas', () => {
  const options = { selfContext: SELF, isExtraPath: (p: string) => p === 'steering.rudderAngle' }

  it('keeps catalog numbers and structured values as SI, drops the rest', () => {
    const delta = {
      context: SELF,
      updates: [
        {
          values: [
            { path: 'propulsion.port.revolutions', value: 41.6667 },
            { path: 'navigation.headingTrue', value: null },
            { path: 'navigation.speedOverGround', value: Number.NaN },
            {
              path: 'navigation.position',
              value: { latitude: 43.29, longitude: 5.37, altitude: 3 },
            },
            { path: 'navigation.position', value: { latitude: 'x', longitude: 5 } },
            {
              path: 'notifications.mob',
              value: {
                state: 'emergency',
                message: 'MOB',
                method: ['sound', 'visual'],
                timestamp: 'x',
              },
            },
            { path: 'design.length', value: 12 },
            { path: 'steering.rudderAngle', value: 0.1 },
            { path: 'propulsion.port.revolutions', value: { a: 1 } },
          ],
        },
      ],
    }
    const samples = normalizeDelta(delta, options).map(({ path, value, valueJson }) => ({
      path,
      value,
      valueJson,
    }))
    expect(samples).toEqual([
      { path: 'propulsion.port.revolutions', value: 41.6667, valueJson: null },
      { path: 'navigation.position', value: null, valueJson: { latitude: 43.29, longitude: 5.37 } },
      {
        path: 'notifications.mob',
        value: null,
        valueJson: { state: 'emergency', message: 'MOB', method: ['sound', 'visual'] },
      },
      { path: 'steering.rudderAngle', value: 0.1, valueJson: null },
    ])
  })

  it('ignores other vessels and accepts missing / vessels.self contexts', () => {
    expect(
      normalizeDelta(selfDelta('navigation.log', 1, 'vessels.urn:mrn:imo:mmsi:244630000'), options)
    ).toEqual([])
    expect(normalizeDelta(selfDelta('navigation.log', 1, 'vessels.self'), options)).toHaveLength(1)
    expect(
      normalizeDelta({ updates: [{ values: [{ path: 'navigation.log', value: 1 }] }] }, options)
    ).toHaveLength(1)
  })
})

describe('AIS tracker — one sighting per target', () => {
  it('builds the FleetAi target value and only re-emits on change', () => {
    const tracker = createAisTracker(SELF)
    expect(tracker.ingest(selfDelta('navigation.log', 1), 0)).toBe(false)
    expect(
      tracker.ingest(aisDelta('244630000', [{ path: 'name', value: 'CARGO SHIP' }]), 1000)
    ).toBe(true)
    expect(tracker.drain(1000, 600_000)).toEqual([]) // no position yet

    tracker.ingest(
      aisDelta('244630000', [
        { path: 'navigation.position', value: { latitude: 43.29, longitude: 5.37 } },
        { path: 'navigation.speedOverGround', value: 3.5 },
        { path: 'navigation.courseOverGroundTrue', value: 1.2 },
        { path: 'design.aisShipType', value: { id: 70, name: 'Cargo' } },
        { path: 'navigation.closestApproach', value: { distance: 800, timeTo: 600 } },
      ]),
      2000
    )
    expect(tracker.drain(2000, 600_000)).toEqual([
      {
        mmsi: '244630000',
        value: {
          name: 'CARGO SHIP',
          latitude: 43.29,
          longitude: 5.37,
          sogMs: 3.5,
          cogRad: 1.2,
          shipType: 70,
          shipTypeName: 'Cargo',
          cpaM: 800,
          tcpaS: 600,
        },
      },
    ])
    expect(tracker.drain(3000, 600_000)).toEqual([])

    tracker.ingest(aisDelta('244630000', [{ path: 'navigation.speedOverGround', value: 4 }]), 4000)
    expect(tracker.drain(4000, 600_000)[0]?.value.sogMs).toBe(4)

    // Silent for more than the expiry: forgotten.
    expect(tracker.drain(4000 + 600_001, 600_000)).toEqual([])
    expect(tracker.size()).toBe(0)
  })
})
