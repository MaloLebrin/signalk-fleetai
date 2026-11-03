import { createHash, createHmac } from 'node:crypto'
import { AIS_PATH_PREFIX, catalogSpec } from './catalog'
import { isSelfDelta } from './normalizer'
import type { Delta } from './types'

/**
 * Device inventory (`POST /api/instruments/inventory`): which boxes of the
 * boat's buses feed the FleetAi catalog, and which catalog paths each one
 * provides. Pure state, no I/O — the Signal K `sources` tree and the raw PGNs
 * are handed in by the plugin.
 *
 * Presence is **observed activity**: a device exists while one of its deltas
 * (catalog path) was seen in the last ten minutes. The `sources` tree and the
 * PGNs 126996 / 60928 only supply metadata — the tree also lists every device
 * ever seen on the bus, and a PGN carries no connection name.
 */

export type InventoryBus = 'n2k' | 'nmea0183' | 'other'

/** Mirrors `InstrumentInventoryDevicePayload` in FleetAi (`shared/types/instruments.ts`). */
export interface InventoryDevice {
  deviceId: string
  label: string
  manufacturer?: string | null
  model?: string | null
  serialNumber?: string | null
  function?: string | null
  bus: InventoryBus
  address?: number | null
  paths: string[]
}

export interface InventoryPayload {
  devices: InventoryDevice[]
}

/** A device silent for longer than this leaves the inventory (FleetAi applies the same grace). */
export const DEVICE_GONE_AFTER_MS = 10 * 60_000
/** FleetAi limits (`INSTRUMENT_INVENTORY_MAX_*`). */
export const MAX_DEVICES = 64
export const MAX_PATHS_PER_DEVICE = 100
export const TEXT_MAX_LENGTH = 120
export const DEVICE_ID_MAX_LENGTH = 64
/** A device without any identity is held back this long, waiting for its metadata (stable `deviceId`). */
export const IDENTITY_SETTLE_MS = 2 * 60_000
/** The `sources` tree is re-read at most this often on the delta path. */
export const SOURCES_CACHE_MS = 5_000

export interface InventorySnapshot {
  payload: InventoryPayload
  /** Stable text form of the payload — equal signatures mean "nothing changed". */
  signature: string
}

export interface InventoryTrackerOptions {
  selfContext: string | null
  /** Returns the Signal K `sources` tree (may throw or return anything: it is read defensively). */
  readSources: () => unknown
  /** Send a hash of the serial number instead of the serial number itself. */
  hideSerialNumbers: boolean
  /**
   * Secret, per installation (see `loadSalt`): keys the hashes so that a serial
   * number cannot be recovered by enumeration nor correlated between boats.
   */
  salt: string
}

interface Metadata {
  manufacturer: string | null
  model: string | null
  serialNumber: string | null
  function: string | null
}

interface Observed {
  key: string
  bus: InventoryBus
  connection: string
  /** NMEA 2000 source address. */
  src: number | null
  sentences: Set<string>
  paths: Set<string>
  firstSeenMs: number
  lastSeenMs: number
}

interface PgnInfo extends Partial<Metadata> {
  lastSeenMs: number
}

type Tree = Record<string, unknown>

function isRecord(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Cuts at `max` UTF-16 units (what FleetAi counts) without splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  let length = 0
  let out = ''
  for (const char of text) {
    if (length + char.length > max) break
    out += char
    length += char.length
  }
  return out
}

/** Printable single-line text FleetAi accepts (`PLAIN_TEXT`: no control, format or lone-surrogate characters). */
export function cleanText(value: unknown): string | null {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value
  if (typeof raw !== 'string') return null
  const text = truncate(
    raw
      .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    TEXT_MAX_LENGTH
  ).trim()
  return text === '' ? null : text
}

/** `parent[key]` when it is an object, else `undefined`. */
function child(parent: Tree | undefined, key: string | null): Tree | undefined {
  const value = parent && key !== null ? parent[key] : undefined
  return isRecord(value) ? value : undefined
}

