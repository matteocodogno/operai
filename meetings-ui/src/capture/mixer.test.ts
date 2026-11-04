import { describe, expect, it, vi } from 'vitest'
import { MIC_CONSTRAINTS, TAB_CONSTRAINTS, createMixer } from './mixer'
import type { AudioContextLike } from './mixer'

// ─── Fakes: just enough of MediaStream, MediaStreamTrack and AudioContext ──────────────────────

class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live'
  stopCalls = 0
  readonly kind: 'audio' | 'video'
  constructor(kind: 'audio' | 'video') {
    super()
    this.kind = kind
  }
  stop() {
    this.stopCalls += 1
    this.readyState = 'ended'
  }
  /** The browser ends the track (the user stops sharing, the device is unplugged). */
  end() {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  }
}

class FakeStream {
  readonly tracks: FakeTrack[]
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio')
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video')
  }
  getTracks() {
    return this.tracks
  }
}

class FakeNode {
  connectedTo: unknown[] = []
  disconnectCalls = 0
  readonly stream?: FakeStream
  constructor(stream?: FakeStream) {
    this.stream = stream
  }
  connect(destination: unknown) {
    this.connectedTo.push(destination)
    return destination
  }
  disconnect() {
    this.disconnectCalls += 1
    this.connectedTo = []
  }
}

class FakeContext {
  state: 'suspended' | 'running' | 'closed' = 'running'
  sources: FakeNode[] = []
  destination = new FakeNode(new FakeStream([new FakeTrack('audio')]))
  closeCalls = 0
  resumeCalls = 0
  failSourceFor: FakeStream | null = null
  createMediaStreamSource(stream: FakeStream) {
    if (stream === this.failSourceFor) throw new DOMException('no audio track', 'InvalidStateError')
    const node = new FakeNode(stream)
    this.sources.push(node)
    return node
  }
  createMediaStreamDestination() {
    return this.destination
  }
  async resume() {
    this.resumeCalls += 1
    this.state = 'running'
  }
  async close() {
    this.closeCalls += 1
    this.state = 'closed'
  }
}

const audio = () => new FakeTrack('audio')
const video = () => new FakeTrack('video')

function setup(options: { tab?: FakeStream | null; state?: FakeContext['state'] } = {}) {
  const context = new FakeContext()
  if (options.state) context.state = options.state
  const microphone = new FakeStream([audio()])
  const tab = options.tab === undefined ? null : options.tab
  const create = () =>
    createMixer({
      context: context as unknown as AudioContextLike,
      microphone: microphone as unknown as MediaStream,
      tab: tab as unknown as MediaStream | null,
    })
  return { context, microphone, tab, create }
}

/** The source node the context made for a given input stream. */
const sourceFor = (context: FakeContext, stream: FakeStream) => context.sources.find((node) => node.stream === stream)

describe('microphone only', () => {
  it('routes the microphone to the destination and hands out the destination stream', async () => {
    const { context, microphone, create } = setup()
    const mixer = await create()
    expect(sourceFor(context, microphone)?.connectedTo).toEqual([context.destination])
    expect(mixer.output).toBe(context.destination.stream)
    expect(mixer.tabAudio).toBe('none')
  })

  it('creates no node for a tab that was never offered', async () => {
    const { context, create } = setup()
    await create()
    expect(context.sources).toHaveLength(1)
  })

  it('resumes a suspended context first (Safari starts audio contexts suspended)', async () => {
    const { context, create } = setup({ state: 'suspended' })
    await create()
    expect(context.resumeCalls).toBe(1)
    expect(context.state).toBe('running')
  })

  it('does not resume a running context', async () => {
    const { context, create } = setup()
    await create()
    expect(context.resumeCalls).toBe(0)
  })
})

