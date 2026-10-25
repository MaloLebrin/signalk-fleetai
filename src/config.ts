import type { PluginConfig, ResolvedConfig } from './types'

export const DEFAULT_ENDPOINT = 'https://fleetai.app/api/instruments/ingest'
export const DEFAULT_PERIOD_SECONDS = 60
export const MIN_PERIOD_SECONDS = 10
export const MAX_PERIOD_SECONDS = 3600
export const TOKEN_PREFIX = 'fai_ing_'

/** JSON schema rendered by the Signal K admin UI (Plugin Config → FleetAi). */
export const CONFIG_SCHEMA = {
  type: 'object',
  required: ['endpoint', 'token'],
  properties: {
    endpoint: {
      type: 'string',
      title: 'FleetAi ingestion endpoint',
      description:
        'Shown in the Instruments tab of your boat (Signal K plugin card). Leave the default for fleetai.app.',
      default: DEFAULT_ENDPOINT,
    },
    token: {
      type: 'string',
      title: 'Ingestion token',
      description:
        'Generated once per boat in FleetAi (starts with fai_ing_). Regenerating it in FleetAi revokes this one.',
    },
    periodSeconds: {
      type: 'integer',
      title: 'Send period (seconds)',
      description: 'One value per path and per period; minimum 10 s.',
      default: DEFAULT_PERIOD_SECONDS,
      minimum: MIN_PERIOD_SECONDS,
      maximum: MAX_PERIOD_SECONDS,
    },
    paths: {
      type: 'array',
      title: 'Additional paths',
      description:
        'Extra numeric Signal K paths (or wildcards such as electrical.ac.*.voltage) to send on top of the FleetAi catalog. A path FleetAi refuses is dropped for the session.',
      default: [],
      items: { type: 'string' },
    },
  },
} as const

export const CONFIG_UI_SCHEMA = {
  token: { 'ui:widget': 'password' },
} as const

export type ConfigResult = { ok: true; config: ResolvedConfig } | { ok: false; error: string }

/** Reads the stored configuration defensively: the admin UI can save partial objects. */
export function resolveConfig(raw: unknown): ConfigResult {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<PluginConfig>

  const endpoint =
    typeof input.endpoint === 'string' && input.endpoint.trim() !== ''
      ? input.endpoint.trim()
      : DEFAULT_ENDPOINT
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return { ok: false, error: `Endpoint is not a valid URL: ${endpoint}` }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: `Endpoint must be http(s): ${endpoint}` }
  }

  const token = typeof input.token === 'string' ? input.token.trim() : ''
  if (token === '')
    return {
      ok: false,
      error:
        'No ingestion token configured. Generate one in FleetAi (Instruments tab → Signal K plugin) and paste it here.',
    }
  if (!token.startsWith(TOKEN_PREFIX))
    return { ok: false, error: `The token must start with ${TOKEN_PREFIX}.` }

  let periodSeconds = DEFAULT_PERIOD_SECONDS
  if (typeof input.periodSeconds === 'number' && Number.isFinite(input.periodSeconds)) {
    periodSeconds = Math.round(input.periodSeconds)
  }
  periodSeconds = Math.min(MAX_PERIOD_SECONDS, Math.max(MIN_PERIOD_SECONDS, periodSeconds))

  const paths = Array.isArray(input.paths)
    ? input.paths
        .filter((path): path is string => typeof path === 'string' && path.trim() !== '')
        .map((path) => path.trim())
    : []

  return { ok: true, config: { endpoint: url.toString(), token, periodSeconds, paths } }
}
