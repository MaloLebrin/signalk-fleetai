import { join } from 'node:path'
import type { Context, Path, Plugin, ServerAPI, SubscriptionOptions } from '@signalk/server-api'
import { CONFIG_SCHEMA, CONFIG_UI_SCHEMA, resolveConfig } from './config'
import { createRuntime, type Runtime } from './runtime'
import { createSender } from './sender'
import { aisSubscriptions, selfSubscriptions, type SubscriptionEntry } from './subscriptions'
import type { Delta } from './types'

const PLUGIN_ID = 'signalk-fleetai'
const QUEUE_FILE = 'queue.json'

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
  let unsubscribes: Array<() => void> = []

  function teardown() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
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

      runtime = createRuntime({
        config,
        selfContext,
        queueFilePath: join(app.getDataDirPath(), QUEUE_FILE),
        sender: createSender({
          endpoint: config.endpoint,
          token: config.token,
          userAgent: `signalk-fleetai/${PACKAGE_VERSION}`,
        }),
        log: { debug: (message) => app.debug(message), error: (message) => app.error(message) },
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
