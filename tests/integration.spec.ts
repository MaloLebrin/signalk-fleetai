import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlugin as plugin } from '../src/plugin'
import { createFakeApp } from './helpers/fake_app'
import { startFakeFleetAi } from './helpers/fake_fleetai'
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

  it('refuses to start without a token and says so', () => {
    const fake = createFakeApp(SELF)
    const instance = plugin(fake.app as unknown as ServerAPI)
    instance.start({ endpoint: 'https://fleetai.app/api/instruments/ingest' }, () => {})
    expect(fake.errors[0]).toMatch(/No ingestion token/)
    expect(fake.subscriptions).toHaveLength(0)
  })
})
