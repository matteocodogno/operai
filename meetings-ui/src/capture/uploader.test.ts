import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../lib/api'
import type { ChunkConfirm, PresignedPost } from '../lib/types'
import { createUploader, postToBucket, BucketError } from './uploader'
import type { UploaderApi } from './uploader'

const policy = (name: string, minutes = 5): PresignedPost => ({
  url: `https://bucket.test/${name}`,
  fields: { key: name },
  expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
})

type PostFn = (policy: PresignedPost, blob: Blob) => Promise<void>
const okPost = () => vi.fn<PostFn>(async () => undefined)

const chunk = (seq: number, durationMs = 10_000) => ({ seq, blob: new Blob([`chunk-${seq}`]), durationMs })

const problem = (status: number, code?: string, extras: Record<string, unknown> = {}) =>
  new ApiError({ status, title: 'Problem', code, extras })

/** An API that confirms every chunk and hands out `policy-<seq + 1>` as the next one. */
const happyApi = () => {
  const api = {
    confirmChunk: vi.fn<UploaderApi['confirmChunk']>(async (_id, seq): Promise<ChunkConfirm> => ({
      storedChunks: seq + 1,
      durationMs: 10_000,
      next: policy(`seq-${seq + 1}`),
    })),
    mintChunkUploadUrl: vi.fn<UploaderApi['mintChunkUploadUrl']>(async (_id, seq) => policy(`minted-${seq}`)),
  }
  return api satisfies UploaderApi
}

const make = (api: UploaderApi, post: ReturnType<typeof okPost> = okPost(), capturedMs = () => 0) =>
  createUploader({
    meetingId: 'm1',
    sessionId: 's1',
    firstPolicy: policy('seq-0'),
    api,
    post,
    capturedMs,
  })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('uploader: the pre-minted policy chain', () => {
  it('posts each chunk with the policy held for its seq and confirms it, one POST and one confirm per chunk', async () => {
    const api = happyApi()
    const post = okPost()
    const uploader = make(api, post)
    uploader.enqueue(chunk(0))
    uploader.enqueue(chunk(1))
    await uploader.idle()

    expect(post.mock.calls.map(([p]) => (p as PresignedPost).url)).toEqual([
      'https://bucket.test/seq-0',
      'https://bucket.test/seq-1',
    ])
    expect(api.confirmChunk.mock.calls.map(([, seq]) => seq)).toEqual([0, 1])
    expect(api.mintChunkUploadUrl).not.toHaveBeenCalled()
    expect(uploader.snapshot()).toMatchObject({ queued: 0, saved: 2, offline: false })
  })

  it('sends the session id, the chunk length and the audio captured so far with every confirm', async () => {
    const api = happyApi()
    let captured = 10_000
    const uploader = make(api, undefined, () => captured)
    uploader.enqueue(chunk(0))
    await uploader.idle()
    captured = 20_000
    uploader.enqueue(chunk(1, 9_500))
    await uploader.idle()

    expect(api.confirmChunk).toHaveBeenNthCalledWith(1, 'm1', 0, {
      sessionId: 's1',
      durationMs: 10_000,
      capturedMs: 10_000,
    })
    expect(api.confirmChunk).toHaveBeenNthCalledWith(2, 'm1', 1, {
      sessionId: 's1',
      durationMs: 9_500,
      capturedMs: 20_000,
    })
  })

  it('never reports more captured audio than the server accepts (3 h + 60 s)', async () => {
    const api = happyApi()
    const uploader = make(api, undefined, () => 99_999_999)
    uploader.enqueue(chunk(0))
    await uploader.idle()
    expect(api.confirmChunk.mock.calls[0]![2]).toMatchObject({ capturedMs: 10_860_000 })
  })

  it('re-mints the policy before posting when the held one has expired, instead of failing first', async () => {
    const api = happyApi()
    const post = okPost()
    const uploader = make(api, post)
    uploader.enqueue(chunk(0))
    await uploader.idle()
    // The policy for seq 1 was minted at confirm time and is valid for 5 minutes; the tab was offline for 6.
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    uploader.enqueue(chunk(1))
    await uploader.idle()

    expect(api.mintChunkUploadUrl).toHaveBeenCalledWith('m1', 1, 's1')
    expect((post.mock.calls[1]![0] as PresignedPost).url).toBe('https://bucket.test/minted-1')
  })
})

