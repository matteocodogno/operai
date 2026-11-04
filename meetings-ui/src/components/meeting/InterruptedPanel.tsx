import { Banner, Button, ConfirmDialog, Icon, formatDuration } from '@operai/ui'
import { useState } from 'react'
import { codeOf, errorMessage } from '../../lib/errors'
import { discardRecording, processInterrupted } from '../../lib/meetingsApi'
import type { Meeting } from '../../lib/types'
import { strings } from '../../strings'

export type InterruptedPanelProps = {
  meeting: Meeting
  /** The server's fresh view after a write, so the page replaces its copy. */
  onChanged: (meeting: Meeting) => void
}

const t = strings.capture.interrupted

/**
 * The panel for a recording that stopped without being saved: a closed tab, a crash, or two minutes with
 * neither audio nor keep-alive (F5, AC-2.8, AC-2.9). The duration kept is always shown; for the creator,
 * `recording.lostMs` says how much audio captured offline was lost, as a LOWER bound ("at least …"), or
 * the fallback sentence when the server never learned how much was captured (`null`). Two actions: process
 * what was captured, or discard it after a confirmation.
 */
export default function InterruptedPanel({ meeting, onChanged }: InterruptedPanelProps) {
  const [busy, setBusy] = useState(false)
  const [processError, setProcessError] = useState<string | null>(null)
  /** The server said the audio was deleted meanwhile (409 `audio_deleted`). */
  const [expired, setExpired] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [discardError, setDiscardError] = useState<string | null>(null)

  const creator = meeting.role === 'creator'
  const canAct = creator && meeting.can.capture
  const savedMs = meeting.recording?.durationMs ?? meeting.durationMs ?? 0
  const audioDeleted = expired || meeting.audio.state === 'deleted'
  // Process needs something to process: audio that is still there, and some of it saved.
  const canProcess = canAct && !audioDeleted && savedMs > 0

  // lostMs is the creator's: a number above 0 is a lower bound, null is "we do not know", 0 is nothing lost.
  const lostMs = meeting.recording?.lostMs ?? null
  const lostLine =
    !creator || lostMs === 0
      ? null
      : lostMs === null
        ? t.lostUnknown
        : t.lostAtLeast(formatDuration(lostMs, { style: 'spoken' }))

  const runProcess = async () => {
    setBusy(true)
    setProcessError(null)
    try {
      onChanged(await processInterrupted(meeting.id))
    } catch (error) {
      // The audio expired while the panel was open: say so, and only Discard is left.
      if (codeOf(error) === 'audio_deleted') setExpired(true)
      else setProcessError(errorMessage(error))
      setBusy(false)
    }
  }

  const discard = async () => {
    setDiscarding(true)
    setDiscardError(null)
    try {
      const draft = await discardRecording(meeting.id)
      setConfirming(false)
      onChanged(draft)
    } catch (error) {
      setDiscardError(errorMessage(error))
    } finally {
      setDiscarding(false)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="meetings-interrupted-panel">
      <Banner
        tone="warning"
        title={savedMs > 0 ? t.title(formatDuration(savedMs, { style: 'spoken' })) : t.titleEmpty}
        data-testid="meetings-interrupted-banner"
      >
        {lostLine}
      </Banner>

      {!creator && (
        <Banner tone="info" data-testid="meetings-interrupted-observer">
          {t.observer}
        </Banner>
      )}

      {audioDeleted && canAct && (
        <Banner tone="info" data-testid="meetings-interrupted-expired">
          {t.expired}
        </Banner>
      )}

      {processError && (
        <Banner tone="danger" data-testid="meetings-interrupted-error">
          {processError}
        </Banner>
      )}

      {canAct && (
        <div className="flex flex-wrap gap-2">
          {canProcess && (
            <Button
              variant="primary"
              busy={busy}
              disabled={busy}
              onClick={() => void runProcess()}
              data-testid="meetings-interrupted-process"
            >
              {busy ? t.processing : t.process}
            </Button>
          )}
          <Button
            variant="danger"
            aria-haspopup="dialog"
            disabled={busy}
            onClick={() => {
              setDiscardError(null)
              setConfirming(true)
            }}
            data-testid="meetings-interrupted-discard"
          >
            <Icon name="trash" /> {t.discard}
          </Button>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={t.discardTitle}
          confirmLabel={t.discardConfirm}
          busyLabel={t.discarding}
          cancelLabel={strings.common.cancel}
          closeLabel={strings.common.close}
          busy={discarding}
          error={discardError}
          onConfirm={() => void discard()}
          onCancel={() => setConfirming(false)}
          testIdPrefix="meetings-interrupted-discard-dialog"
        >
          {t.discardBody}
        </ConfirmDialog>
      )}
    </div>
  )
}
