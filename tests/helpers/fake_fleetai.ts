import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ReceivedBatch {
  authorization: string | null
  contentType: string | null
  userAgent: string | null
  body: { batchId?: string; sourceId?: unknown; samples?: Array<Record<string, unknown>> }
}

export type Responder = (
  batch: ReceivedBatch,
  res: ServerResponse
) => { status: number; body?: unknown; headers?: Record<string, string> } | void

/** An HTTP endpoint that behaves like `POST /api/instruments/ingest`, scriptable per request. */
export async function startFakeFleetAi(responder?: Responder) {
  const received: ReceivedBatch[] = []
  const seen = new Set<string>()
  let respond: Responder = responder ?? (() => ({ status: 200 }))

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()))
    req.on('end', () => {
      const batch: ReceivedBatch = {
        authorization: req.headers.authorization ?? null,
        contentType: req.headers['content-type'] ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        body: raw ? JSON.parse(raw) : {},
      }
      received.push(batch)
      const scripted = respond(batch, res)
      if (scripted === undefined) return
      const headers = { 'content-type': 'application/json', ...(scripted.headers ?? {}) }
      res.writeHead(scripted.status, headers)
      let body = scripted.body
      if (body === undefined && scripted.status === 200) {
        // Idempotent like the real server: a replayed (path, recordedAt) is `ignored`.
        let accepted = 0
        let ignored = 0
        for (const sample of batch.body.samples ?? []) {
          const key = `${sample.path}@${sample.recordedAt}`
          if (seen.has(key)) ignored += 1
          else {
            seen.add(key)
            accepted += 1
          }
        }
        body = { accepted, ignored }
      }
      res.end(body === undefined ? '' : JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}/api/instruments/ingest`,
    received,
    setResponder(next: Responder) {
      respond = next
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