describe('microphone and a shared tab (AC-2.4)', () => {
  it('routes both to the same destination', async () => {
    const tab = new FakeStream([video(), audio()])
    const { context, microphone, create } = setup({ tab })
    const mixer = await create()
    expect(sourceFor(context, microphone)?.connectedTo).toEqual([context.destination])
    expect(sourceFor(context, tab)?.connectedTo).toEqual([context.destination])
    expect(mixer.tabAudio).toBe('active')
  })

  it('never stops or routes the shared video: it is kept alive so the share lasts, and no image is captured', async () => {
    const shared = video()
    const tab = new FakeStream([shared, audio()])
    const { context, create } = setup({ tab })
    await create()
    expect(shared.stopCalls).toBe(0)
    // One source node for the tab stream, and nothing in the graph is a video node: the destination only carries audio.
    expect(context.destination.stream?.getVideoTracks()).toEqual([])
  })
})

describe('the shared tab has no audio (AC-2.5)', () => {
  it('a share with no audio track emits tabAudioLost, even to a listener added after creation', async () => {
    const tab = new FakeStream([video()])
    const { create } = setup({ tab })
    const mixer = await create()
    const lost = vi.fn()
    mixer.on('tabAudioLost', lost)
    expect(lost).toHaveBeenCalledExactlyOnceWith('no_audio_track')
    expect(mixer.tabAudio).toBe('lost')
  })

  it('still routes the microphone, and makes no node for the silent tab', async () => {
    const tab = new FakeStream([video()])
    const { context, microphone, create } = setup({ tab })
    await create()
    expect(sourceFor(context, microphone)?.connectedTo).toEqual([context.destination])
    expect(sourceFor(context, tab)).toBeUndefined()
  })

  it('a tab whose audio track had already ended counts as lost too', async () => {
    const dead = audio()
    dead.readyState = 'ended'
    const { create } = setup({ tab: new FakeStream([video(), dead]) })
    const mixer = await create()
    const lost = vi.fn()
    mixer.on('tabAudioLost', lost)
    expect(lost).toHaveBeenCalledWith('no_audio_track')
  })
})

