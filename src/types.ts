/** JSON value as FleetAi stores it in `value_json`. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** One sample of the FleetAi telemetry batch (`TelemetrySampleInput` on the server side). */
export interface Sample {
  path: string
  /** ISO 8601 — the server's clock, floored to the start of the aggregation window. */
  recordedAt: string
  value?: number | null
  valueJson?: JsonValue | null
}

/** Body of `POST /api/instruments/ingest`. `sourceId` is never sent: the token names the source. */
export interface BatchPayload {
  batchId: string
  samples: Sample[]
}

/** Plugin configuration, as stored in `plugin-config-data/signalk-fleetai.json`. */
export interface PluginConfig {
  endpoint: string
  token: string
  periodSeconds: number
  paths?: string[]
}

export interface ResolvedConfig {
  endpoint: string
  token: string
  periodSeconds: number
  /** Extra exact paths or Signal K wildcards (`electrical.ac.*.voltage`) accepted on top of the catalog. */
  paths: string[]
}

/** Minimal Signal K delta shape the plugin reads. */
export interface DeltaValue {
  path: string
  value: unknown
}

export interface DeltaUpdate {
  timestamp?: string
  values?: DeltaValue[]
}

export interface Delta {
  context?: string
  updates?: DeltaUpdate[]
}
