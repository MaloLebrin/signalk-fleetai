import { chunkSamples, createAggregator } from './aggregator'
import { AIS_PATH_PREFIX, AIS_SPEC, extraPathMatcher, windowRule } from './catalog'
import { aisValueToJson, createAisTracker } from './ais_tracker'
import { normalizeDelta } from './normalizer'
import { createQueue, type Queue } from './queue'
import type { Sender, SendOutcome } from './sender'
import type { Delta, ResolvedConfig } from './types'

/**
 * The plugin's engine, independent from the Signal K server object so it can
 * be driven by tests: deltas in, HTTP batches out.
 *
 * Every `periodSeconds`: close the elapsed windows, enqueue them as batches of
 * at most 500 samples, then drain the queue **in order**. A failure keeps the
 * head batch and backs off exponentially (capped at 5 min, or `Retry-After`
 * on 429); a fatal answer (401/403/404/409) stops everything and shows why.
 */

export interface RuntimeLogger {
  debug: (message: string) => void
  error: (message: string) => void
}

export interface RuntimeStatus {
  setStatus: (message: string) => void
  setError: (message: string) => void
}

export interface RuntimeOptions {
  config: ResolvedConfig
  selfContext: string | null
  /** Path of the queue file (inside `app.getDataDirPath()`). */
  queueFilePath: string
  sender: Sender
  log: RuntimeLogger
  status: RuntimeStatus
  /** Called once on a fatal answer — the plugin unsubscribes and stops its timer. */
  onFatal?: (outcome: Extract<SendOutcome, { kind: 'fatal' }>) => void
  now?: () => number
  maxQueuedBatches?: number
  initialBackoffMs?: number
  maxBackoffMs?: number
}

export const INITIAL_BACKOFF_MS = 5_000
export const MAX_BACKOFF_MS = 5 * 60_000
/** A silent AIS target is forgotten after ten minutes. */
export const AIS_TARGET_EXPIRY_MS = 10 * 60_000

