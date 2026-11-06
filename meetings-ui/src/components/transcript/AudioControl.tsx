import { formatDate } from '@operai/ui'
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import { useResource } from '../../hooks/useResource'
import { errorMessage } from '../../lib/errors'
import { getAudioUrl } from '../../lib/meetingsApi'
import type { Meeting } from '../../lib/types'
import { strings } from '../../strings'

export type AudioHandle = {
  /** Seeks to `ms` and plays (AC-6.5). */
  playFrom: (ms: number) => void
}

export type AudioControlProps = {
  meeting: Meeting
  ref?: Ref<AudioHandle>
}

/**
 * The audio of a meeting (S3b): a native player while the audio is kept, "Audio kept until <date>",
 * or "Audio deleted". The presigned URL lives 15 minutes, so a media error mints a new one — once,
 * until playback has worked again — and resumes where it stopped.
 */
export function AudioControl({ meeting, ref }: AudioControlProps) {
  if (meeting.audio.state === 'none') return null
  if (meeting.audio.state === 'deleted') {
    return (
      <p className="text-xs text-soft" data-testid="meetings-audio-deleted">
        {strings.audio.deleted}
      </p>
    )
  }
  return <KeptAudio meetingId={meeting.id} until={meeting.audio.until} ref={ref} />
}

function KeptAudio({ meetingId, until, ref }: { meetingId: string; until: string; ref?: Ref<AudioHandle> }) {
  // The first URL is minted when the audio first shows; later ones come from a media error.
  const fetcher = useCallback((signal: AbortSignal) => getAudioUrl(meetingId, { signal }), [meetingId])
  const first = useResource(fetcher)
  const [replacement, setReplacement] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const player = useRef<HTMLAudioElement>(null)
  // Where to seek once the (new) source knows its length.
  const seekTo = useRef<number | null>(null)
  const retried = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const url = replacement ?? first.data?.url ?? null
  const shownFailure = failure ?? (first.status === 'error' ? errorMessage(first.error) : null)

  const remint = async () => {
    try {
      const minted = await getAudioUrl(meetingId)
      if (!mounted.current) return
      setFailure(null)
      setReplacement(minted.url)
    } catch (error) {
      if (mounted.current) setFailure(errorMessage(error))
    }
  }

  useImperativeHandle(ref, () => ({
    playFrom: (ms) => {
      const element = player.current
      if (element === null) return
      element.currentTime = ms / 1000
      void element.play()?.catch(() => undefined)
    },
  }))

  const onError = () => {
    if (retried.current) {
      setFailure(strings.audio.playbackFailed)
      return
    }
    retried.current = true
    seekTo.current = player.current?.currentTime ?? null
    void remint()
  }

  const onLoadedMetadata = () => {
    if (seekTo.current === null || player.current === null) return
    player.current.currentTime = seekTo.current
    seekTo.current = null
  }

  return (
    <div className="flex flex-col gap-1" data-testid="meetings-audio">
      {url !== null && (
        <audio
          ref={player}
          src={url}
          controls
          preload="metadata"
          aria-label={strings.audio.label}
          className="w-full"
          onError={onError}
          onLoadedMetadata={onLoadedMetadata}
          onCanPlay={() => {
            retried.current = false
          }}
        />
      )}
      {shownFailure !== null && (
        <p role="alert" className="form-error">
          {shownFailure}
        </p>
      )}
      <p className="text-xs text-soft">{strings.audio.keptUntil(formatDate(until))}</p>
    </div>
  )
}