function firstText(source: Tree | undefined, ...keys: string[]): string | null {
  if (!source) return null
  for (const key of keys) {
    const text = cleanText(source[key])
    if (text !== null) return text
  }
  return null
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function hmacHex(salt: string, input: string): string {
  return createHmac('sha256', salt).update(input).digest('hex')
}

/** `h:` + 8 hex of a keyed hash — what is sent instead of the serial number when it is hidden. */
export function hashSerial(serial: string, salt: string): string {
  return `h:${hmacHex(salt, `serial|${serial.trim().toLowerCase()}`).slice(0, 8)}`
}

/**
 * Stable fingerprint of a NMEA 2000 device: manufacturer + model + serial,
 * keyed-hashed (16 hex), so the id survives an address change and cannot be
 * turned back into the serial number. Without a serial number nothing tells
 * two identical devices apart but their place on the bus, so `placeOnBus`
 * (connection + address) joins the hash — decided per device, never by looking
 * at the others, so one device appearing never changes another's id.
 */
export function n2kDeviceId(
  identity: {
    manufacturer: string | null
    model: string | null
    serialNumber: string | null
    placeOnBus: string
  },
  salt: string,
  forcePlace = false
): string {
  const [manufacturer, model, serial] = [
    identity.manufacturer,
    identity.model,
    identity.serialNumber,
  ].map((part) => (part ?? '').trim().toLowerCase())
  const material = [manufacturer, model, serial]
  if (serial === '' || forcePlace) material.push(`@${identity.placeOnBus}`)
  return `n2k-${hmacHex(salt, `n2k|${material.join('|')}`).slice(0, 16)}`
}

/** Readable when the connection name is already a valid id, otherwise slugged + short hash (no collision). */
export function nmea0183DeviceId(connection: string): string {
  const prefix = 'nmea0183-'
  const room = DEVICE_ID_MAX_LENGTH - prefix.length
  if (connection.length <= room && /^[0-9A-Za-z][0-9A-Za-z_.-]*$/.test(connection)) {
    return `${prefix}${connection}`
  }
  const readable = connection
    .replace(/[^0-9A-Za-z_.-]+/g, '-')
    .replace(/^[^0-9A-Za-z]+/, '')
    .slice(0, room - 9)
  return `${prefix}${readable === '' ? 'x' : readable}-${sha256Hex(connection).slice(0, 8)}`
}

function parseAddress(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255 ? n : null
}

/** Field names of the canboat analyzer differ in case and spacing across versions. */
function pgnField(fields: Tree, ...names: string[]): unknown {
  const wanted = new Set(names.map((name) => name.replace(/[\s_]/g, '').toLowerCase()))
  for (const [key, value] of Object.entries(fields)) {
    if (wanted.has(key.replace(/[\s_]/g, '').toLowerCase())) return value
  }
  return undefined
}

export function createInventoryTracker(options: InventoryTrackerOptions) {
  const observed = new Map<string, Observed>()
  const pgn = new Map<number, PgnInfo>()

  let cachedTree: Tree = {}
  let cachedAtMs = -Infinity

  /** The `sources` tree, re-read at most every few seconds: it is walked on the delta hot path. */
  function readTree(atMs: number): Tree {
    if (atMs - cachedAtMs < SOURCES_CACHE_MS && atMs >= cachedAtMs) return cachedTree
    cachedAtMs = atMs
    try {
      const tree = options.readSources()
      cachedTree = isRecord(tree) ? tree : {}
    } catch {
      cachedTree = {}
    }
    return cachedTree
  }

  /** Which bus a delta source belongs to, from the delta itself then from the `sources` tree. */
  function resolveSource(
    update: NonNullable<Delta['updates']>[number],
    tree: () => Tree
  ): { bus: InventoryBus; connection: string; src: number | null; sentence: string | null } | null {
    const object = isRecord(update.source) ? update.source : null
    let connection: string | null = null
    let rest: string | null = null
    if (object && typeof object.label === 'string') {
      connection = object.label
      const id = object.src ?? object.talker
      rest = typeof id === 'string' || typeof id === 'number' ? String(id) : null
    } else if (typeof update.$source === 'string' && update.$source.includes('.')) {
      const dot = update.$source.indexOf('.')
      connection = update.$source.slice(0, dot)
      rest = update.$source.slice(dot + 1)
    }
    if (connection === null || connection === '') return null

    const sentence = object && typeof object.sentence === 'string' ? object.sentence : null
    const declared = object && typeof object.type === 'string' ? object.type.toUpperCase() : null
    let bus: InventoryBus | null = null
    // The delta says what it is: the tree is not needed.
    if (declared === 'NMEA2000') bus = 'n2k'
    else if (declared === 'NMEA0183') bus = 'nmea0183'
    else {
      const node = child(tree(), connection)
      const treeType = node && typeof node.type === 'string' ? node.type.toUpperCase() : null
      const member = child(node, rest)
      if (treeType === 'NMEA2000') bus = 'n2k'
      else if (treeType === 'NMEA0183') bus = 'nmea0183'
      else if (member && isRecord(member.n2k)) bus = 'n2k'
      else if (member && isRecord(member.sentences)) bus = 'nmea0183'
    }
    // Plugins, derived data, WebSocket clients… are not devices of the boat.
    if (bus === null) return null

    return {
      bus,
      connection,
      src: bus === 'n2k' ? parseAddress(rest) : null,
      sentence,
    }
  }

  /** Catalog paths of a delta update, minus alarms (not a measurement of one device) and AIS. */
  function catalogPaths(update: NonNullable<Delta['updates']>[number]): string[] {
    const paths: string[] = []
    for (const entry of update.values ?? []) {
      if (typeof entry.path !== 'string' || entry.value === null || entry.value === undefined)
        continue
      if (entry.path.startsWith('notifications.') || entry.path.startsWith(AIS_PATH_PREFIX))
        continue
      if (catalogSpec(entry.path) !== null) paths.push(entry.path)
    }
    return paths
  }

  function observeDelta(delta: Delta, atMs: number) {
    if (!isSelfDelta(delta, options.selfContext)) return
    for (const update of delta.updates ?? []) {
      const paths = catalogPaths(update)
      if (paths.length === 0) continue
      const source = resolveSource(update, () => readTree(atMs))
      if (source === null) continue
      const key =
        source.bus === 'n2k'
          ? `n2k:${source.connection}:${source.src ?? 'x'}`
          : `nmea0183:${source.connection}`
      let device = observed.get(key)
      if (!device) {
        device = {
          key,
          bus: source.bus,
          connection: source.connection,
          src: source.src,
          sentences: new Set(),
          paths: new Set(),
          firstSeenMs: atMs,
          lastSeenMs: atMs,
        }
        observed.set(key, device)
      }
      device.lastSeenMs = atMs
      if (source.sentence !== null) device.sentences.add(source.sentence)
      for (const path of paths) device.paths.add(path)
    }
  }

  /**
   * Fallback when `sources` carries no metadata: PGN 126996 (product
   * information) and 60928 (address claim) as emitted by the server's
   * `N2KAnalyzerOut` event.
   */
  function observePgn(message: unknown, atMs: number) {
    if (!isRecord(message)) return
    const number = message.pgn
    if (number !== 126996 && number !== 60928) return
    const src = parseAddress(message.src)
    if (src === null) return
    const fields = isRecord(message.fields) ? message.fields : {}
    const info: PgnInfo = pgn.get(src) ?? { lastSeenMs: atMs }
    info.lastSeenMs = atMs
    if (number === 126996) {
      info.model = cleanText(pgnField(fields, 'Model ID')) ?? info.model
      info.serialNumber = cleanText(pgnField(fields, 'Model Serial Code')) ?? info.serialNumber
      info.manufacturer =
        cleanText(pgnField(fields, 'Manufacturer', 'Manufacturer Code')) ?? info.manufacturer
    } else {
      info.manufacturer =
        cleanText(pgnField(fields, 'Manufacturer Code', 'Manufacturer')) ?? info.manufacturer
      info.function =
        cleanText(pgnField(fields, 'Device Function', 'Device Class')) ?? info.function
    }
    pgn.set(src, info)
  }

  /** How many N2K connections have a device at `src` (observed or listed in the tree). */
  function connectionsAt(src: number, tree: Tree): number {
    const connections = new Set<string>()
    for (const device of observed.values()) {
      if (device.bus === 'n2k' && device.src === src) connections.add(device.connection)
    }
    for (const [name, node] of Object.entries(tree)) {
      if (isRecord(node) && isRecord(child(node, String(src))?.n2k)) connections.add(name)
    }
    return connections.size
  }

  function n2kMetadata(connection: string, src: number, tree: Tree): Metadata {
    const n2k = child(child(child(tree, connection), String(src)), 'n2k')
    // A PGN names no connection: it only completes a device when the address is unambiguous.
    const fromPgn = connectionsAt(src, tree) <= 1 ? pgn.get(src) : undefined
    return {
      manufacturer:
        firstText(n2k, 'manufacturerName', 'manufacturer', 'manufacturerCode') ??
        fromPgn?.manufacturer ??
        null,
      model: firstText(n2k, 'productName', 'modelId') ?? fromPgn?.model ?? null,
      serialNumber:
        firstText(n2k, 'serialNumber', 'modelSerialCode', 'uniqueNumber') ??
        fromPgn?.serialNumber ??
        null,
      function: firstText(n2k, 'deviceFunction', 'deviceClass') ?? fromPgn?.function ?? null,
    }
  }

  function sentencesOf(device: Observed, tree: Tree): string[] {
    const sentences = new Set(device.sentences)
    const node = tree[device.connection]
    if (isRecord(node)) {
      for (const talker of Object.values(node)) {
        if (isRecord(talker) && isRecord(talker.sentences)) {
          for (const name of Object.keys(talker.sentences)) sentences.add(name)
        }
      }
    }
    return [...sentences].sort()
  }

  interface Draft {
    device: Omit<InventoryDevice, 'deviceId'>
    lastSeenMs: number
    /** `null` for NMEA 0183 (the id comes from the connection name). */
    identity: (Metadata & { placeOnBus: string }) | null
    fixedId: string | null
  }

  function n2kDraft(device: Observed, tree: Tree): Draft {
    const src = device.src!
    const meta = n2kMetadata(device.connection, src, tree)
    const name = cleanText([meta.manufacturer, meta.model].filter(Boolean).join(' '))
    const entry: Omit<InventoryDevice, 'deviceId'> = {
      label: name ?? `NMEA 2000 device ${src}`,
      bus: 'n2k',
      address: src,
      paths: [...device.paths],
    }
    if (meta.manufacturer !== null) entry.manufacturer = meta.manufacturer
    if (meta.model !== null) entry.model = meta.model
    if (meta.serialNumber !== null) {
      entry.serialNumber = options.hideSerialNumbers
        ? hashSerial(meta.serialNumber, options.salt)
        : meta.serialNumber
    }
    if (meta.function !== null) entry.function = meta.function
    return {
      device: entry,
      lastSeenMs: device.lastSeenMs,
      identity: { ...meta, placeOnBus: `${device.connection}@${src}` },
      fixedId: null,
    }
  }

  function toPayload(atMs: number): InventoryDevice[] {
    for (const [key, device] of observed) {
      if (atMs - device.lastSeenMs > DEVICE_GONE_AFTER_MS) observed.delete(key)
    }
    for (const [src, info] of pgn) {
      if (atMs - info.lastSeenMs > DEVICE_GONE_AFTER_MS) pgn.delete(src)
    }
    const tree = readTree(atMs)

    const drafts: Draft[] = []
    for (const device of observed.values()) {
      if (device.bus === 'n2k' && device.src !== null) {
        const draft = n2kDraft(device, tree)
        const known = draft.identity!
        const hasIdentity =
          known.manufacturer !== null || known.model !== null || known.serialNumber !== null
        // Its id would change when the metadata arrives: wait a little for it.
        if (!hasIdentity && atMs - device.firstSeenMs < IDENTITY_SETTLE_MS) continue
        drafts.push(draft)
      } else if (device.bus === 'nmea0183') {
        const sentences = sentencesOf(device, tree)
        const label = cleanText(
          `NMEA 0183 ${device.connection}${sentences.length > 0 ? ` (${sentences.join(', ')})` : ''}`
        )
        drafts.push({
          device: { label: label ?? 'NMEA 0183', bus: 'nmea0183', paths: [...device.paths] },
          lastSeenMs: device.lastSeenMs,
          identity: null,
          fixedId: nmea0183DeviceId(device.connection),
        })
      }
    }

    const devices: Array<{ device: InventoryDevice; lastSeenMs: number }> = []
    const used = new Set<string>()
    for (const draft of drafts) {
      let deviceId = draft.fixedId ?? n2kDeviceId(draft.identity!, options.salt)
      // Same manufacturer + model + serial twice: only the place on the bus tells them apart.
      if (used.has(deviceId) && draft.identity) {
        deviceId = n2kDeviceId(draft.identity, options.salt, true)
      }
      if (used.has(deviceId)) continue // unreachable in practice; never send a duplicate_device
      used.add(deviceId)
      const paths = [...new Set(draft.device.paths)].sort().slice(0, MAX_PATHS_PER_DEVICE)
      devices.push({ device: { deviceId, ...draft.device, paths }, lastSeenMs: draft.lastSeenMs })
    }

    return devices
      .sort(
        (a, b) => b.lastSeenMs - a.lastSeenMs || a.device.deviceId.localeCompare(b.device.deviceId)
      )
      .slice(0, MAX_DEVICES)
      .map(({ device }) => device)
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId))
  }

  function snapshot(atMs: number): InventorySnapshot {
    const payload: InventoryPayload = { devices: toPayload(atMs) }
    return { payload, signature: JSON.stringify(payload) }
  }

  return { observeDelta, observePgn, snapshot }
}

export type InventoryTracker = ReturnType<typeof createInventoryTracker>
