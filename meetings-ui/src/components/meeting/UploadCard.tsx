import { Banner, Button, Card, FilePicker, Icon, ProgressBar, VisuallyHidden, formatNumber } from '@operai/ui'
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../lib/api'
import { codeOf, errorMessage } from '../../lib/errors'
import { confirmUpload, requestUpload } from '../../lib/meetingsApi'
import type { Meeting, PresignedPost } from '../../lib/types'
import { strings } from '../../strings'

export type UploadCardProps = {
  meeting: Meeting
  /** The server's fresh view after a write, so the page replaces its copy. */
  onChanged: (meeting: Meeting) => void
}

const t = strings.upload

const KIB = 1024
const MIB = KIB * KIB
const GIB = MIB * KIB

/** AC-3.1: at most 500 MiB and 3 hours. The server checks both again; this only saves the wait. */
const MAX_UPLOAD_BYTES = 500 * MIB
const MAX_DURATION_SECONDS = 3 * 3600
/** How long to wait for a file's metadata before giving up on the client-side length check. */
const METADATA_TIMEOUT_MS = 8_000

type ProblemKey = keyof typeof t.problems

const isProblemKey = (value: unknown): value is ProblemKey =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(t.problems, value)

/** The size next to the file's name, in the binary units the 500 MiB limit is stated in (not the library's kB/MB). */
const formatFileSize = (bytes: number): string => {
  if (bytes < KIB) return t.size.bytes(formatNumber(bytes))
  if (bytes < MIB) return t.size.kib(formatNumber(bytes / KIB, { maximumFractionDigits: 0 }))
  if (bytes < GIB) return t.size.mib(formatNumber(bytes / MIB, { maximumFractionDigits: 1 }))
  return t.size.gib(formatNumber(bytes / GIB, { maximumFractionDigits: 1 }))
}

/** What some systems report as no type at all, or as a generic one, for a recording. */
const BY_EXTENSION: Record<string, string> = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  weba: 'audio/webm',
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
}

/** The content type to upload under: the file's own when it is audio or video, else from its extension, else none. */
function contentTypeOf(file: File): string | null {
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) return file.type
  if (file.type === '' || file.type === 'application/octet-stream') {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
    return BY_EXTENSION[extension] ?? null
  }
  return null
}

/**
 * The length of a recording, from its metadata (`loadedmetadata`), or null when the browser cannot say:
 * an unreadable container, a stream with no length, or no answer in time. Null is not a verdict; the
 * server measures the length itself (AC-3.2).
 */
function readDuration(file: File, contentType: string): Promise<number | null> {
  return new Promise((resolve) => {
    const element = document.createElement(contentType.startsWith('video/') ? 'video' : 'audio')
    let objectUrl: string | null = null
    const finish = (seconds: number | null) => {
      clearTimeout(timer)
      element.removeAttribute('src')
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      resolve(seconds)
    }
    const timer = setTimeout(() => finish(null), METADATA_TIMEOUT_MS)
    element.preload = 'metadata'
    element.addEventListener(
      'loadedmetadata',
      () => finish(Number.isFinite(element.duration) ? element.duration : null),
      {
        once: true,
      },
    )
    element.addEventListener('error', () => finish(null), { once: true })
    try {
      objectUrl = URL.createObjectURL(file)
      element.src = objectUrl
    } catch {
      finish(null)
    }
  })
}

async function precheck(file: File): Promise<ProblemKey | null> {
  const contentType = contentTypeOf(file)
  if (contentType === null) return 'unsupported_type'
  if (file.size === 0) return 'empty'
  if (file.size > MAX_UPLOAD_BYTES) return 'too_large'
  const seconds = await readDuration(file, contentType)
  return seconds !== null && seconds > MAX_DURATION_SECONDS ? 'too_long' : null
}

/** The bucket answered with something other than success, or the connection broke. */
class UploadFailed extends Error {}
/** The request was aborted: by the person (Cancel), or by the browser. */
class UploadAborted extends Error {}

/**
 * POSTs the file to its presigned policy with progress: the policy's fields first and the file last, no
 * credentials, no Authorization (this is the bucket, not meetings-api). `register` receives the abort.
 */
function postFile(
  policy: PresignedPost,
  file: File,
  onProgress: (fraction: number) => void,
  register: (abort: () => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', policy.url)
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    })
    request.addEventListener('load', () =>
      request.status >= 200 && request.status < 300 ? resolve() : reject(new UploadFailed()),
    )
    request.addEventListener('error', () => reject(new UploadFailed()))
    request.addEventListener('timeout', () => reject(new UploadFailed()))
    request.addEventListener('abort', () => reject(new UploadAborted()))
    const form = new FormData()
    for (const [name, value] of Object.entries(policy.fields)) form.append(name, value)
    form.append('file', file)
    register(() => request.abort())
    request.send(form)
  })
}

type Stage = 'idle' | 'checking' | 'uploading' | 'finishing' | 'failed' | 'cancelled'

