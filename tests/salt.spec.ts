import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSalt } from '../src/salt'

describe('inventory salt', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'fleetai-salt-'))

  it('is created once, random, mode 600, and read back unchanged at the next start', () => {
    const file = join(dir(), 'inventory-salt')
    const errors: string[] = []
    const first = loadSalt(file, (m) => errors.push(m))
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(readFileSync(file, 'utf8').trim()).toBe(first)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(loadSalt(file, (m) => errors.push(m))).toBe(first)
    expect(errors).toEqual([])
    expect(loadSalt(join(dir(), 'inventory-salt'), () => {})).not.toBe(first)
  })

  it('replaces a corrupted file', () => {
    const file = join(dir(), 'inventory-salt')
    writeFileSync(file, 'not a salt')
    const salt = loadSalt(file, () => {})
    expect(salt).toMatch(/^[0-9a-f]{32}$/)
    expect(readFileSync(file, 'utf8').trim()).toBe(salt)
  })

  it('still returns a salt when the file cannot be written, and says so', () => {
    const errors: string[] = []
    const salt = loadSalt(join(dir(), 'inventory-salt', 'nested', '\0bad'), (m) => errors.push(m))
    expect(salt).toMatch(/^[0-9a-f]{32}$/)
    expect(errors[0]).toMatch(/could not persist the inventory salt/)
  })
})
