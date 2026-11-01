import type { InventoryPayload } from './inventory'
import type { BatchPayload } from './types'

/**
 * `POST {endpoint}` with the ingestion token. Classifies every answer so the
 * runtime decides without looking at HTTP:
 *
 * - `accepted` — 200 `{ accepted, ignored }` (a replay is a success).
 * - `retry`    — network failure, 5xx, 408, 429 (`Retry-After` honoured).
 * - `fatal`    — 401 / 403 / 404 / 409: stop and show the reason, never loop.
 * - `drop`     — 4xx the batch itself caused (422, 413…): log it, abandon it.
 */

export type SendOutcome = { kind: 'accepted'; accepted: number; ignored: number } | FailureOutcome

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface SenderOptions {
  endpoint: string
  token: string
  fetch?: FetchLike
  /** Request timeout, ms. */
  timeoutMs?: number
  userAgent?: string
}

export const DEFAULT_TIMEOUT_MS = 30_000

const FATAL_STATUSES = new Set([401, 403, 404, 409])

const FATAL_MESSAGES: Record<string, string> = {
  unauthorized:
    'Token rejected by FleetAi (missing, revoked or regenerated). Generate a new token in the Instruments tab and update the plugin configuration.',
  plan_not_allowed:
    'The FleetAi organisation plan no longer allows instruments (Pro plan required).',
  source_not_found: 'No instruments source matches this token in FleetAi.',
  source_disabled:
    'The instruments source is disabled in FleetAi. Enable it in the Instruments tab.',
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json()
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function retryAfterMs(response: Response, body: Record<string, unknown> | null): number | null {
  const header = response.headers.get('retry-after')
  if (header !== null) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  const bodyValue = body?.retryAfter
  if (typeof bodyValue === 'number' && Number.isFinite(bodyValue) && bodyValue >= 0) {
    return Math.round(bodyValue * 1000)
  }
  return null
}

export type FailureOutcome =
  | { kind: 'retry'; status: number | null; retryAfterMs: number | null; message: string }
  | { kind: 'fatal'; status: number; error: string; message: string }
  | { kind: 'drop'; status: number; error: string; path: string | null; message: string }

export type InventorySendOutcome =
  { kind: 'accepted'; created: number; updated: number; gone: number } | FailureOutcome

type PostResult = { kind: 'ok'; body: Record<string, unknown> | null } | FailureOutcome

/**
 * One authenticated JSON POST, with the answer classified the same way for
 * every FleetAi endpoint (`successStatuses` are the codes meaning "accepted").
 */
function createPoster(options: SenderOptions) {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return async function post(
    url: string,
    payload: unknown,
    successStatuses: readonly number[]
  ): Promise<PostResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': options.userAgent ?? 'signalk-fleetai',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'manual',
      })
    } catch (error) {
      clearTimeout(timer)
      const message = controller.signal.aborted ? `timeout after ${timeoutMs} ms` : String(error)
      return { kind: 'retry', status: null, retryAfterMs: null, message }
    }
    clearTimeout(timer)

    const status = response.status
    const body = await readJson(response)
    const error = typeof body?.error === 'string' ? body.error : `http_${status}`

    if (successStatuses.includes(status)) return { kind: 'ok', body }
    if (status === 429 || status === 408 || status >= 500 || (status >= 300 && status < 400)) {
      return {
        kind: 'retry',
        status,
        retryAfterMs: status === 429 ? retryAfterMs(response, body) : null,
        message: `HTTP ${status} ${error}`,
      }
    }
    if (FATAL_STATUSES.has(status)) {
      return {
        kind: 'fatal',
        status,
        error,
        message: FATAL_MESSAGES[error] ?? `FleetAi refused the token (HTTP ${status} ${error}).`,
      }
    }
    return {
      kind: 'drop',
      status,
      error,
      path: typeof body?.path === 'string' ? body.path : null,
      message: `HTTP ${status} ${error}${typeof body?.path === 'string' ? ` (${body.path})` : ''}`,
    }
  }
}

function count(body: Record<string, unknown> | null, key: string): number {
  const value = body?.[key]
  return typeof value === 'number' ? value : 0
}

export function createSender(options: SenderOptions) {
  const post = createPoster(options)

  async function send(batch: BatchPayload): Promise<SendOutcome> {
    const result = await post(
      options.endpoint,
      { batchId: batch.batchId, samples: batch.samples },
      [200]
    )
    if (result.kind !== 'ok') return result
    return {
      kind: 'accepted',
      accepted: count(result.body, 'accepted'),
      ignored: count(result.body, 'ignored'),
    }
  }

  return { send }
}

/** `POST {inventory endpoint}` — the full device list; the server answers `201 { created, updated, gone }`. */
export function createInventorySender(options: SenderOptions) {
  const post = createPoster(options)

  async function send(payload: InventoryPayload): Promise<InventorySendOutcome> {
    const result = await post(options.endpoint, payload, [200, 201])
    if (result.kind !== 'ok') return result
    return {
      kind: 'accepted',
      created: count(result.body, 'created'),
      updated: count(result.body, 'updated'),
      gone: count(result.body, 'gone'),
    }
  }

  return { send }
}

export type Sender = ReturnType<typeof createSender>
export type InventorySender = ReturnType<typeof createInventorySender>