describe('uploader: offline', () => {
  it('keeps the chunks in memory and retries them in order, with a growing wait, once the network is back', async () => {
    const api = happyApi()
    let online = false
    const sent: number[] = []
    const post = vi.fn<PostFn>(async (_policy, blob) => {
      if (!online) throw new TypeError('Failed to fetch')
      sent.push(Number((await blob.text()).replace('chunk-', '')))
    })
    const uploader = make(api, post)
    uploader.enqueue(chunk(0))
    uploader.enqueue(chunk(1))
    uploader.enqueue(chunk(2))

    await vi.advanceTimersByTimeAsync(0)
    expect(uploader.snapshot()).toMatchObject({ queued: 3, queuedMs: 30_000, offline: true, saved: 0 })

    // 1 s, then 2 s, then 4 s: three failed attempts so far (the first at once).
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(post).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(post).toHaveBeenCalledTimes(3)
    online = true
    await vi.advanceTimersByTimeAsync(1)
    await uploader.idle()

    expect(sent).toEqual([0, 1, 2])
    expect(api.confirmChunk.mock.calls.map(([, seq]) => seq)).toEqual([0, 1, 2])
    expect(uploader.snapshot()).toMatchObject({ queued: 0, saved: 3, offline: false })
  })

  it('a chunk behind a failing one waits: order is never changed', async () => {
    const api = happyApi()
    let failFirst = true
    const order: string[] = []
    const post = vi.fn<PostFn>(async (p) => {
      order.push(p.url)
      if (failFirst && p.url.endsWith('seq-0')) throw new TypeError('offline')
    })
    const uploader = make(api, post)
    uploader.enqueue(chunk(0))
    uploader.enqueue(chunk(1))
    await vi.advanceTimersByTimeAsync(500)
    expect(order).toEqual(['https://bucket.test/seq-0'])
    failFirst = false
    await vi.advanceTimersByTimeAsync(1_000)
    await uploader.idle()
    expect(order).toEqual(['https://bucket.test/seq-0', 'https://bucket.test/seq-0', 'https://bucket.test/seq-1'])
  })

  it('retryNow (the browser says it is online) retries at once and resets the wait', async () => {
    const api = happyApi()
    let online = false
    const post = vi.fn<PostFn>(async () => {
      if (!online) throw new TypeError('offline')
    })
    const uploader = make(api, post)
    uploader.enqueue(chunk(0))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000) // second attempt fails, the wait is now 2 s
    await vi.advanceTimersByTimeAsync(2_000) // third fails, the wait is now 4 s
    expect(post).toHaveBeenCalledTimes(3)

    online = true
    uploader.retryNow()
    await uploader.idle()
    expect(uploader.snapshot().saved).toBe(1)
  })

  it('does not post the bytes again when only the confirm failed', async () => {
    const api = happyApi()
    api.confirmChunk.mockRejectedValueOnce(problem(503))
    const post = okPost()
    const uploader = make(api, post)
    uploader.enqueue(chunk(0))
    await vi.advanceTimersByTimeAsync(1_000)
    await uploader.idle()
    expect(post).toHaveBeenCalledTimes(1)
    expect(api.confirmChunk).toHaveBeenCalledTimes(2)
  })

  it('posts the bytes again when the server says the object is not there (422 chunk_missing)', async () => {
    const api = happyApi()
    api.confirmChunk.mockRejectedValueOnce(problem(422, 'chunk_missing'))
    const post = okPost()
    const uploader = make(api, post)
    uploader.enqueue(chunk(0))
    await vi.advanceTimersByTimeAsync(1_000)
    await uploader.idle()
    expect(post).toHaveBeenCalledTimes(2)
    // The first policy may have been used up by then: ask for a fresh one.
    expect(api.mintChunkUploadUrl).toHaveBeenCalledWith('m1', 0, 's1')
  })

  it('a bucket 403 (the policy ran out) asks for a fresh policy for the retry', async () => {
    const api = happyApi()
    const post = vi
      .fn<(p: PresignedPost, b: Blob) => Promise<void>>()
      .mockRejectedValueOnce(new BucketError(403))
      .mockResolvedValue(undefined)
    const uploader = make(api, post)
    uploader.enqueue(chunk(0))
    await vi.advanceTimersByTimeAsync(1_000)
    await uploader.idle()
    expect(api.mintChunkUploadUrl).toHaveBeenCalledWith('m1', 0, 's1')
    expect((post.mock.calls[1]![0] as PresignedPost).url).toBe('https://bucket.test/minted-0')
  })

  it('the wait stops growing at 30 s', async () => {
    const api = happyApi()
    const post = vi.fn<PostFn>(async () => {
      throw new TypeError('offline')
    })
    const uploader = make(api, post)
    uploader.enqueue(chunk(0))
    // 0, 1, 3, 7, 15, 31 s: the sixth wait would be 32 s but is capped at 30 s.
    await vi.advanceTimersByTimeAsync(31_000)
    const callsAt31 = post.mock.calls.length
    expect(callsAt31).toBe(6)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(post).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(1)
    expect(post).toHaveBeenCalledTimes(7)
    uploader.dispose()
  })
})

