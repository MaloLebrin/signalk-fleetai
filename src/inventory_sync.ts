import type { InventoryTracker } from './inventory'
import type { InventorySender, InventorySendOutcome } from './sender'

/**
 * Decides **when** the inventory goes out: once devices are known, then on
 * every change (appearance, disappearance after ten minutes, new path), never
 * more than once a minute. The body is always the full state.
 *
 * Failures follow the batch rules: network / 5xx / 429 back off and retry the
 * same state, and a refused state (422) is not sent again until it changes.
 *
 * A fatal answer (401/403/404/409) switches **only the inventory** off for the
 * session: it is a secondary feature (an older FleetAi without the route, a
 * token that lacks it…) and must never stop the readings. A genuinely revoked
 * token is caught by the next batch, which stops the plugin as usual.
 */

export const MIN_SEND_INTERVAL_MS = 60_000
export const INVENTORY_INITIAL_BACKOFF_MS = 60_000
export const INVENTORY_MAX_BACKOFF_MS = 5 * 60_000

export interface InventorySyncOptions {
  tracker: InventoryTracker
  sender: InventorySender
  /** Never receives serial numbers: only counts, ids and error codes. */
  log: { debug: (message: string) => void; error: (message: string) => void }
  now?: () => number
}

export type InventorySyncResult =
  | { kind: 'idle' }
  | { kind: 'sent'; created: number; updated: number; gone: number }
  | { kind: 'deferred'; message: string }
  | { kind: 'refused'; message: string }
  | { kind: 'fatal'; outcome: Extract<InventorySendOutcome, { kind: 'fatal' }> }

export function createInventorySync(options: InventorySyncOptions) {
  const now = options.now ?? (() => Date.now())
  const { tracker, sender, log } = options

  let lastSentSignature: string | null = null
  let refusedSignature: string | null = null
  let lastAttemptAtMs: number | null = null
  let nextAttemptAtMs: number | null = null
  let backoffMs = INVENTORY_INITIAL_BACKOFF_MS
  let sending = false
  let disabled = false

  async function run(): Promise<InventorySyncResult> {
    if (sending || disabled) return { kind: 'idle' }
    const atMs = now()
    const { payload, signature } = tracker.snapshot(atMs)

    // Nothing to announce yet: an empty first lot would only be noise.
    if (lastSentSignature === null && payload.devices.length === 0) return { kind: 'idle' }
    if (signature === lastSentSignature || signature === refusedSignature) return { kind: 'idle' }
    if (lastAttemptAtMs !== null && atMs - lastAttemptAtMs < MIN_SEND_INTERVAL_MS) {
      return { kind: 'idle' }
    }
    if (nextAttemptAtMs !== null && atMs < nextAttemptAtMs) return { kind: 'idle' }

    sending = true
    lastAttemptAtMs = atMs
    try {
      const outcome = await sender.send(payload)
      switch (outcome.kind) {
        case 'accepted':
          lastSentSignature = signature
          refusedSignature = null
          nextAttemptAtMs = null
          backoffMs = INVENTORY_INITIAL_BACKOFF_MS
          log.debug(
            `inventory sent (${payload.devices.length} device(s): ${outcome.created} new, ${outcome.updated} updated, ${outcome.gone} gone)`
          )
          return {
            kind: 'sent',
            created: outcome.created,
            updated: outcome.updated,
            gone: outcome.gone,
          }
        case 'retry': {
          const delay = outcome.retryAfterMs ?? backoffMs
          nextAttemptAtMs = now() + delay
          backoffMs = Math.min(backoffMs * 2, INVENTORY_MAX_BACKOFF_MS)
          log.debug(
            `inventory not sent (${outcome.message}), retry in ${Math.round(delay / 1000)} s`
          )
          return { kind: 'deferred', message: outcome.message }
        }
        case 'fatal':
          // Reported once; the inventory then stays off for this session.
          disabled = true
          return { kind: 'fatal', outcome }
        case 'drop':
          refusedSignature = signature
          log.error(
            `inventory refused (${outcome.message}) — not sent again until the device list changes`
          )
          return { kind: 'refused', message: outcome.message }
      }
    } finally {
      sending = false
    }
  }

  return {
    run,
    state: () => ({ lastSentSignature, refusedSignature, lastAttemptAtMs, nextAttemptAtMs }),
  }
}

export type InventorySync = ReturnType<typeof createInventorySync>
