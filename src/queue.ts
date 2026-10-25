import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BatchPayload, Sample } from './types'

/**
 * Persistent, bounded, in-order queue of batches waiting for FleetAi. Lives in
 * the plugin's data directory (`app.getDataDirPath()`), written atomically
 * (temp file + rename) so a power cut leaves either the old or the new file.
 * When full, the **oldest** batches are dropped: after weeks at sea it is the
 * recent history that matters.
 */

export interface QueuedBatch extends BatchPayload {
  /** ISO 8601 — when the batch was built (diagnostics only). */
  createdAt: string
}

interface QueueFile {
  version: 1
  batches: QueuedBatch[]
}

/** Default cap: a day of one-minute batches. */
export const DEFAULT_MAX_BATCHES = 1440

export interface QueueOptions {
  filePath: string
  maxBatches?: number
  /** Called when the file cannot be read or written (the queue keeps working in memory). */
  onError?: (message: string) => void
}

export function createQueue(options: QueueOptions) {
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES
  let batches: QueuedBatch[] = load()
  let dropped = 0

  function load(): QueuedBatch[] {
    try {
      const raw = readFileSync(options.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<QueueFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.batches)) return []
      return parsed.batches.filter(
        (batch): batch is QueuedBatch =>
          typeof batch === 'object' &&
          batch !== null &&
          typeof batch.batchId === 'string' &&
          Array.isArray(batch.samples)
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        options.onError?.(`queue file unreadable, starting empty: ${String(error)}`)
      }
      return []
    }
  }

  function persist() {
    const file: QueueFile = { version: 1, batches }
    const tmp = `${options.filePath}.tmp`
    try {
      mkdirSync(dirname(options.filePath), { recursive: true })
      writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 })
      renameSync(tmp, options.filePath)
    } catch (error) {
      options.onError?.(`queue file not written: ${String(error)}`)
    }
  }

  /** Appends one batch per chunk; returns the enqueued batches. */
  function enqueue(samples: Sample[], nowMs: number): QueuedBatch[] {
    if (samples.length === 0) return []
    const batch: QueuedBatch = {
      batchId: randomUUID(),
      samples,
      createdAt: new Date(nowMs).toISOString(),
    }
    batches.push(batch)
    if (batches.length > maxBatches) {
      const excess = batches.length - maxBatches
      batches = batches.slice(excess)
      dropped += excess
    }
    persist()
    return [batch]
  }

  function peek(): QueuedBatch | null {
    return batches[0] ?? null
  }

  /** Removes the head if it is still `batchId` (the batch was accepted or abandoned). */
  function shift(batchId: string): boolean {
    if (batches[0]?.batchId !== batchId) return false
    batches = batches.slice(1)
    persist()
    return true
  }

  /** Rewrites the head batch in place (e.g. after stripping a refused path). */
  function replaceHead(batch: QueuedBatch) {
    if (batches.length === 0) return
    batches = [batch, ...batches.slice(1)]
    persist()
  }

  function size(): number {
    return batches.length
  }

  function droppedCount(): number {
    return dropped
  }

  function all(): readonly QueuedBatch[] {
    return batches
  }

  return { enqueue, peek, shift, replaceHead, size, droppedCount, all }
}

export type Queue = ReturnType<typeof createQueue>