export interface RuntimeState {
  queued: number
  dropped: number
  fatal: boolean
  lastAcceptedAtMs: number | null
  nextAttemptAtMs: number | null
  backoffMs: number
  rejectedPaths: string[]
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

export function createRuntime(options: RuntimeOptions) {
  const now = options.now ?? (() => Date.now())
  const { config, sender, log, status } = options
  const initialBackoffMs = options.initialBackoffMs ?? INITIAL_BACKOFF_MS
  const maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS

  const aggregator = createAggregator()
  const ais = createAisTracker(options.selfContext)
  const isExtraPath = extraPathMatcher(config.paths)
  const rejectedPaths = new Set<string>()
  const queue: Queue = createQueue({
    filePath: options.queueFilePath,
    maxBatches: options.maxQueuedBatches,
    onError: (message) => log.error(message),
  })

  let fatal = false
  let draining = false
  let lastAcceptedAtMs: number | null = null
  let nextAttemptAtMs: number | null = null
  let backoffMs = initialBackoffMs
  let lastFailure: string | null = null

  function handleDelta(delta: Delta) {
    if (fatal) return
    const atMs = now()
    if (ais.ingest(delta, atMs)) return
    for (const sample of normalizeDelta(delta, {
      selfContext: options.selfContext,
      isExtraPath,
      isRejectedPath: (path) => rejectedPaths.has(path),
    })) {
      aggregator.push(
        sample.path,
        { value: sample.value, valueJson: sample.valueJson },
        windowRule(sample.spec, config.periodSeconds),
        atMs
      )
    }
  }

  /** Moves the AIS targets that changed into the aggregator (one sighting per window). */
  function collectAis(atMs: number) {
    const rule = windowRule(AIS_SPEC, config.periodSeconds)
    for (const { mmsi, value } of ais.drain(atMs, AIS_TARGET_EXPIRY_MS)) {
      const path = `${AIS_PATH_PREFIX}${mmsi}`
      if (rejectedPaths.has(path)) continue
      aggregator.push(path, { value: null, valueJson: aisValueToJson(value) }, rule, atMs)
    }
  }

  /** Closes elapsed windows and queues them. Returns how many batches were queued. */
  function collect(atMs: number, force = false): number {
    collectAis(atMs)
    const samples = aggregator.flush(atMs, { force })
    let count = 0
    for (const chunk of chunkSamples(samples)) count += queue.enqueue(chunk, atMs).length
    if (count > 0) log.debug(`queued ${count} batch(es), ${samples.length} sample(s)`)
    return count
  }

  function refreshStatus() {
    if (fatal) return
    const queued = queue.size()
    const atMs = now()
    if (queued > 0 && lastFailure !== null) {
      status.setStatus(
        `Waiting for network (${queued} batch${queued > 1 ? 'es' : ''} queued) — ${lastFailure}`
      )
      return
    }
    if (lastAcceptedAtMs !== null) {
      const suffix = queued > 0 ? ` — ${queued} queued` : ''
      status.setStatus(`Last batch accepted ${ago(atMs - lastAcceptedAtMs)}${suffix}`)
      return
    }
    status.setStatus(queued > 0 ? `Sending first batch (${queued} queued)` : 'Collecting readings')
  }

  async function drain(): Promise<void> {
    if (draining || fatal) return
    draining = true
    try {
      for (;;) {
        const head = queue.peek()
        if (head === null) break
        const atMs = now()
        if (nextAttemptAtMs !== null && atMs < nextAttemptAtMs) break

        const outcome = await sender.send({ batchId: head.batchId, samples: head.samples })
        if (outcome.kind === 'accepted') {
          queue.shift(head.batchId)
          lastAcceptedAtMs = now()
          nextAttemptAtMs = null
          backoffMs = initialBackoffMs
          lastFailure = null
          log.debug(
            `batch ${head.batchId} accepted (${outcome.accepted} new, ${outcome.ignored} replayed)`
          )
          continue
        }
        if (outcome.kind === 'retry') {
          const delay = outcome.retryAfterMs ?? backoffMs
          nextAttemptAtMs = now() + delay
          backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
          lastFailure = outcome.message
          log.debug(
            `batch ${head.batchId} not sent (${outcome.message}), retry in ${Math.round(delay / 1000)} s`
          )
          break
        }
        if (outcome.kind === 'fatal') {
          fatal = true
          const headline = outcome.error === 'unauthorized' ? 'Token rejected' : 'Stopped'
          status.setError(`${headline}: ${outcome.message}`)
          log.error(
            `${headline} (HTTP ${outcome.status} ${outcome.error}) — plugin stopped, ${queue.size()} batch(es) kept on disk`
          )
          options.onFatal?.(outcome)
          break
        }
        // drop: the batch itself is refused — log it in full and move on.
        if (outcome.path !== null) rejectedPaths.add(outcome.path)
        log.error(
          `batch ${head.batchId} refused (${outcome.message}) and abandoned: ${JSON.stringify(head.samples).slice(0, 4000)}`
        )
        queue.shift(head.batchId)
      }
    } finally {
      draining = false
      refreshStatus()
    }
  }

  /** One period: collect, then drain. */
  async function tick(): Promise<void> {
    if (fatal) return
    collect(now())
    await drain()
  }

  /** On stop: close every window and persist, without touching the network. */
  function stop() {
    if (!fatal) collect(now(), true)
  }

  function state(): RuntimeState {
    return {
      queued: queue.size(),
      dropped: queue.droppedCount(),
      fatal,
      lastAcceptedAtMs,
      nextAttemptAtMs,
      backoffMs,
      rejectedPaths: [...rejectedPaths],
    }
  }

  return { handleDelta, tick, drain, stop, state, collect, refreshStatus }
}

export type Runtime = ReturnType<typeof createRuntime>