export default function UploadCard({ meeting, onChanged }: UploadCardProps) {
  const [file, setFile] = useState<File | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>('idle')
  const [percent, setPercent] = useState(0)
  const [failure, setFailure] = useState<string>(t.failed)

  const checkToken = useRef(0)
  const abortRef = useRef<(() => void) | null>(null)
  const cancelRequested = useRef(false)

  // Leaving the page abandons an upload in flight rather than leaving it running unseen.
  useEffect(() => () => abortRef.current?.(), [])

  const pick = (chosen: File | null) => {
    checkToken.current += 1
    const token = checkToken.current
    setFile(chosen)
    setFieldError(null)
    if (!chosen) {
      setStage('idle')
      return
    }
    setStage('checking')
    void precheck(chosen).then((problem) => {
      if (token !== checkToken.current) return // another file was chosen meanwhile
      if (problem) setFieldError(t.problems[problem])
      setStage('idle')
    })
  }

  /** The file is refused (by the pre-check's twin on the server): name the reason on the field and start over. */
  const refuse = (reason: unknown) => {
    checkToken.current += 1
    setFile(null)
    setFieldError(isProblemKey(reason) ? t.problems[reason] : t.rejectedUnknown)
    setStage('idle')
  }

  const upload = async () => {
    if (!file) return
    const contentType = contentTypeOf(file)
    if (contentType === null) return
    cancelRequested.current = false
    setFieldError(null)
    setPercent(0)
    setStage('uploading')
    try {
      const policy = await requestUpload(meeting.id, { contentType, sizeBytes: file.size })
      if (cancelRequested.current) throw new UploadAborted()
      await postFile(
        policy,
        file,
        (fraction) => setPercent(Math.round(fraction * 100)),
        (abort) => {
          abortRef.current = abort
        },
      )
      abortRef.current = null
      setStage('finishing')
      onChanged(await confirmUpload(meeting.id))
    } catch (error) {
      abortRef.current = null
      if (error instanceof UploadAborted) {
        setStage(cancelRequested.current ? 'cancelled' : 'failed')
        setFailure(t.failed)
      } else if (error instanceof UploadFailed) {
        setFailure(t.failed)
        setStage('failed')
      } else if (error instanceof ApiError && codeOf(error) === 'upload_rejected') {
        refuse(error.extras['reason'])
      } else if (error instanceof ApiError && (codeOf(error) === 'unsupported_type' || codeOf(error) === 'too_large')) {
        refuse(codeOf(error))
      } else {
        // `upload_incomplete` means the object is not all there; like any other failure the answer is to try again.
        setFailure(codeOf(error) === 'upload_incomplete' ? t.failed : errorMessage(error))
        setStage('failed')
      }
    }
  }

  const cancel = () => {
    cancelRequested.current = true
    abortRef.current?.()
  }

  // The card is for the creator with the attestation in hand (AC-2.1's twin): no file picker without it.
  if (meeting.consent === null || !meeting.can.capture) return null

  const busy = stage === 'uploading' || stage === 'finishing'
  const quarter = Math.floor(percent / 25)
  const announcement =
    stage === 'uploading'
      ? quarter === 0
        ? t.announcements.started
        : t.progress(formatNumber((quarter * 25) / 100, { style: 'percent' }))
      : stage === 'finishing'
        ? t.announcements.complete
        : ''

  return (
    <Card title={t.title} data-testid="meetings-upload-card">
      <FilePicker
        label={t.fileLabel}
        chooseLabel={t.choose}
        clearLabel={t.clear}
        emptyText={t.empty}
        file={file}
        onChange={pick}
        accept="audio/*,video/*"
        hint={t.hint}
        error={fieldError}
        disabled={busy}
        formatSize={formatFileSize}
        testId="meetings-upload-picker"
        inputTestId="meetings-upload-input"
        chooseTestId="meetings-upload-choose"
      />

      {stage === 'checking' && (
        <p role="status" className="mt-2 text-xs text-soft">
          {t.checking}
        </p>
      )}

      {busy && (
        <div className="mt-4 flex flex-wrap items-center gap-3" data-testid="meetings-upload-progress">
          <ProgressBar
            className="flex-1"
            label={t.progressLabel}
            value={stage === 'uploading' ? percent : undefined}
            valueText={
              stage === 'uploading' ? t.progress(formatNumber(percent / 100, { style: 'percent' })) : t.finishing
            }
          />
          {stage === 'uploading' && (
            <Button variant="ghost" onClick={cancel} data-testid="meetings-upload-cancel">
              {t.cancel}
            </Button>
          )}
        </div>
      )}

      {stage === 'failed' && (
        <Banner tone="danger" onRetry={() => void upload()} retryLabel={t.retry} data-testid="meetings-upload-failed">
          {failure}
        </Banner>
      )}
      {stage === 'cancelled' && (
        <Banner tone="info" onRetry={() => void upload()} retryLabel={t.retry} data-testid="meetings-upload-cancelled">
          {t.cancelled}
        </Banner>
      )}

      {(stage === 'idle' || stage === 'checking') && (
        <div className="mt-4">
          <Button
            variant="primary"
            disabled={!file || fieldError !== null || stage === 'checking'}
            onClick={() => void upload()}
            data-testid="meetings-upload-submit"
          >
            <Icon name="upload" /> {t.submit}
          </Button>
        </div>
      )}

      <VisuallyHidden live role="status" data-testid="meetings-upload-announcements">
        {announcement}
      </VisuallyHidden>
    </Card>
  )
}