describe('the share ends mid-recording (AC-2.5)', () => {
  it('emits tabAudioLost when the tab audio track ends', async () => {
    const tabAudio = audio()
    const tab = new FakeStream([video(), tabAudio])
    const { create } = setup({ tab })
    const mixer = await create()
    const lost = vi.fn()
    mixer.on('tabAudioLost', lost)
    expect(lost).not.toHaveBeenCalled()
    tabAudio.end()
    expect(lost).toHaveBeenCalledExactlyOnceWith('ended')
    expect(mixer.tabAudio).toBe('lost')
  })

  it('the microphone keeps feeding: its node stays connected and is never disconnected', async () => {
    const tabAudio = audio()
    const tab = new FakeStream([video(), tabAudio])
    const { context, microphone, create } = setup({ tab })
    const mixer = await create()
    tabAudio.end()
    const micNode = sourceFor(context, microphone)!
    expect(micNode.connectedTo).toEqual([context.destination])
    expect(micNode.disconnectCalls).toBe(0)
    expect(sourceFor(context, tab)!.disconnectCalls).toBe(1)
    expect(mixer.output).toBe(context.destination.stream)
    expect(context.closeCalls).toBe(0)
  })

  it('"Stop sharing" ends the video track first: that is the share ending, so it is lost too', async () => {
    const shared = video()
    const tabAudio = audio()
    const tab = new FakeStream([shared, tabAudio])
    const { create } = setup({ tab })
    const mixer = await create()
    const lost = vi.fn()
    mixer.on('tabAudioLost', lost)
    shared.end()
    expect(lost).toHaveBeenCalledExactlyOnceWith('ended')
  })

  it('emits once, however many of the tab tracks end', async () => {
    const shared = video()
    const tabAudio = audio()
    const { create } = setup({ tab: new FakeStream([shared, tabAudio]) })
    const mixer = await create()
    const lost = vi.fn()
    mixer.on('tabAudioLost', lost)
    shared.end()
    tabAudio.end()
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('a listener added after the loss still hears it once', async () => {
    const tabAudio = audio()
    const { create } = setup({ tab: new FakeStream([video(), tabAudio]) })
    const mixer = await create()
    tabAudio.end()
    const late = vi.fn()
    mixer.on('tabAudioLost', late)
    expect(late).toHaveBeenCalledExactlyOnceWith('ended')
  })

  it('an unsubscribed listener hears nothing', async () => {
    const tabAudio = audio()
    const { create } = setup({ tab: new FakeStream([video(), tabAudio]) })
    const mixer = await create()
    const lost = vi.fn()
    const unsubscribe = mixer.on('tabAudioLost', lost)
    unsubscribe()
    tabAudio.end()
    expect(lost).not.toHaveBeenCalled()
  })
})

describe('the microphone itself ends', () => {
  it('emits microphoneLost (the recorder pauses and offers Resume) and leaves the tab audio alone', async () => {
    const tab = new FakeStream([video(), audio()])
    const { context, microphone, create } = setup({ tab })
    const mixer = await create()
    const micLost = vi.fn()
    const tabLost = vi.fn()
    mixer.on('microphoneLost', micLost)
    mixer.on('tabAudioLost', tabLost)
    microphone.tracks[0]!.end()
    expect(micLost).toHaveBeenCalledTimes(1)
    expect(tabLost).not.toHaveBeenCalled()
    expect(sourceFor(context, tab)!.disconnectCalls).toBe(0)
  })
})

describe('microphoneLost is emitted once', () => {
  it('even when several microphone tracks end together (a device with two inputs)', async () => {
    const context = new FakeContext()
    const microphone = new FakeStream([audio(), audio()])
    const mixer = await createMixer({
      context: context as unknown as AudioContextLike,
      microphone: microphone as unknown as MediaStream,
    })
    const lost = vi.fn()
    mixer.on('microphoneLost', lost)
    for (const track of microphone.tracks) track.end()
    expect(lost).toHaveBeenCalledTimes(1)
  })
})

describe('close', () => {
  it('disconnects every node, stops every track it was given and the output, and closes the context', async () => {
    const shared = video()
    const tabAudio = audio()
    const tab = new FakeStream([shared, tabAudio])
    const { context, microphone, create } = setup({ tab })
    const mixer = await create()
    await mixer.close()
    expect(sourceFor(context, microphone)!.disconnectCalls).toBe(1)
    expect(sourceFor(context, tab)!.disconnectCalls).toBe(1)
    for (const track of [...microphone.tracks, shared, tabAudio, ...context.destination.stream!.tracks]) {
      expect(track.stopCalls).toBe(1)
    }
    expect(context.closeCalls).toBe(1)
  })

  it('is safe to call twice', async () => {
    const { context, create } = setup()
    const mixer = await create()
    await mixer.close()
    await mixer.close()
    expect(context.closeCalls).toBe(1)
  })

  it('does not close a context that is already closed', async () => {
    const { context, create } = setup()
    const mixer = await create()
    context.state = 'closed'
    await mixer.close()
    expect(context.closeCalls).toBe(0)
  })

  it('stops listening: a track ending afterwards emits nothing', async () => {
    const tabAudio = audio()
    const { create } = setup({ tab: new FakeStream([video(), tabAudio]) })
    const mixer = await create()
    const lost = vi.fn()
    mixer.on('tabAudioLost', lost)
    await mixer.close()
    tabAudio.end()
    expect(lost).not.toHaveBeenCalled()
  })
})

describe('a mixer that cannot be built releases what it was given', () => {
  it('stops both streams and closes the context, then rethrows', async () => {
    const shared = video()
    const tab = new FakeStream([shared, audio()])
    const { context, microphone, create } = setup({ tab })
    context.failSourceFor = microphone
    await expect(create()).rejects.toThrow('no audio track')
    expect(microphone.tracks[0]!.stopCalls).toBe(1)
    expect(shared.stopCalls).toBe(1)
    expect(tab.getAudioTracks()[0]!.stopCalls).toBe(1)
    expect(context.closeCalls).toBe(1)
  })
})

describe('constraints (plan § Browser capture)', () => {
  it('asks the microphone for echo cancellation and noise suppression, mono', () => {
    expect(MIC_CONSTRAINTS).toEqual({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
  })

  it('asks the display for video (the share needs it) and audio', () => {
    expect(TAB_CONSTRAINTS).toEqual({ video: true, audio: true })
  })
})
