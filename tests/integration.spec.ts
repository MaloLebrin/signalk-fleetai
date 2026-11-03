import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlugin as plugin } from '../src/plugin'
import { createFakeApp } from './helpers/fake_app'
import { startFakeFleetAi } from './helpers/fake_fleetai'
import { BOAT_DELTAS, sourcesTree } from './helpers/inventory'
import { aisDelta, selfDelta } from './helpers/runtime'
import type { Plugin, ServerAPI } from '@signalk/server-api'

/**
 * End to end: the real plugin entry point, a fake Signal K `app`, and a real
 * HTTP endpoint that mimics `POST /api/instruments/ingest`. Timers are driven
 * by the plugin itself (`periodSeconds` is clamped to 10 s, so we flush by
 * stopping the plugin and starting it again).
 */

const SELF = 'vessels.urn:mrn:imo:mmsi:227000001'

async function flushPromises() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('integration — plugin against a fake FleetAi endpoint', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  it('subscribes read-only, queues on stop, and pushes the batch with the token on the next start', async () => {
    const fleetai = await startFakeFleetAi()
    cleanups.push(fleetai.close)
    const fake = createFakeApp(SELF)
    const instance: Plugin = plugin(fake.app as unknown as ServerAPI)
    expect(instance.id).toBe('signalk-fleetai')
    expect(instance.schema).toMatchObject({
      properties: { endpoint: {}, token: {}, periodSeconds: {}, paths: {} },
    })

    instance.start(
      { endpoint: fleetai.url, token: 'fai_ing_integration', periodSeconds: 60 },
      () => {}
    )
    cleanups.push(() => void instance.stop())
    expect(fake.subscriptions.map((s) => s.command.context)).toEqual(['vessels.self', 'vessels.*'])
    expect(fake.errors).toEqual([])
    expect(fake.statuses.at(-1)).toBe('Collecting readings')

    fake.emit(selfDelta('navigation.speedOverGround', 3.25, SELF))
    fake.emit(selfDelta('propulsion.port.revolutions', 41.6667, SELF))
    fake.emit(selfDelta('navigation.position', { latitude: 43.29, longitude: 5.37 }, SELF))
    fake.emit(selfDelta('design.length', 12, SELF))
    fake.emit(
      aisDelta('244630000', [
        { path: 'navigation.position', value: { latitude: 43.3, longitude: 5.4 } },
        { path: 'navigation.speedOverGround', value: 3.5 },
      ])
    )
    // The vessel itself also shows up under `vessels.*`: it must not become an AIS target.
    fake.emit({
      context: SELF,
      updates: [
        { values: [{ path: 'navigation.position', value: { latitude: 43.29, longitude: 5.37 } }] },
      ],
    })

    // Stop: windows are force-closed and persisted, nothing is sent.
    await instance.stop()
    expect(fleetai.received).toHaveLength(0)
    expect(existsSync(join(fake.dataDir, 'queue.json'))).toBe(true)
    expect(fake.unsubscribedCount()).toBe(2)

    // Next start drains the queue right away.
    instance.start(
      { endpoint: fleetai.url, token: 'fai_ing_integration', periodSeconds: 60 },
      () => {}
    )
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(fleetai.received).toHaveLength(1)
    const request = fleetai.received[0]!
    expect(request.authorization).toBe('Bearer fai_ing_integration')
    expect(request.contentType).toBe('application/json')
    expect(request.userAgent).toMatch(/^signalk-fleetai\/\d+\.\d+\.\d+/)
    expect(request.body.batchId).toMatch(/^[0-9a-f-]{36}$/)
    expect(request.body.sourceId).toBeUndefined()
    const paths = request.body.samples!.map((s) => s.path).sort()
    expect(paths).toEqual([
      'ais.244630000',
      'navigation.position',
      'navigation.speedOverGround',
      'propulsion.port.revolutions',
    ])
    expect(request.body.samples!.find((s) => s.path === 'ais.244630000')!.valueJson).toMatchObject({
      latitude: 43.3,
      longitude: 5.4,
      sogMs: 3.5,
    })
    expect(
      request.body.samples!.every((s) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(s.recordedAt))
      )
    ).toBe(true)
    expect(fake.statuses.at(-1)).toBe('Last batch accepted just now')
  })

  it('a revoked token puts the plugin in error without looping', async () => {
    const fleetai = await startFakeFleetAi(() => ({
      status: 401,
      body: { error: 'unauthorized' },
      headers: { 'www-authenticate': 'Bearer' },
    }))
    cleanups.push(fleetai.close)
    const fake = createFakeApp(SELF)
    const instance = plugin(fake.app as unknown as ServerAPI)
    instance.start({ endpoint: fleetai.url, token: 'fai_ing_revoked' }, () => {})
    cleanups.push(() => void instance.stop())
    fake.emit(selfDelta('navigation.log', 1000, SELF))
    await instance.stop()

    instance.start({ endpoint: fleetai.url, token: 'fai_ing_revoked' }, () => {})
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fleetai.received).toHaveLength(1)
    expect(fake.errors.at(-1)).toMatch(/^Token rejected/)
    expect(fake.unsubscribedCount()).toBe(4) // the fatal answer unsubscribed the second run too

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fleetai.received).toHaveLength(1)
  })

  describe('device inventory', () => {
    afterEach(() => vi.useRealTimers())

    it('posts the inventory to /inventory with the token, then only on change', async () => {
      const fleetai = await startFakeFleetAi((batch) =>
        batch.path.endsWith('/inventory')
          ? { status: 201, body: { created: 4, updated: 0, gone: 0 } }
          : { status: 200 }
      )
      cleanups.push(fleetai.close)
      const fake = createFakeApp(SELF, sourcesTree())
      const instance = plugin(fake.app as unknown as ServerAPI)
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      instance.start(
        { endpoint: fleetai.url, token: 'fai_ing_inv', hideSerialNumbers: true },
        () => {}
      )
      cleanups.push(() => void instance.stop())
      for (const delta of BOAT_DELTAS) fake.emit(delta)

      await vi.advanceTimersByTimeAsync(15_000)
      await vi.waitFor(() => expect(fleetai.received).toHaveLength(1))
      const request = fleetai.received[0]!
      expect(request.path).toBe('/api/instruments/inventory')
      expect(request.authorization).toBe('Bearer fai_ing_inv')
      expect(request.userAgent).toMatch(/^signalk-fleetai\//)
      const devices = (request.body as unknown as { devices: Array<Record<string, unknown>> })
        .devices
      expect(devices).toHaveLength(4)
      expect(JSON.stringify(devices)).not.toContain('SN-0042') // "hide" is on
      expect(devices.find((d) => d.address === 12)!.serialNumber).toMatch(/^h:[0-9a-f]{8}$/)

      // Nothing changed: the next checks stay silent.
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(fleetai.received.filter((r) => r.path.endsWith('/inventory'))).toHaveLength(1)

      // A new path on a known device: re-announced.
      fake.emit({
        context: SELF,
        updates: [
          {
            $source: 'can0.34',
            values: [{ path: 'electrical.batteries.house.current', value: 4 }],
          },
        ],
      })
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.waitFor(() =>
        expect(fleetai.received.filter((r) => r.path.endsWith('/inventory'))).toHaveLength(2)
      )
    })

    it('falls back on PGN 126996 / 60928 when sources has no metadata, and stops listening on stop', async () => {
      const fleetai = await startFakeFleetAi(() => ({ status: 201, body: {} }))
      cleanups.push(fleetai.close)
      const fake = createFakeApp(SELF, { can0: { type: 'NMEA2000' } })
      const instance = plugin(fake.app as unknown as ServerAPI)
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      instance.start({ endpoint: fleetai.url, token: 'fai_ing_inv' }, () => {})
      expect(fake.pgnListenerCount()).toBe(1)

      fake.emit({
        context: SELF,
        updates: [
          { $source: 'can0.41', values: [{ path: 'tanks.fuel.0.currentLevel', value: 0.5 }] },
        ],
      })
      fake.emitPgn({ pgn: 126996, src: 41, fields: { 'Model ID': 'TLM100' } })
      fake.emitPgn({ pgn: 60928, src: 41, fields: { 'Manufacturer Code': 'Maretron' } })
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.waitFor(() => expect(fleetai.received).toHaveLength(1))
      expect(fleetai.received[0]!.body).toMatchObject({
        devices: [
          {
            label: 'Maretron TLM100',
            model: 'TLM100',
            address: 41,
            paths: ['tanks.fuel.0.currentLevel'],
          },
        ],
      })

      await instance.stop()
      expect(fake.pgnListenerCount()).toBe(0)
    })

    it('an inventory refused by FleetAi (404, 403, 409…) switches only the inventory off: readings keep flowing', async () => {
      const fleetai = await startFakeFleetAi((batch) =>
        batch.path.endsWith('/inventory')
          ? { status: 404, body: { error: 'source_not_found' } }
          : { status: 200 }
      )
      cleanups.push(fleetai.close)
      const fake = createFakeApp(SELF, sourcesTree())
      const instance = plugin(fake.app as unknown as ServerAPI)
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      instance.start({ endpoint: fleetai.url, token: 'fai_ing_x', periodSeconds: 60 }, () => {})
      cleanups.push(() => void instance.stop())
      fake.emit(BOAT_DELTAS[0]!)

      await vi.advanceTimersByTimeAsync(15_000)
      await vi.waitFor(() =>
        expect(fake.logs.some((line) => line.includes('Device inventory disabled'))).toBe(true)
      )
      expect(fake.errors).toEqual([]) // not a plugin error: the readings are fine
      expect(fake.unsubscribedCount()).toBe(0) // still subscribed

      fake.emit(selfDelta('navigation.log', 1000, SELF))
      await vi.advanceTimersByTimeAsync(120_000)
      await vi.waitFor(() =>
        expect(fleetai.received.filter((r) => r.path.endsWith('/ingest')).length).toBeGreaterThan(0)
      )
      // One inventory request, then silence for the rest of the session.
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      expect(fleetai.received.filter((r) => r.path.endsWith('/inventory'))).toHaveLength(1)
      expect(fake.errors).toEqual([])
    })
  })

  it('refuses to start without a token and says so', () => {
    const fake = createFakeApp(SELF)
    const instance = plugin(fake.app as unknown as ServerAPI)
    instance.start({ endpoint: 'https://fleetai.app/api/instruments/ingest' }, () => {})
    expect(fake.errors[0]).toMatch(/No ingestion token/)
    expect(fake.subscriptions).toHaveLength(0)
  })
})
