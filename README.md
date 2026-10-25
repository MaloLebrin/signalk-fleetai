# signalk-fleetai

[Signal K](https://signalk.org) server plugin that pushes your boat's instrument readings to [FleetAi](https://fleetai.app): engines, navigation, batteries, solar and chargers, tanks, environment, Signal K alarms, and the AIS targets the server receives.

The plugin is **read-only** (it only subscribes to deltas), sends **one value per path and per period**, queues batches on disk while the boat is offline, and replays them in order when the network comes back (4G, Starlink, marina Wi-Fi).

Requires Signal K server 2.x and Node.js 18 or newer.

## Installation

### From the Signal K Appstore

1. In FleetAi, open the boat → **Instruments** tab → **Signal K plugin** card → **Generate a token**. The token (`fai_ing_…`) is shown once.
2. In the Signal K admin UI: **Appstore** → search `signalk-fleetai` → **Install**, then restart the server.
3. **Server → Plugin Config → FleetAi**: paste the token, keep the default endpoint (or paste the one shown in FleetAi for a self-hosted instance), enable the plugin, **Submit**.

Within two periods (2 minutes by default) the Instruments tab shows the first values.

### With one command (Raspberry Pi / OpenPlotter / any Linux Signal K server)

Logged in as the user running Signal K (not root):

```bash
curl -fsSL https://fleetai.app/install/signalk-plugin.sh | FLEETAI_TOKEN=fai_ing_… bash
```

The script checks Node, npm and `signalk-server`, runs `npm install signalk-fleetai@latest` in the Signal K configuration directory (`~/.signalk` or `$SIGNALK_NODE_CONFIG_DIR`), writes `plugin-config-data/signalk-fleetai.json` (mode 600, never prints the token, merges an existing file) and restarts `signalk.service` when it exists. It can be run again safely. Variables: `FLEETAI_TOKEN` (required), `FLEETAI_ENDPOINT` (defaults to the instance serving the script), `SIGNALK_NODE_CONFIG_DIR`, `FLEETAI_ALLOW_ROOT=1`, `FLEETAI_DRY_RUN=1`.

## Configuration

Stored by the server in `plugin-config-data/signalk-fleetai.json`:

```json
{
  "enabled": true,
  "configuration": {
    "endpoint": "https://fleetai.app/api/instruments/ingest",
    "token": "fai_ing_…",
    "periodSeconds": 60,
    "paths": []
  }
}
```

| Setting         | Default                                      | Meaning                                                                                                                                                                        |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `endpoint`      | `https://fleetai.app/api/instruments/ingest` | FleetAi ingestion URL. Self-hosted instances show theirs in the Signal K plugin card.                                                                                          |
| `token`         | —                                            | Ingestion token generated in FleetAi, one per boat. Regenerating or revoking it in FleetAi stops this plugin with an explicit error.                                           |
| `periodSeconds` | `60` (min `10`, max `3600`)                  | Aggregation window and send period. Paths the FleetAi catalog samples more slowly keep their slower cadence (engine hours every 5 min, tank capacity hourly, AIS every 5 min). |
| `paths`         | `[]`                                         | Extra numeric Signal K paths or wildcards (`electrical.ac.*.voltage`) sent on top of the catalog. A path FleetAi refuses (`422 path_not_allowed`) is dropped for the session.  |

## What is sent

- **Context `vessels.self`**, FleetAi catalog only: `propulsion.*` (run time, revolutions, temperatures, pressures, fuel rate, load, alternator), `navigation.*` (position, SOG/COG, headings, STW, logs), `electrical.*` (batteries, solar, chargers, inverters), `tanks.*`, `environment.*` (wind, depth, temperatures, pressure, humidity, tide) and `notifications.*` (alarms, as `{ state, message, method }`). Paths outside the catalog are never sent.
- **AIS targets** (`vessels.urn:mrn:imo:mmsi:*`): one sighting per target and per 5-minute window under the synthetic path `ais.<mmsi>`, with name, position, SOG, COG, ship type, CPA and TCPA.
- **Units are left exactly as Signal K emits them** (SI: Hz, K, Pa, m/s, rad, m³, ratios 0–1). FleetAi converts at display time.
- **`recordedAt`** is the server's clock floored to the start of the window — never the NMEA timestamp. The same window always produces the same `(path, recordedAt)`, so a replayed batch is idempotent on the FleetAi side.
- Each `POST {endpoint}` carries `Authorization: Bearer <token>`, a JSON body `{ batchId: <uuid>, samples: [...] }` with at most 500 samples, and no `sourceId` (the token identifies the boat).

## Offline behaviour and errors

- Batches that cannot be delivered are kept in `<signalk data dir>/plugin-config-data/signalk-fleetai/queue.json` (via `app.getDataDirPath()`), **bounded to 1440 batches** (a day of one-minute batches, the oldest dropped first), and replayed **in order** on the next attempt or the next server start.
- Network failure, timeout, 5xx: exponential back-off from 5 s, **capped at 5 minutes**.
- `429`: waits for `Retry-After`.
- `401` (token missing, revoked or regenerated), `403` (plan no longer allows instruments), `404`, `409` (source disabled): the plugin **stops** and shows the reason in the plugin status — it never loops on a rejected token. Fix the cause (new token, plan, source) and re-enable the plugin; the queue is kept.
- `422` (refused batch): the batch is written to the server log in full and abandoned; a refused path is not sent again this session.

Plugin status (Server → Plugin Config, and the Dashboard):

- `Collecting readings` / `Sending first batch (N queued)`
- `Last batch accepted 2 min ago`
- `Waiting for network (N batches queued) — <last error>`
- `Token rejected: …` (error)

## Development

```bash
npm install
npm test          # Vitest: aggregation, 500-sample batches, idempotent replay, every HTTP code, queue persistence, integration against a fake endpoint
npm run lint      # ESLint + Prettier
npm run typecheck
npm run build     # dist/ (CommonJS, Node ≥ 18)
```

To try it on a real server, link the package into a Signal K configuration directory:

```bash
npm run build && npm pack
cd ~/.signalk && npm install /path/to/signalk-fleetai-0.1.0.tgz
```

### Releasing

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests and the build on every pull request and on `main`. Publishing is done by `.github/workflows/publish.yml` when a `v*` tag is pushed:

```bash
npm version patch   # bumps package.json and creates the tag
git push --follow-tags
```

The workflow needs the repository secret **`NPM_TOKEN`**: an npm [granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens) with _Read and write_ permission on the `signalk-fleetai` package (bypass 2FA enabled for automation). Add it under _Settings → Secrets and variables → Actions_. The Signal K Appstore lists any npm package with the `signalk-node-server-plugin` keyword, usually within an hour of publication.

## License

MIT — see [LICENSE](LICENSE).
