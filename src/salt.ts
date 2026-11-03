import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SALT_PATTERN = /^[0-9a-f]{32}$/

/**
 * The per-installation secret that keys the device-inventory hashes. Created
 * once (random, mode 600) next to the offline queue and kept across restarts,
 * so `deviceId`s stay stable; it never leaves the boat. If the file cannot be
 * written the plugin still works, with a salt that lasts until the next start.
 */
export function loadSalt(filePath: string, onError: (message: string) => void): string {
  try {
    const stored = readFileSync(filePath, 'utf8').trim()
    if (SALT_PATTERN.test(stored)) return stored
  } catch {
    // first start: created below
  }
  const salt = randomBytes(16).toString('hex')
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const temporary = `${filePath}.tmp`
    writeFileSync(temporary, `${salt}\n`, { mode: 0o600 })
    renameSync(temporary, filePath)
  } catch (error) {
    onError(
      `could not persist the inventory salt (${String(error)}): device ids will change at the next start`
    )
  }
  return salt
}
