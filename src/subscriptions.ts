import { AIS_SUBSCRIBED_PATHS } from './ais_tracker'
import { PATH_CATALOG, wildcardPath } from './catalog'

/** One Signal K subscription entry (`SubscriptionOptions` in `@signalk/server-api`). */
export type SubscriptionEntry =
  | { path: string; policy: 'fixed'; period: number }
  | { path: string; policy: 'instant'; minPeriod: number }

/**
 * `vessels.self` subscriptions: one per catalog pattern plus the extra paths.
 * `fixed` with half the window already brings the server's rate down to what
 * is kept; alarms stay `instant`.
 */
export function selfSubscriptions(
  periodSeconds: number,
  extraPaths: readonly string[]
): SubscriptionEntry[] {
  const entries: SubscriptionEntry[] = PATH_CATALOG.map((spec) => {
    if (spec.intervalS === 0)
      return { path: wildcardPath(spec.pattern), policy: 'instant', minPeriod: 0 }
    const windowS = Math.max(spec.intervalS, periodSeconds)
    return {
      path: wildcardPath(spec.pattern),
      policy: 'fixed',
      period: Math.max(1000, Math.round((windowS * 1000) / 2)),
    }
  })
  for (const path of extraPaths) {
    entries.push({
      path,
      policy: 'fixed',
      period: Math.max(1000, Math.round((periodSeconds * 1000) / 2)),
    })
  }
  return entries
}

/** `vessels.*` subscriptions for AIS targets: the server throttles per target. */
export function aisSubscriptions(): SubscriptionEntry[] {
  return AIS_SUBSCRIBED_PATHS.map((path) => ({ path, policy: 'fixed', period: 5000 }))
}
