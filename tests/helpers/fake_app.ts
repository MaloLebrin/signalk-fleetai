import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Delta } from '../../src/types'

/** The slice of `ServerAPI` the plugin touches, with everything recorded. */
export function createFakeApp(
  selfContext = 'vessels.urn:mrn:imo:mmsi:227000001',
  sources: Record<string, unknown> = {}
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'signalk-fleetai-'))
  const statuses: string[] = []
  const errors: string[] = []
  const logs: string[] = []
  const subscriptions: Array<{
    command: { context: string; subscribe: unknown[] }
    callback: (delta: Delta) => void
  }> = []
  let unsubscribed = 0
  const listeners = new Map<string, Set<(message: unknown) => void>>()

  const debug = Object.assign((message: string) => void logs.push(message), { enabled: true })

  const app = {
    selfId: selfContext.replace('vessels.', ''),
    selfContext,
    getDataDirPath: () => dataDir,
    setPluginStatus: (message: string) => void statuses.push(message),
    setPluginError: (message: string) => void errors.push(message),
    debug,
    error: (message: string) => void logs.push(`ERROR ${message}`),
    getPath: (path: string) => (path === 'sources' ? sources : undefined),
    on(event: string, listener: (message: unknown) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
    },
    removeListener(event: string, listener: (message: unknown) => void) {
      listeners.get(event)?.delete(listener)
    },
    handleMessage: () => {
      throw new Error('the plugin must stay read-only')
    },
    subscriptionmanager: {
      subscribe(
        command: { context: string; subscribe: unknown[] },
        unsubscribes: Array<() => void>,
        _onError: (error: unknown) => void,
        callback: (delta: Delta) => void
      ) {
        subscriptions.push({ command, callback })
        unsubscribes.push(() => {
          unsubscribed += 1
        })
      },
      unsubscribe() {},
    },
  }

  /** Pushes a delta to every subscription whose context matches (`vessels.*` matches all). */
  function emit(delta: Delta) {
    for (const subscription of subscriptions) {
      const context = subscription.command.context
      const matchesSelf =
        context === 'vessels.self' &&
        (!delta.context || delta.context === selfContext || delta.context === 'vessels.self')
      if (matchesSelf || context === 'vessels.*') subscription.callback(delta)
    }
  }

  /** A raw NMEA 2000 message as the server's `N2KAnalyzerOut` event carries it. */
  function emitPgn(message: unknown) {
    for (const listener of listeners.get('N2KAnalyzerOut') ?? []) listener(message)
  }

  return {
    app,
    sources,
    emitPgn,
    pgnListenerCount: () => listeners.get('N2KAnalyzerOut')?.size ?? 0,
    dataDir,
    statuses,
    errors,
    logs,
    subscriptions,
    emit,
    unsubscribedCount: () => unsubscribed,
  }
}

export type FakeApp = ReturnType<typeof createFakeApp>
