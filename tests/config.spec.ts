import { describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA, DEFAULT_ENDPOINT, resolveConfig } from '../src/config'

describe('config — what the install script and the admin UI write', () => {
  it('reads the install-script file shape and applies defaults', () => {
    const result = resolveConfig({
      endpoint: 'https://fleetai.app/api/instruments/ingest',
      token: 'fai_ing_abc',
      periodSeconds: 60,
    })
    expect(result).toEqual({
      ok: true,
      config: {
        endpoint: 'https://fleetai.app/api/instruments/ingest',
        token: 'fai_ing_abc',
        periodSeconds: 60,
        paths: [],
      },
    })
    expect(resolveConfig({ token: 'fai_ing_abc' })).toMatchObject({
      ok: true,
      config: { endpoint: DEFAULT_ENDPOINT, periodSeconds: 60 },
    })
    expect(CONFIG_SCHEMA.properties.endpoint.default).toBe(DEFAULT_ENDPOINT)
    expect(CONFIG_SCHEMA.properties.periodSeconds.minimum).toBe(10)
  })

  it('clamps the period and trims the extra paths', () => {
    expect(resolveConfig({ token: 'fai_ing_abc', periodSeconds: 3 })).toMatchObject({
      ok: true,
      config: { periodSeconds: 10 },
    })
    expect(resolveConfig({ token: 'fai_ing_abc', periodSeconds: 99999 })).toMatchObject({
      ok: true,
      config: { periodSeconds: 3600 },
    })
    expect(
      resolveConfig({ token: 'fai_ing_abc', paths: [' steering.rudderAngle ', '', 3] })
    ).toMatchObject({ ok: true, config: { paths: ['steering.rudderAngle'] } })
  })

  it('refuses a missing or malformed token and a bad endpoint, with a readable reason', () => {
    expect(resolveConfig({})).toMatchObject({
      ok: false,
      error: expect.stringMatching(/No ingestion token/),
    })
    expect(resolveConfig({ token: 'abc' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/fai_ing_/),
    })
    expect(resolveConfig({ token: 'fai_ing_abc', endpoint: 'not a url' })).toMatchObject({
      ok: false,
    })
    expect(resolveConfig({ token: 'fai_ing_abc', endpoint: 'ftp://x' })).toMatchObject({
      ok: false,
    })
    expect(resolveConfig(null)).toMatchObject({ ok: false })
  })
})
