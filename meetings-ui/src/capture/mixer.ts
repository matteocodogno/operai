/**
 * mixer — the Web Audio graph that turns "microphone, and maybe the audio of a shared tab" into
 * ONE stream for the `MediaRecorder` (specs/021-meetings plan § Browser capture, AC-2.4/2.5):
 *
 *   microphone ──▶ MediaStreamSource ─┐
 *                                      ├─▶ MediaStreamAudioDestination ──▶ output (to the recorder)
 *   shared tab ──▶ MediaStreamSource ─┘   (the tab's VIDEO is never routed)
 *
 * The microphone always goes through the context, even alone, so the recorder has one input shape.
 * The shared tab's video track is kept alive (stopping it would end the share) but never connected
 * to anything, so no image is captured.
 *
 * The tab can go quiet while the meeting goes on: the share ends ("Stop sharing", the tab closes) or
 * it never had audio. The mixer then emits `tabAudioLost` ONCE and the recording carries on with the
 * microphone: that node is never touched. `microphoneLost` is the same for the microphone itself
 * (device unplugged, permission revoked), after which the recorder pauses and offers Resume.
 * Both events are sticky: a listener added after the event is called at once, so a share with no
 * audio at creation is still heard by the controller that subscribes right after `createMixer`.
 *
 * The mixer takes ownership of the streams it is given: `close()` stops every track, so the
 * browser's "recording" and "sharing" indicators go away.
 */

/** The parts of `AudioContext` the mixer uses, so a test supplies a fake. */
export type AudioContextLike = Pick<
  AudioContext,
  'state' | 'createMediaStreamSource' | 'createMediaStreamDestination' | 'resume' | 'close'
>

/** `getUserMedia` constraints for the microphone (plan § Browser capture): speech, mono. */
export const MIC_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
} satisfies MediaStreamConstraints

/** `getDisplayMedia` constraints for a shared tab: it needs video to be offered at all, and audio for the meeting. */
export const TAB_CONSTRAINTS = { video: true, audio: true } satisfies DisplayMediaStreamOptions

export type TabAudioLostReason =
  /** The share has no audio track (a window or screen share, or "Share tab audio" left unticked). */
  | 'no_audio_track'
  /** The share ended while recording. */
  | 'ended'

export type TabAudioState = 'none' | 'active' | 'lost'

export type MixerEvents = {
  tabAudioLost: (reason: TabAudioLostReason) => void
  microphoneLost: () => void
}

export type AudioMixer = {
  /** The mixed stream; hand it to `MediaRecorder`. */
  readonly output: MediaStream
  readonly tabAudio: TabAudioState
  /** Subscribes; returns the unsubscribe function. Events already emitted are replayed at once. */
  on<E extends keyof MixerEvents>(event: E, listener: MixerEvents[E]): () => void
  /** Disconnects, stops every track and closes the context. Safe to call twice. */
  close(): Promise<void>
}

export type MixerInput = {
  context: AudioContextLike
  microphone: MediaStream
  /** The `getDisplayMedia` stream, when the creator chose to include a shared tab. */
  tab?: MediaStream | null
}

const stopTracks = (stream: MediaStream | null | undefined) => {
  for (const track of stream?.getTracks() ?? []) track.stop()
}

const closeContext = async (context: AudioContextLike) => {
  if (context.state !== 'closed') await context.close()
}

export async function createMixer({ context, microphone, tab = null }: MixerInput): Promise<AudioMixer> {
  let destination: MediaStreamAudioDestinationNode | null = null
  const cleanups: Array<() => void> = []
  let micSource: MediaStreamAudioSourceNode | null = null
  let tabSource: MediaStreamAudioSourceNode | null = null
  let tabState: TabAudioState = 'none'

  const listeners = new Map<keyof MixerEvents, Set<(...args: never[]) => void>>()
  const fired = new Map<keyof MixerEvents, unknown[]>()

  const emit = <E extends keyof MixerEvents>(event: E, ...args: Parameters<MixerEvents[E]>) => {
    if (fired.has(event)) return // each event happens at most once
    fired.set(event, args)
    for (const listener of listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args)
  }

  const releaseEverything = () => {
    for (const cleanup of cleanups.splice(0)) cleanup()
    micSource?.disconnect()
    if (tabState === 'active') tabSource?.disconnect()
    stopTracks(microphone)
    stopTracks(tab)
    stopTracks(destination?.stream)
  }

  try {
    if (context.state === 'suspended') await context.resume()
    destination = context.createMediaStreamDestination()

    micSource = context.createMediaStreamSource(microphone)
    micSource.connect(destination)
    for (const track of microphone.getTracks()) {
      const onEnded = () => emit('microphoneLost')
      track.addEventListener('ended', onEnded)
      cleanups.push(() => track.removeEventListener('ended', onEnded))
    }

    if (tab) {
      const hasLiveAudio = tab.getAudioTracks().some((track) => track.readyState === 'live')
      if (!hasLiveAudio) {
        tabState = 'lost'
        emit('tabAudioLost', 'no_audio_track')
      } else {
        tabSource = context.createMediaStreamSource(tab)
        tabSource.connect(destination)
        tabState = 'active'
        const source = tabSource
        // Any tab track ending (the video, when the person clicks "Stop sharing", or the audio) is the share ending.
        const onTabEnded = () => {
          if (tabState !== 'active') return
          tabState = 'lost'
          source.disconnect()
          emit('tabAudioLost', 'ended')
        }
        for (const track of tab.getTracks()) {
          track.addEventListener('ended', onTabEnded)
          cleanups.push(() => track.removeEventListener('ended', onTabEnded))
        }
      }
    }
  } catch (error) {
    releaseEverything()
    await closeContext(context).catch(() => undefined)
    throw error
  }

  const output = destination.stream
  let closing: Promise<void> | null = null

  return {
    output,
    get tabAudio() {
      return tabState
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener as (...args: never[]) => void)
      listeners.set(event, set)
      const replay = fired.get(event)
      if (replay) (listener as (...a: unknown[]) => void)(...replay)
      return () => {
        set.delete(listener as (...args: never[]) => void)
      }
    },
    close() {
      closing ??= (async () => {
        releaseEverything()
        await closeContext(context)
      })()
      return closing
    },
  }
}
