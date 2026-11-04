/**
 * uploader — sends the recording's chunks to the bucket, in order, from memory (specs/021-meetings
 * plan § Browser capture › Chunk protocol, AC-2.6, AC-2.9, AC-4.11).
 *
 *   enqueue(chunk) ─▶ [ in-memory FIFO ] ─▶ POST to the bucket (presigned) ─▶ confirm to meetings-api
 *                                              ▲                                   │
 *                                              └──── the policy for the NEXT seq ◀─┘
 *
 * - **One chunk at a time, strictly in order.** A chunk that cannot be sent holds the ones behind it:
 *   the server's `chunks_missing` check and the final audio both depend on the order.
 * - **Pre-minted policy.** `recording/start` returns the policy for seq 0 and every confirm returns the
 *   one for seq + 1, so a chunk costs one bucket POST and one confirm. A held policy that is about to
 *   expire (5 minutes: the tab was offline for a while) is replaced by `…/upload-url` BEFORE the POST
 *   instead of after a refusal.
 * - **Offline.** Any network failure, 5xx or 429 is retried with an exponential wait (1 s doubling to
 *   30 s, `lib/backoff.ts`); `retryNow()` skips the wait when the browser reports it is back online.
 *   The queue lives in memory only: audio captured while offline survives only as long as the tab
 *   does, which the recording panel says in words (spec amendment A2).
 * - **Fatal answers** (the session is no longer active, the 3 h limit, the meeting is gone, the
 *   creator may no longer record) stop the queue for good: retrying a refused chunk cannot succeed.
 * - **Sent chunks stay in memory** until `dispose()`: if `recording/stop` answers `chunks_missing`, the
 *   blobs are still here to send again. 3 hours at 32 kbit/s is about 43 MB.
 */
import { ApiError } from '../lib/api'
import { nextDelay } from '../lib/backoff'
import type { BackoffOptions } from '../lib/backoff'
import type { ChunkConfirm, PresignedPost } from '../lib/types'

/** 1 s, 2 s, 4 s … never more than 30 s between two attempts. */
export const UPLOAD_BACKOFF: BackoffOptions = { baseMs: 1_000, factor: 2, maxMs: 30_000 }

/** The most captured audio the server accepts in a heartbeat or a confirm: 3 h + 60 s (plan § API contracts). */
export const MAX_CAPTURED_MS = 10_800_000 + 60_000

/** A held policy with less than this left is replaced before it is used. */
const POLICY_SAFETY_MS = 15_000

/** The bucket refused (or failed) a POST. */
export class BucketError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`The bucket answered ${status}`)
    this.name = 'BucketError'
    this.status = status
  }
}

/**
 * POSTs one chunk to its presigned policy: the policy's fields first, the file LAST (S3 ignores
 * anything after it). No credentials and no Authorization header: this is the bucket, not
 * meetings-api (the policy is the authority).
 */
export async function postToBucket(policy: PresignedPost, blob: Blob, fetchImpl: typeof fetch = fetch): Promise<void> {
  const form = new FormData()
  for (const [name, value] of Object.entries(policy.fields)) form.append(name, value)
  form.append('file', blob, 'chunk')
  const response = await fetchImpl(policy.url, { method: 'POST', body: form, credentials: 'omit' })
  if (!response.ok) throw new BucketError(response.status)
}

export type QueuedChunk = { seq: number; blob: Blob; durationMs: number }

export type UploaderApi = {
  confirmChunk: (
    meetingId: string,
    seq: number,
    body: { sessionId: string; durationMs: number; capturedMs?: number },
  ) => Promise<ChunkConfirm>
  mintChunkUploadUrl: (meetingId: string, seq: number, sessionId: string) => Promise<PresignedPost>
}

export type UploaderOptions = {
  meetingId: string
  sessionId: string
  /** The policy `recording/start` returned, for seq 0. */
  firstPolicy: PresignedPost
  api: UploaderApi
  /** Defaults to `postToBucket`; a test passes a fake. */
  post?: (policy: PresignedPost, blob: Blob) => Promise<void>
  /** The audio captured so far, saved or not: sent with every confirm (plan G3). */
  capturedMs: () => number
  backoff?: BackoffOptions
}

export type UploaderSnapshot = {
  /** Chunks waiting to be saved (the one in flight included). */
  queued: number
  /** Their length in milliseconds: "about n s waiting". */
  queuedMs: number
  /** Chunks the server has confirmed. */
  saved: number
  /** The last attempt failed and the next one is waiting: the audio is NOT yet saved. */
  offline: boolean
}

export type Uploader = {
  enqueue: (chunk: QueuedChunk) => void
  /** Resolves when every queued chunk is confirmed; rejects with the fatal answer, if there was one. */
  idle: () => Promise<void>
  /** Puts chunks already sent back in the queue (the server reported them missing). False if one is not in memory. */
  requeue: (seqs: number[]) => boolean
  /** Tries again now instead of after the wait. */
  retryNow: () => void
  snapshot: () => UploaderSnapshot
  subscribe: (listener: () => void) => () => void
  onFatal: (listener: (error: unknown) => void) => () => void
  /** Drops the queue and the sent chunks and stops retrying. */
  dispose: () => void
}

type Item = QueuedChunk & { posted: boolean; forceMint: boolean }

/** Answers that retrying cannot fix: the session is over, the meeting is gone, or the caller may no longer record. */
export const isFatalUploadError = (error: unknown): boolean => {
  if (!(error instanceof ApiError)) return false
  if (error.status === 404 || error.status === 403) return true
  if (error.status === 409) return error.code === 'session_inactive' || error.code === 'duration_limit'
  // A 4xx we did not expect (a request we built wrongly) is not going to get better by repeating it.
  return (
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429 &&
    error.code !== 'chunk_missing'
  )
}

