import { Field, FormDialog } from '@operai/ui'
import { useState } from 'react'
import { errorMessage } from '../../lib/errors'
import { setSpeaker } from '../../lib/meetingsApi'
import type { Participant, Speaker } from '../../lib/types'
import { strings } from '../../strings'
import { partsText, speakerLabelText } from './exportText'

export const SPEAKER_NAME_MAX = 100

const DEFAULT = '@default'
const CUSTOM = '@custom'

export type SpeakerRenameDialogProps = {
  meetingId: string
  speaker: Speaker
  /** What the speaker is called now, for the dialog's heading context. */
  currentName: string
  participants: Participant[]
  onSaved: (speaker: Speaker) => void
  onClose: () => void
}

const initialChoice = (speaker: Speaker): string =>
  speaker.label.kind === 'participant' ? speaker.label.participantId : speaker.label.kind === 'text' ? CUSTOM : DEFAULT

/** Rename a speaker: a participant, free text (1-100), or back to "Speaker n" — applied to all its segments (AC-6.2). */
export function SpeakerRenameDialog({
  meetingId,
  speaker,
  currentName,
  participants,
  onSaved,
  onClose,
}: SpeakerRenameDialogProps) {
  const [choice, setChoice] = useState(initialChoice(speaker))
  const [text, setText] = useState(speaker.label.kind === 'text' ? speaker.label.text : '')
  const [nameError, setNameError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const submit = async () => {
    let value: Parameters<typeof setSpeaker>[2]
    if (choice === DEFAULT) value = null
    else if (choice === CUSTOM) {
      const name = text.trim()
      if (name === '') return setNameError(strings.transcript.nameRequired)
      if (name.length > SPEAKER_NAME_MAX) return setNameError(strings.transcript.nameTooLong)
      value = { text: name }
    } else value = { participantId: choice }
    setNameError(null)
    setFailure(null)
    setBusy(true)
    try {
      onSaved(await setSpeaker(meetingId, speaker.key, value))
    } catch (error) {
      setBusy(false)
      setFailure(errorMessage(error))
    }
  }

  return (
    <FormDialog
      title={strings.transcript.renameTitle}
      description={[
        `${currentName}.`,
        strings.transcript.renameDescription,
        speaker.joined ? `${strings.transcript.joined.note(partsText(speaker.parts))}.` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' ')}
      submitLabel={strings.transcript.renameSubmit}
      busyLabel={strings.transcript.saving}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      error={failure}
      onSubmit={() => void submit()}
      onCancel={onClose}
      testIdPrefix="meetings-rename-speaker"
    >
      <div className="flex flex-col gap-3">
        <Field label={strings.transcript.whoSpoke}>
          {(control) => (
            <select {...control} value={choice} onChange={(event) => setChoice(event.target.value)}>
              <option value={DEFAULT}>{strings.transcript.optionDefault}</option>
              {participants.map((participant) => (
                <option key={participant.id} value={participant.id}>
                  {speakerLabelText({ kind: 'participant', participantId: participant.id }, participants)}
                </option>
              ))}
              <option value={CUSTOM}>{strings.transcript.optionCustom}</option>
            </select>
          )}
        </Field>
        {choice === CUSTOM && (
          <Field label={strings.transcript.nameLabel} error={nameError} required>
            {(control) => <input {...control} value={text} onChange={(event) => setText(event.target.value)} />}
          </Field>
        )}
      </div>
    </FormDialog>
  )
}
