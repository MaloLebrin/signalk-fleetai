import { join } from 'node:path'
import type { Context, Path, Plugin, ServerAPI, SubscriptionOptions } from '@signalk/server-api'
import { CONFIG_SCHEMA, CONFIG_UI_SCHEMA, resolveConfig } from './config'
import { createInventoryTracker } from './inventory'
import { createInventorySync } from './inventory_sync'
import { createRuntime, type Runtime } from './runtime'
import { createInventorySender, createSender } from './sender'
import { aisSubscriptions, selfSubscriptions, type SubscriptionEntry } from './subscriptions'
import type { Delta } from './types'

const PLUGIN_ID = 'signalk-fleetai'
const QUEUE_FILE = 'queue.json'
/** How often the inventory is re-evaluated; the once-a-minute send limit lives in the sync. */
const INVENTORY_CHECK_MS = 15_000
/** Raw NMEA 2000 messages decoded by the server (canboat), used when `sources` lacks metadata. */
const N2K_EVENT = 'N2KAnalyzerOut'

interface EventSource {
  on: (event: string, listener: (message: unknown) => void) => unknown
  removeListener: (event: string, listener: (message: unknown) => void) => unknown
}

/** `ServerAPI` does not type the server's event emitter; use it only when it is really there. */
function eventSource(app: unknown): EventSource | null {
  const candidate = app as Partial<EventSource> | null
  return typeof candidate?.on === 'function' && typeof candidate.removeListener === 'function'
    ? (candidate as EventSource)
    : null
}

/** The server API brands `Path` and `Context`; the catalog works with plain strings. */
function asSubscriptions(entries: SubscriptionEntry[]): SubscriptionOptions[] {
  return entries.map((entry) => ({ ...entry, path: entry.path as Path }) as SubscriptionOptions)
}

// Read at runtime so the version in User-Agent follows package.json.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PACKAGE_VERSION: string = (require('../package.json') as { version: string }).version

/**
 * Signal K plugin entry point. **Read-only**: the plugin subscribes to deltas
 * and never writes to the server (`handleMessage` is never called).
 */
export function createPlugin(app: ServerAPI): Plugin {
  let runtime: Runtime | null = null
  let timer: NodeJS.Timeout | null = null
  let inventoryTimer: NodeJS.Timeout | null = null
  let removePgnListener: (() => void) | null = null
  let unsubscribes: Array<() => void> = []

  function teardown() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (inventoryTimer !== null) {
      clearInterval(inventoryTimer)
      inventoryTimer = null
    }
    removePgnListener?.()
    removePgnListener = null
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe()
      } catch (error) {
        app.debug(`unsubscribe failed: ${String(error)}`)
      }
    }
    unsubscribes = []
  }

  return {
    id: PLUGIN_ID,
    name: 'FleetAi',
    description: 'Pushes onboard instrument readings and AIS targets to FleetAi.',
    schema: CONFIG_SCHEMA,
    uiSchema: CONFIG_UI_SCHEMA,

    start(rawConfig: object) {
      const resolved = resolveConfig(rawConfig)
      if (!resolved.ok) {
        app.setPluginError(resolved.error)
        return
      }
      const { config } = resolved
      const selfContext = typeof app.selfContext === 'string' ? app.selfContext : null

      const userAgent = `signalk-fleetai/${PACKAGE_VERSION}`
      const log = {
        debug: (message: string) => app.debug(message),
        error: (message: string) => app.error(message),
      }
      const tracker = createInventoryTracker({
        selfContext,
        hideSerialNumbers: config.hideSerialNumbers,
        readSources: () => app.getPath('sources'),
      })
      const inventorySync = createInventorySync({
        tracker,
        log,
        sender: createInventorySender({
          endpoint: config.inventoryEndpoint,
          token: config.token,
          userAgent,
        }),
      })

      runtime = createRuntime({
        config,
        inventory: { tracker, sync: inventorySync },
        selfContext,
        queueFilePath: join(app.getDataDirPath(), QUEUE_FILE),
        sender: createSender({
          endpoint: config.endpoint,
          token: config.token,
          userAgent,
        }),
        log,
        status: {
          setStatus: (message) => app.setPluginStatus(message),
          setError: (message) => app.setPluginError(message),
        },
        onFatal: () => teardown(),
      })
      const active = runtime

      const onDelta = (delta: Delta) => active.handleDelta(delta)
      const onError = (error: unknown) => app.error(`subscription error: ${String(error)}`)
      app.subscriptionmanager.subscribe(
        {
          context: 'vessels.self' as Context,
          subscribe: asSubscriptions(selfSubscriptions(config.periodSeconds, config.paths)),
        },
        unsubscribes,
        onError,
        onDelta
      )
      app.subscriptionmanager.subscribe(
        { context: 'vessels.*' as Context, subscribe: asSubscriptions(aisSubscriptions()) },
        unsubscribes,
        onError,
        onDelta
      )

      timer = setInterval(() => {
        void active.tick().catch((error) => app.error(`tick failed: ${String(error)}`))
      }, config.periodSeconds * 1000)
      const events = eventSource(app)
      if (events !== null) {
        const onPgn = (message: unknown) => active.handlePgn(message)
        events.on(N2K_EVENT, onPgn)
        removePgnListener = () => void events.removeListener(N2K_EVENT, onPgn)
      }
      inventoryTimer = setInterval(() => {
        void active
          .syncInventory()
          .catch((error) => app.error(`inventory sync failed: ${String(error)}`))
      }, INVENTORY_CHECK_MS)
      active.refreshStatus()
      app.debug(
        `started: endpoint=${config.endpoint} period=${config.periodSeconds}s queued=${active.state().queued}`
      )
      // Batches left over from a previous run go out right away.
      void active.drain().catch((error) => app.error(`drain failed: ${String(error)}`))
    },

    stop() {
      teardown()
      runtime?.stop()
      runtime = null
    },
  }
}

export default createPlugin
