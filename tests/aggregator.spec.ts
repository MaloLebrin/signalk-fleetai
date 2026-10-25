import { describe, expect, it } from 'vitest'
import { chunkSamples, createAggregator, MAX_BATCH_SIZE } from '../src/aggregator'
import { catalogSpec, windowRule } from '../src/catalog'
import type { Sample } from '../src/types'

const T0 = Date.parse('2026-10-25T10:00:00.000Z')

function rule(path: string, periodSeconds = 60) {
  return windowRule(catalogSpec(path)!, periodSeconds)
}

describe('aggregator — one value per path and per window', () => {
  it('floors recordedAt to the window start and averages a mean path', () => {
    const aggregator = createAggregator()
    const r = rule('navigation.speedOverGround') // 30 s in the catalog, 60 s floor → 60 s
    aggregator.push('navigation.speedOverGround', { value: 2, valueJson: null }, r, T0 + 5_000)
    aggregator.push('navigation.speedOverGround', { value: 4, valueJson: null }, r, T0 + 20_000)

    expect(aggregator.flush(T0 + 30_000)).toEqual([]) // window still open
    expect(aggregator.flush(T0 + 60_000)).toEqual([
      { path: 'navigation.speedOverGround', recordedAt: '2026-10-25T10:00:00.000Z', value: 3 },
    ])
  })

  it('keeps max / last according to the catalog rule', () => {
    const aggregator = createAggregator()
    aggregator.push(
      'propulsion.port.temperature',
      { value: 350, valueJson: null },
      rule('propulsion.port.temperature'),
      T0
    )
    aggregator.push(
      'propulsion.port.temperature',
      { value: 340, valueJson: null },
      rule('propulsion.port.temperature'),
      T0 + 1000
    )
    aggregator.push(
      'navigation.headingTrue',
      { value: 1, valueJson: null },
      rule('navigation.headingTrue'),
      T0
    )
    aggregator.push(
      'navigation.headingTrue',
      { value: 2, valueJson: null },
      rule('navigation.headingTrue'),
      T0 + 1000
    )

    const samples = aggregator.flush(T0 + 60_000)
    expect(samples.find((s) => s.path === 'propulsion.port.temperature')?.value).toBe(350)
    expect(samples.find((s) => s.path === 'navigation.headingTrue')?.value).toBe(2)
  })

  it('a new window closes the previous one even before flush', () => {
    const aggregator = createAggregator()
    const r = rule('electrical.batteries.house.voltage')
    aggregator.push('electrical.batteries.house.voltage', { value: 12.6, valueJson: null }, r, T0)
    aggregator.push(
      'electrical.batteries.house.voltage',
      { value: 12.4, valueJson: null },
      r,
      T0 + 61_000
    )

    const samples = aggregator.flush(T0 + 61_000)
    expect(samples).toEqual([
      {
        path: 'electrical.batteries.house.voltage',
        recordedAt: '2026-10-25T10:00:00.000Z',
        value: 12.6,
      },
    ])
    expect(aggregator.flush(T0 + 120_000)).toHaveLength(1)
  })

  it('slower catalog cadences are kept slower than periodSeconds', () => {
    expect(rule('propulsion.port.runTime', 10).windowMs).toBe(300_000)
    expect(rule('tanks.fuel.0.capacity', 60).windowMs).toBe(3_600_000)
    expect(rule('navigation.speedOverGround', 10).windowMs).toBe(30_000)
    expect(rule('navigation.speedOverGround', 120).windowMs).toBe(120_000)
  })

  it('structured values keep the last one; alarms go out at the next tick', () => {
    const aggregator = createAggregator()
    const position = rule('navigation.position')
    aggregator.push(
      'navigation.position',
      { value: null, valueJson: { latitude: 43.1, longitude: 5.1 } },
      position,
      T0
    )
    aggregator.push(
      'navigation.position',
      { value: null, valueJson: { latitude: 43.2, longitude: 5.2 } },
      position,
      T0 + 10_000
    )
    const alarm = rule('notifications.mob')
    expect(alarm.windowMs).toBe(1000)
    aggregator.push(
      'notifications.mob',
      { value: null, valueJson: { state: 'emergency', message: null, method: [] } },
      alarm,
      T0 + 500
    )

    const samples = aggregator.flush(T0 + 60_000)
    expect(samples).toContainEqual({
      path: 'navigation.position',
      recordedAt: '2026-10-25T10:00:00.000Z',
      valueJson: { latitude: 43.2, longitude: 5.2 },
    })
    expect(samples).toContainEqual({
      path: 'notifications.mob',
      recordedAt: '2026-10-25T10:00:00.000Z',
      valueJson: { state: 'emergency', message: null, method: [] },
    })
  })

  it('force flushes the open windows (plugin stop)', () => {
    const aggregator = createAggregator()
    aggregator.push('navigation.log', { value: 1000, valueJson: null }, rule('navigation.log'), T0)
    expect(aggregator.flush(T0 + 1000)).toEqual([])
    expect(aggregator.flush(T0 + 1000, { force: true })).toHaveLength(1)
    expect(aggregator.size()).toBe(0)
  })
})

describe('chunkSamples — batches of at most 500', () => {
  it('splits 1201 samples into 500 + 500 + 201, in order', () => {
    const samples: Sample[] = Array.from({ length: 1201 }, (_, i) => ({
      path: `p.${i}`,
      recordedAt: 'x',
      value: i,
    }))
    const chunks = chunkSamples(samples)
    expect(chunks.map((c) => c.length)).toEqual([MAX_BATCH_SIZE, MAX_BATCH_SIZE, 201])
    expect(chunks[2]![0]!.value).toBe(1000)
    expect(chunkSamples([])).toEqual([])
  })
})