export function createUploader(options: UploaderOptions): Uploader {
  const { meetingId, sessionId, api, capturedMs } = options
  const post = options.post ?? ((policy, blob) => postToBucket(policy, blob))
  const backoff = options.backoff ?? UPLOAD_BACKOFF

  const queue: Item[] = []
  const kept = new Map<number, QueuedChunk>()
  let held: { seq: number; policy: PresignedPost } | null = { seq: 0, policy: options.firstPolicy }
  let saved = 0
  let offline = false
  let pumping = false
  let disposed = false
  let fatal: { error: unknown } | null = null
  let delay = backoff.baseMs
  let wake: (() => void) | null = null

  const listeners = new Set<() => void>()
  const fatalListeners = new Set<(error: unknown) => void>()
  const waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
  let snapshot: UploaderSnapshot = { queued: 0, queuedMs: 0, saved: 0, offline: false }

  const publish = () => {
    const next: UploaderSnapshot = {
      queued: queue.length,
      queuedMs: queue.reduce((sum, item) => sum + item.durationMs, 0),
      saved,
      offline,
    }
    if (
      next.queued === snapshot.queued &&
      next.queuedMs === snapshot.queuedMs &&
      next.saved === snapshot.saved &&
      next.offline === snapshot.offline
    ) {
      return
    }
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  const settleIdle = () => {
    for (const waiter of waiters.splice(0)) waiter.resolve()
  }

  const expired = (policy: PresignedPost) => {
    const expiresAt = Date.parse(policy.expiresAt)
    return Number.isFinite(expiresAt) && expiresAt - Date.now() < POLICY_SAFETY_MS
  }

  const policyFor = async (item: Item): Promise<PresignedPost> => {
    if (!item.forceMint && held && held.seq === item.seq && !expired(held.policy)) return held.policy
    return api.mintChunkUploadUrl(meetingId, item.seq, sessionId)
  }

  const sendOne = async (item: Item) => {
    if (!item.posted) {
      const policy = await policyFor(item)
      try {
        await post(policy, item.blob)
      } catch (error) {
        // 403: the policy ran out between minting and posting. Anything else on the bucket side is a
        // plain retry, but a stale policy never gets better by itself.
        if (error instanceof BucketError && error.status === 403) item.forceMint = true
        throw error
      }
      item.posted = true
      item.forceMint = false
    }
    try {
      const confirmed = await api.confirmChunk(meetingId, item.seq, {
        sessionId,
        durationMs: item.durationMs,
        capturedMs: Math.max(0, Math.min(Math.round(capturedMs()), MAX_CAPTURED_MS)),
      })
      // A re-sent old chunk answers with the policy for ITS successor; only keep one for a seq not yet reached.
      if (!held || item.seq + 1 >= held.seq) held = { seq: item.seq + 1, policy: confirmed.next }
    } catch (error) {
      // The bucket does not have the object (HEAD 404): post it again, with a fresh policy.
      if (error instanceof ApiError && error.code === 'chunk_missing') {
        item.posted = false
        item.forceMint = true
      }
      throw error
    }
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        wake = null
        resolve()
      }
      const timer = setTimeout(done, ms)
      wake = done
    })

  const failFor = (error: unknown) => {
    fatal = { error }
    queue.length = 0
    offline = false
    publish()
    for (const waiter of waiters.splice(0)) waiter.reject(error)
    for (const listener of [...fatalListeners]) listener(error)
  }

  const pump = async () => {
    if (pumping) return
    pumping = true
    try {
      while (queue.length > 0 && !disposed && !fatal) {
        const head = queue[0]!
        try {
          await sendOne(head)
        } catch (error) {
          if (disposed) return
          if (isFatalUploadError(error)) {
            failFor(error)
            return
          }
          offline = true
          publish()
          await sleep(delay)
          delay = nextDelay(delay, backoff)
          continue
        }
        if (disposed) return
        queue.shift()
        kept.set(head.seq, { seq: head.seq, blob: head.blob, durationMs: head.durationMs })
        saved += 1
        offline = false
        delay = backoff.baseMs
        publish()
      }
      if (queue.length === 0 && !disposed && !fatal) settleIdle()
    } finally {
      pumping = false
    }
  }

  return {
    enqueue(chunk) {
      if (disposed || fatal) return
      queue.push({ ...chunk, posted: false, forceMint: false })
      publish()
      void pump()
    },
    idle() {
      if (fatal) return Promise.reject(fatal.error)
      if (queue.length === 0 && !pumping) return Promise.resolve()
      return new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }))
    },
    requeue(seqs) {
      if (disposed || fatal) return false
      if (!seqs.every((seq) => kept.has(seq))) return false
      for (const seq of [...seqs].sort((a, b) => a - b)) {
        const chunk = kept.get(seq)!
        queue.push({ ...chunk, posted: false, forceMint: true })
      }
      publish()
      void pump()
      return true
    },
    retryNow() {
      delay = backoff.baseMs
      wake?.()
    },
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onFatal(listener) {
      fatalListeners.add(listener)
      return () => fatalListeners.delete(listener)
    },
    dispose() {
      disposed = true
      queue.length = 0
      kept.clear()
      held = null
      offline = false
      wake?.()
      publish()
      settleIdle()
      listeners.clear()
      fatalListeners.clear()
    },
  }
}
