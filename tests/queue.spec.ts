import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createQueue } from '../src/queue'

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), 'fleetai-queue-')), 'nested', 'queue.json')
}

describe('queue — persistent, bounded, in order', () => {
  it('survives a restart with the same batch ids and order', () => {
    const filePath = tempFile()
    const queue = createQueue({ filePath })
    const [a] = queue.enqueue([{ path: 'navigation.log', recordedAt: 'a', value: 1 }], 0)
    const [b] = queue.enqueue([{ path: 'navigation.log', recordedAt: 'b', value: 2 }], 1000)
    expect(existsSync(filePath)).toBe(true)

    const reloaded = createQueue({ filePath })
    expect(reloaded.size()).toBe(2)
    expect(reloaded.all().map((batch) => batch.batchId)).toEqual([a!.batchId, b!.batchId])
    expect(reloaded.peek()?.samples[0]?.value).toBe(1)

    expect(reloaded.shift('not-the-head')).toBe(false)
    expect(reloaded.shift(a!.batchId)).toBe(true)
    expect(createQueue({ filePath }).peek()?.batchId).toBe(b!.batchId)
  })

  it('drops the oldest batches beyond the cap and counts them', () => {
    const queue = createQueue({ filePath: tempFile(), maxBatches: 3 })
    for (let i = 0; i < 5; i++) queue.enqueue([{ path: 'p', recordedAt: String(i), value: i }], i)
    expect(queue.size()).toBe(3)
    expect(queue.droppedCount()).toBe(2)
    expect(queue.all().map((batch) => batch.samples[0]?.value)).toEqual([2, 3, 4])
  })

  it('starts empty on a corrupt file and reports it, then overwrites it', () => {
    const filePath = tempFile()
    const errors: string[] = []
    writeFileSync(filePath.replace('/nested/queue.json', '/queue.json'), '{')
    const corrupt = filePath.replace('/nested/queue.json', '/queue.json')
    const queue = createQueue({ filePath: corrupt, onError: (m) => void errors.push(m) })
    expect(queue.size()).toBe(0)
    expect(errors[0]).toMatch(/unreadable/)
    queue.enqueue([{ path: 'p', recordedAt: 'x', value: 1 }], 0)
    expect(JSON.parse(readFileSync(corrupt, 'utf8')).batches).toHaveLength(1)
  })

  it('does not enqueue an empty batch', () => {
    const queue = createQueue({ filePath: tempFile() })
    expect(queue.enqueue([], 0)).toEqual([])
    expect(queue.size()).toBe(0)
  })
})
