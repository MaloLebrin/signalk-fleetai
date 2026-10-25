import { describe, expect, it } from 'vitest'
import { catalogSpec, extraPathMatcher, PATH_CATALOG, wildcardPath } from '../src/catalog'
import { aisSubscriptions, selfSubscriptions } from '../src/subscriptions'

describe('catalog — closed allow-list', () => {
  it('accepts the FleetAi catalog paths and refuses the rest', () => {
    expect(catalogSpec('propulsion.port.revolutions')?.aggregate).toBe('mean')
    expect(catalogSpec('tanks.fuel.0.currentLevel')?.valueKind).toBe('number')
    expect(catalogSpec('environment.inside.engineRoom.temperature')).not.toBeNull()
    expect(catalogSpec('notifications.navigation.anchor')?.valueKind).toBe('json')
    expect(catalogSpec('navigation.position')?.valueKind).toBe('json')
    expect(catalogSpec('ais.244630000')?.valueKind).toBe('json')

    expect(catalogSpec('design.length')).toBeNull()
    expect(catalogSpec('navigation.attitude')).toBeNull()
    expect(catalogSpec('ais.12345')).toBeNull()
    expect(catalogSpec('propulsion.port')).toBeNull()
    expect(catalogSpec('propulsion.port.revolutions.extra')).toBeNull()
    expect(catalogSpec('a'.repeat(97))).toBeNull()
  })

  it('extra paths: exact or wildcard, never the empty list', () => {
    const matches = extraPathMatcher(['electrical.ac.*.voltage', 'steering.rudderAngle'])
    expect(matches('electrical.ac.shore.voltage')).toBe(true)
    expect(matches('steering.rudderAngle')).toBe(true)
    expect(matches('steering.autopilot.state')).toBe(false)
    expect(extraPathMatcher([])('anything')).toBe(false)
  })

  it('subscribes to one wildcard per catalog pattern plus AIS fields', () => {
    const self = selfSubscriptions(60, ['steering.rudderAngle'])
    expect(self).toHaveLength(PATH_CATALOG.length + 1)
    expect(self.map((s) => s.path)).toContain('propulsion.*.runTime')
    expect(self.find((s) => s.path === 'notifications.*')).toEqual({
      path: 'notifications.*',
      policy: 'instant',
      minPeriod: 0,
    })
    expect(self.find((s) => s.path === 'navigation.speedOverGround')).toEqual({
      path: 'navigation.speedOverGround',
      policy: 'fixed',
      period: 30_000,
    })
    expect(wildcardPath('environment.inside.<zone>.temperature')).toBe(
      'environment.inside.*.temperature'
    )
    expect(aisSubscriptions().map((s) => s.path)).toContain('navigation.closestApproach')
  })
})