describe('uploader: fatal answers', () => {
  it.each([
    ['session_inactive', 409],
    ['duration_limit', 409],
    ['not_found', 404],
    ['frozen', 403],
  ])('%s (%i) stops the queue and rejects idle()', async (code, status) => {
    const api = happyApi()
    api.confirmChunk.mockRejectedValue(problem(status, code))
    const uploader = make(api)
    const fatal = vi.fn()
    uploader.onFatal(fatal)
    uploader.enqueue(chunk(0))
    uploader.enqueue(chunk(1))
    await expect(uploader.idle()).rejects.toMatchObject({ status, code })
    expect(fatal).toHaveBeenCalledTimes(1)
    expect(api.confirmChunk).toHaveBeenCalledTimes(1) // no endless retry of a refused chunk
  })

  it('a 5xx or 429 from meetings-api is retried, not fatal', async () => {
    const api = happyApi()
    api.confirmChunk.mockRejectedValueOnce(problem(503)).mockRejectedValueOnce(problem(429))
    const uploader = make(api)
    uploader.enqueue(chunk(0))
    await vi.advanceTimersByTimeAsync(10_000)
    await uploader.idle()
    expect(uploader.snapshot().saved).toBe(1)
  })
})

describe('uploader: resend and release', () => {
  it('re-sends a chunk the server reports missing with a freshly minted policy, from memory', async () => {
    const api = happyApi()
    const post = okPost()
    const uploader = make(api, post)
    uploader.enqueue(chunk(0))
    uploader.enqueue(chunk(1))
    await uploader.idle()
    post.mockClear()
    api.confirmChunk.mockClear()

    expect(uploader.requeue([0])).toBe(true)
    await uploader.idle()
    expect(api.mintChunkUploadUrl).toHaveBeenCalledWith('m1', 0, 's1')
    expect(post).toHaveBeenCalledTimes(1)
    expect(api.confirmChunk.mock.calls.map(([, seq]) => seq)).toEqual([0])
  })

  it('re-sending an old chunk does not replace the policy held for the next new one', async () => {
    const api = happyApi()
    const post = okPost()
    const uploader = make(api, post)
    for (const seq of [0, 1, 2]) uploader.enqueue(chunk(seq))
    await uploader.idle()
    uploader.requeue([0])
    await uploader.idle()
    api.mintChunkUploadUrl.mockClear()
    post.mockClear()

    uploader.enqueue(chunk(3))
    await uploader.idle()
    expect(api.mintChunkUploadUrl).not.toHaveBeenCalled()
    expect((post.mock.calls[0]![0] as PresignedPost).url).toBe('https://bucket.test/seq-3')
  })

  it('cannot re-send a chunk it never held, and says so', async () => {
    const uploader = make(happyApi())
    expect(uploader.requeue([7])).toBe(false)
  })

  it('dispose drops everything it holds', async () => {
    const api = happyApi()
    const post = vi.fn<PostFn>(async () => {
      throw new TypeError('offline')
    })
    const uploader = make(api, post)
    uploader.enqueue(chunk(0))
    await vi.advanceTimersByTimeAsync(0)
    uploader.dispose()
    expect(uploader.snapshot().queued).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(post).toHaveBeenCalledTimes(1)
    expect(uploader.requeue([0])).toBe(false)
  })

  it('notifies subscribers as the queue drains', async () => {
    const uploader = make(happyApi())
    const seen: number[] = []
    uploader.subscribe(() => seen.push(uploader.snapshot().queued))
    uploader.enqueue(chunk(0))
    await uploader.idle()
    expect(seen[0]).toBe(1)
    expect(seen.at(-1)).toBe(0)
  })
})

describe('postToBucket', () => {
  it('posts the policy fields first and the file last, as an S3 presigned POST requires', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    await postToBucket(
      { url: 'https://bucket.test/', fields: { key: 'k', 'Content-Type': 'audio/webm' }, expiresAt: 'x' },
      new Blob(['abc']),
      fetchImpl,
    )
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('https://bucket.test/')
    expect(init.method).toBe('POST')
    const names = [...(init.body as FormData).keys()]
    expect(names).toEqual(['key', 'Content-Type', 'file'])
    // No credentials, no Authorization: this is the bucket, not meetings-api.
    expect(init.credentials).toBe('omit')
    expect(init.headers).toBeUndefined()
  })

  it('throws a BucketError carrying the status on a refusal', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('denied', { status: 403 }))
    await expect(
      postToBucket(
        { url: 'https://bucket.test/', fields: {}, expiresAt: 'x' },
        new Blob(['a']),
        fetchImpl,
      ),
    ).rejects.toMatchObject({ name: 'BucketError', status: 403 })
  })
})
