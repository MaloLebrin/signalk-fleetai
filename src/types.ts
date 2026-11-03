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
  hideSerialNumbers?: boolean
}

export interface ResolvedConfig {
  endpoint: string
  token: string
  periodSeconds: number
  /** Extra exact paths or Signal K wildcards (`electrical.ac.*.voltage`) accepted on top of the catalog. */
  paths: string[]
  /** Device inventory: send a hash of NMEA 2000 serial numbers instead of the serial numbers. */
  hideSerialNumbers: boolean
  /** `POST` target of the device inventory, derived from `endpoint`. */
  inventoryEndpoint: string
}

/** Minimal Signal K delta shape the plugin reads. */
export interface DeltaValue {
  path: string
  value: unknown
}

export interface DeltaUpdate {
  timestamp?: string
  /** Signal K source reference, `<connection>.<address or talker>` (`can0.12`, `ttyUSB0.GP`). */
  $source?: string
  /** Source description: `{ label, type, src | talker, pgn | sentence }`. */
  source?: unknown
  values?: DeltaValue[]
}

export interface Delta {
  context?: string
  updates?: DeltaUpdate[]
}
