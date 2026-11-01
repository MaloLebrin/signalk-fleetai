import { createHash } from 'node:crypto'
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
 * (catalog path) or one of its PGN 126996 / 60928 was seen in the last ten
 * minutes. The `sources` tree only supplies metadata, because it also lists
 * every device ever seen on the bus.
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
  lastSeenMs: number
}

interface PgnInfo extends Partial<Metadata> {
  lastSeenMs: number
}

type Tree = Record<string, unknown>

function isRecord(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Printable single-line text FleetAi accepts (`PLAIN_TEXT`: no control or format characters). */
export function cleanText(value: unknown): string | null {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value
  if (typeof raw !== 'string') return null
  const text = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_MAX_LENGTH)
    .trim()
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

/** `h:` + 8 hex of a salted hash — what is sent instead of the serial number when it is hidden. */
export function hashSerial(serial: string): string {
  return `h:${sha256Hex(`serial|${serial.trim().toLowerCase()}`).slice(0, 8)}`
}

/**
 * Stable fingerprint of a NMEA 2000 device: manufacturer + model + serial,
 * hashed (16 hex), so the id survives an address change and never contains
 * the serial in clear. Without any identity, the connection and address stand in.
 */
export function n2kDeviceId(identity: {
  manufacturer: string | null
  model: string | null
  serialNumber: string | null
  fallback: string
}): string {
  const parts = [identity.manufacturer, identity.model, identity.serialNumber].map((part) =>
    (part ?? '').trim().toLowerCase()
  )
  const material = parts.every((part) => part === '') ? identity.fallback : parts.join('|')
  return `n2k-${sha256Hex(`n2k|${material}`).slice(0, 16)}`
}

function slug(value: string): string {
  const cleaned = value.replace(/[^0-9A-Za-z_.-]+/g, '-').replace(/^[^0-9A-Za-z]+/, '')
  return cleaned.slice(0, DEVICE_ID_MAX_LENGTH - 'nmea0183-'.length) || sha256Hex(value).slice(0, 8)
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

  function readTree(): Tree {
    try {
      const tree = options.readSources()
      return isRecord(tree) ? tree : {}
    } catch {
      return {}
    }
  }

  /** Which bus a delta source belongs to, from the delta itself then from the `sources` tree. */
  function resolveSource(
    update: NonNullable<Delta['updates']>[number],
    tree: Tree
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
    const node = tree[connection]
    const child = isRecord(node) && rest !== null ? node[rest] : undefined
    const treeType =
      isRecord(node) && typeof node.type === 'string' ? node.type.toUpperCase() : null

    let bus: InventoryBus | null = null
    if (declared === 'NMEA2000' || treeType === 'NMEA2000') bus = 'n2k'
    else if (declared === 'NMEA0183' || treeType === 'NMEA0183') bus = 'nmea0183'
    else if (isRecord(child) && isRecord(child.n2k)) bus = 'n2k'
    else if (isRecord(child) && isRecord(child.sentences)) bus = 'nmea0183'
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
    let tree: Tree | null = null
    for (const update of delta.updates ?? []) {
      const paths = catalogPaths(update)
      if (paths.length === 0) continue
      tree ??= readTree()
      const source = resolveSource(update, tree)
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

  function n2kMetadata(connection: string | null, src: number, tree: Tree): Metadata {
    const n2k = child(child(child(tree, connection), String(src)), 'n2k')
    const fromPgn = pgn.get(src)
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

  function toPayload(atMs: number): InventoryDevice[] {
    for (const [key, device] of observed) {
      if (atMs - device.lastSeenMs > DEVICE_GONE_AFTER_MS) observed.delete(key)
    }
    for (const [src, info] of pgn) {
      if (atMs - info.lastSeenMs > DEVICE_GONE_AFTER_MS) pgn.delete(src)
    }
    const tree = readTree()

    interface Draft {
      device: Omit<InventoryDevice, 'deviceId'>
      lastSeenMs: number
      identity: Metadata
      fallback: string
      fixedId: string | null
    }
    const drafts: Draft[] = []
    const coveredAddresses = new Set<number>()

    for (const device of observed.values()) {
      if (device.bus === 'n2k' && device.src !== null) {
        coveredAddresses.add(device.src)
        // A PGN seen recently also proves the device is alive.
        const lastSeenMs = Math.max(device.lastSeenMs, pgn.get(device.src)?.lastSeenMs ?? 0)
        drafts.push(n2kDraft(device.connection, device.src, tree, [...device.paths], lastSeenMs))
      } else if (device.bus === 'nmea0183') {
        const sentences = sentencesOf(device, tree)
        const label = cleanText(
          `NMEA 0183 ${device.connection}${sentences.length > 0 ? ` (${sentences.join(', ')})` : ''}`
        )
        drafts.push({
          device: {
            label: label ?? 'NMEA 0183',
            bus: 'nmea0183',
            paths: [...device.paths],
          },
          lastSeenMs: device.lastSeenMs,
          identity: { manufacturer: null, model: null, serialNumber: null, function: null },
          fallback: '',
          fixedId: `nmea0183-${slug(device.connection)}`,
        })
      }
    }
    // Devices only known by their PGNs (no catalog delta seen yet): still announced.
    for (const [src, info] of pgn) {
      if (coveredAddresses.has(src)) continue
      drafts.push(n2kDraft(null, src, tree, [], info.lastSeenMs))
    }

    // Two identical, serial-less devices must not share an id (`duplicate_device`).
    const counts = new Map<string, number>()
    const baseIds = drafts.map(
      (draft) => draft.fixedId ?? n2kDeviceId({ ...draft.identity, fallback: draft.fallback })
    )
    for (const id of baseIds) counts.set(id, (counts.get(id) ?? 0) + 1)

    const devices: Array<{ device: InventoryDevice; lastSeenMs: number }> = []
    const used = new Set<string>()
    drafts.forEach((draft, index) => {
      let deviceId = baseIds[index]!
      if ((counts.get(deviceId) ?? 0) > 1 && draft.fixedId === null) {
        deviceId = n2kDeviceId({
          ...draft.identity,
          fallback: draft.fallback,
          // The address is the only thing telling them apart.
          serialNumber: `${draft.identity.serialNumber ?? ''}@${draft.device.address ?? draft.fallback}`,
        })
      }
      if (used.has(deviceId)) return
      used.add(deviceId)
      const paths = [...new Set(draft.device.paths)].sort().slice(0, MAX_PATHS_PER_DEVICE)
      devices.push({ device: { deviceId, ...draft.device, paths }, lastSeenMs: draft.lastSeenMs })
    })

    return devices
      .sort(
        (a, b) => b.lastSeenMs - a.lastSeenMs || a.device.deviceId.localeCompare(b.device.deviceId)
      )
      .slice(0, MAX_DEVICES)
      .map(({ device }) => device)
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId))
  }

  function n2kDraft(
    connection: string | null,
    src: number,
    tree: Tree,
    paths: string[],
    lastSeenMs: number
  ) {
    const meta = n2kMetadata(connection, src, tree)
    const name = cleanText([meta.manufacturer, meta.model].filter(Boolean).join(' '))
    const device: Omit<InventoryDevice, 'deviceId'> = {
      label: name ?? `NMEA 2000 device ${src}`,
      bus: 'n2k',
      address: src,
      paths,
    }
    if (meta.manufacturer !== null) device.manufacturer = meta.manufacturer
    if (meta.model !== null) device.model = meta.model
    if (meta.serialNumber !== null) {
      device.serialNumber = options.hideSerialNumbers
        ? hashSerial(meta.serialNumber)
        : meta.serialNumber
    }
    if (meta.function !== null) device.function = meta.function
    return {
      device,
      lastSeenMs,
      identity: meta,
      fallback: `${connection ?? ''}@${src}`,
      fixedId: null as string | null,
    }
  }

  function snapshot(atMs: number): InventorySnapshot {
    const payload: InventoryPayload = { devices: toPayload(atMs) }
    return { payload, signature: JSON.stringify(payload) }
  }

  return { observeDelta, observePgn, snapshot }
}

export type InventoryTracker = ReturnType<typeof createInventoryTracker>
