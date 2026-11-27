import { useCallback, useMemo, useRef, useState } from 'react'
import { Button, CheckboxGroupField, DateInput, Field, FormDialog, PersonChips, focusFirstInvalid } from '@operai/ui'
import {
  RichTextFilesField,
  imageFileIds,
  isLocalFileId,
  useDeferredFiles,
  withoutLocalImages,
} from '@operai/ui/rich-text'
import type { RichTextDoc } from '@operai/ui/rich-text'
import { createTask, listProjectTasks, updateTask } from '../lib/activitiesApi'
import type { ProjectTask } from '../lib/activitiesApi'
import { ApiError } from '../lib/api'
import { codeOf, fieldErrorOf, taskErrorMessage } from '../lib/errors'
import { personName } from '../lib/people'
import { peopleOnProject } from '../lib/recordHours'
import type { Person, Project } from '../lib/types'
import { first, hasErrors, maxLength, required } from '../lib/validate'
import type { Errors } from '../lib/validate'
import {
  ATTACHMENT_ACCEPT,
  IMAGE_ACCEPT,
  MAX_FILES_PER_TASK,
  deferredOf,
  filesWarning,
  openTaskFile,
  saveDeferredFiles,
  taskFileProblem,
  taskFileUrlResolver,
} from '../lib/taskFiles'
import { useResource } from '../hooks/useResource'
import { strings } from '../strings'
import PersonPicker from './PersonPicker'
import type { PersonChoice } from './PersonPicker'
import { refName } from './TaskModel'

type ProjectPeople = Pick<Project, 'projectManager' | 'team' | 'onProject'>

type FieldName = 'subject' | 'description' | 'dueDate' | 'assignee' | 'blockedByIds' | 'participants'

/** A description holds at most this many characters of text (the server caps its JSON at 128 KiB). */
const DESCRIPTION_MAX_CHARS = 20_000

const noStoredImages = () => Promise.reject(new Error('not saved yet'))

/** The server's caps on a task's blockers (AC-4.1) and participants (AC-5.1). */
const MAX_BLOCKERS = 10
const MAX_PARTICIPANTS = 10

/** Server field names that are not this form's field names. */
const SERVER_FIELDS: Record<string, FieldName> = {
  subject: 'subject',
  description: 'description',
  dueDate: 'dueDate',
  assigneeUserId: 'assignee',
  blockedByIds: 'blockedByIds',
  participantIds: 'participants',
}

/**
 * Who a task can be assigned to (AC-3.1, teams AC-5.2): the people `onProject` names, minus the deactivated. A project
 * from a deal has no project manager until its ops-manager picks one (specs/20261103-projects-handoff D42): then
 * only the others.
 */
const assignable = (project: ProjectPeople): Person[] => peopleOnProject(project).filter((person) => !person.deleted)

/**
 * TaskFormDialog — add a task to a project, or edit one (F2, F3, F6). Title is
 * required; the due date and the assignee are optional (empty = the author,
 * AC-3.1); blockers are the project's other open tasks, at most 10 (AC-4.1);
 * participants are module users, at most 10 (AC-5.1). The dialog can only make
 * a task (AC-3.6): there is no type to choose.
 *
 * An assignee who left the team stays selected and is resent unchanged, which
 * the server accepts (AC-3.7, teams AC-5.2); once someone else is picked they leave the list. While the
 * teams could not be loaded (`onProjectComplete` false) the list holds the known part and says so; a
 * current assignee it does not hold is then only "not listed", never "no longer on the project", because
 * that is not known (design G10).
 * Refusals stay inline, name the field when the server did, and keep every
 * typed value (dialog rules).
 */
export default function TaskFormDialog({
  project,
  task,
  currentUserId,
  onSaved,
  onCancel,
  onHostReadOnly,
}: {
  project: Pick<Project, 'id' | 'projectManager' | 'team' | 'onProject' | 'onProjectComplete'>
  task?: ProjectTask
  currentUserId: string | null
  /** The task was saved: `message` is the confirmation for the card to announce. */
  onSaved: (message: string) => void
  onCancel: () => void
  /** The project was closed meanwhile (409 `host_read_only`): the list reloads to show fresh flags. */
  onHostReadOnly: () => void
}) {
  const t = strings.tasks.form
  const people = assignable(project)
  const [subject, setSubject] = useState(task?.subject ?? '')
  // The task's text is its rich description (ADR 20261113-task-description-files-in-activities-api-bucket); its files wait for the save.
  const [description, setDescription] = useState<RichTextDoc | null>(task?.task.description ?? null)
  const storedFiles = useMemo(() => deferredOf(task?.task.files), [task])
  const files = useDeferredFiles(storedFiles)
  const tf = strings.tasks.files
  const [dueDate, setDueDate] = useState(task?.task.dueDate ?? '')
  const [assignee, setAssignee] = useState(() => {
    if (task) return task.task.assignee?.id ?? ''
    return people.some((person) => person.id === currentUserId) ? (currentUserId ?? '') : ''
  })
  const [blockedByIds, setBlockedByIds] = useState<string[]>(() => task?.task.blockedBy?.map((b) => b.id) ?? [])
  const participantsRef = useRef<HTMLDivElement>(null)
  const [participants, setParticipants] = useState<PersonChoice[]>(
    () => task?.participants?.map((person) => ({ id: person.id, label: refName(person) })) ?? [],
  )
  const [errors, setErrors] = useState<Errors<FieldName>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldsRef = useRef<HTMLDivElement>(null)

  const loadOpenTasks = useCallback(
    (signal: AbortSignal) => listProjectTasks(project.id, { status: 'open', pageSize: 100 }, { signal }),
    [project.id],
  )
  const openTasks = useResource(loadOpenTasks)

  // The assignee select: the manager and the team, plus a current assignee who left (AC-3.7), marked.
  const currentAssignee = task?.task.assignee ?? null
  const departed =
    currentAssignee !== null && assignee === currentAssignee.id && !people.some((p) => p.id === currentAssignee.id)
  // A task that has an assignee has no "empty" choice: leaving it as it is means keeping them.
  const emptyChoice = task === undefined || currentAssignee === null
  const incomplete = project.onProjectComplete === false
  const assigneeHint = [task === undefined ? t.assigneeHint : null, incomplete ? t.membersIncomplete : null]
    .filter((line): line is string => line !== null)
    .join(' ')

  // The project's open tasks except this one, plus any current blocker already done or past the first 100.
  const openItems = (openTasks.data?.items ?? []).filter((candidate) => candidate.id !== task?.id)
  const blockerChoices = [
    ...openItems.map((item) => ({ id: item.id, label: item.subject })),
    ...(task?.task.blockedBy ?? [])
      .filter((blocker) => !openItems.some((item) => item.id === blocker.id))
      .map((blocker) => ({
        id: blocker.id,
        label: blocker.completed ? t.blockedByDone(blocker.subject) : blocker.subject,
      })),
  ]

  const toggleBlocker = (id: string, checked: boolean) => {
    if (checked && blockedByIds.length >= MAX_BLOCKERS) {
      setErrors((current) => ({ ...current, blockedByIds: t.blockedByMax(MAX_BLOCKERS) }))
      return
    }
    setErrors((current) => ({ ...current, blockedByIds: undefined }))
    setBlockedByIds((current) => (checked ? [...current, id] : current.filter((value) => value !== id)))
  }

  const full = participants.length >= MAX_PARTICIPANTS

  const submit = () => {
    const found: Errors<FieldName> = {
      subject: first(required(subject), maxLength(subject, 200)) ?? undefined,
    }
    setErrors(found)
    if (hasErrors(found)) {
      requestAnimationFrame(() => focusFirstInvalid(fieldsRef.current))
      return
    }
    const body = {
      subject: subject.trim(),
      description: withoutLocalImages(description),
      dueDate: dueDate === '' ? null : dueDate,
      ...(assignee !== '' ? { assigneeUserId: assignee } : {}),
      blockedByIds,
      participantIds: participants.map((person) => person.id),
    }
    setBusy(true)
    setError(null)
    // The task first: a refused field stops here, before any file is touched. Then the files, and the
    // description again only if it shows pictures that had no stored id until now.
    const request = (
      task ? updateTask(task.id, body) : createTask({ type: 'task', projectId: project.id, ...body })
    ).then(async (saved) => {
      const done = task ? strings.tasks.saved.saved : strings.tasks.saved.added
      if (files.pending.length === 0 && files.removed.length === 0) return done
      const result = await saveDeferredFiles(saved.id, description, files)
      if (imageFileIds(description).some(isLocalFileId))
        await updateTask(saved.id, { description: result.doc }).catch(() => undefined)
      return filesWarning(result) ?? done
    })
    request.then(onSaved, (failure: unknown) => {
      setBusy(false)
      setErrors(fieldsFor(failure))
      if (codeOf(failure) === 'host_read_only') onHostReadOnly()
      if (!hasFieldError(failure)) setError(taskErrorMessage(failure, 'dialog'))
    })
  }

  return (
    <FormDialog
      title={task ? t.editTitle : t.addTitle}
      submitLabel={task ? t.submitSave : t.submitAdd}
      busyLabel={t.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      error={error}
      onSubmit={submit}
      onCancel={onCancel}
      size="lg"
      testIdPrefix="task-form"
    >
      <div ref={fieldsRef} className="contents">
        <Field label={t.subject} required error={errors.subject} testId="task-form-subject">
          {(control) => <input {...control} value={subject} onChange={(event) => setSubject(event.target.value)} />}
        </Field>
        <RichTextFilesField
          label={tf.description}
          hint={tf.hint}
          error={errors.description}
          initialValue={description}
          onChange={(doc) => setDescription(doc)}
          placeholder={tf.placeholder}
          maxLength={DESCRIPTION_MAX_CHARS}
          files={files}
          resolveStoredUrl={task ? taskFileUrlResolver(task.id) : noStoredImages}
          onDownload={(file) => {
            if (task) void openTaskFile(task.id, file.id)
          }}
          imageAccept={IMAGE_ACCEPT}
          attachmentAccept={ATTACHMENT_ACCEPT}
          check={(file, kind) =>
            files.files.length >= MAX_FILES_PER_TASK ? tf.errors.tooMany : taskFileProblem(file, kind)
          }
          copy={{ editor: tf.editor, images: tf.images, attachments: tf.attachments }}
          testIdPrefix="task-form-description"
        />
        <Field label={t.dueDate} error={errors.dueDate} testId="task-form-due">
          {(control) => <DateInput {...control} value={dueDate} onChange={(event) => setDueDate(event.target.value)} />}
        </Field>
        <Field
          label={t.assignee}
          hint={assigneeHint === '' ? undefined : assigneeHint}
          error={errors.assignee}
          testId="task-form-assignee"
        >
          {(control) => (
            <select {...control} value={assignee} onChange={(event) => setAssignee(event.target.value)}>
              {emptyChoice && <option value="">{t.assigneeEmpty}</option>}
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {personName(person, currentUserId)}
                </option>
              ))}
              {departed && currentAssignee && (
                <option value={currentAssignee.id}>
                  {incomplete
                    ? refName(currentAssignee, currentUserId)
                    : t.assigneeDeparted(refName(currentAssignee, currentUserId))}
                </option>
              )}
            </select>
          )}
        </Field>
        {openTasks.status === 'error' ? (
          <div className="flex flex-col items-start gap-2" data-testid="task-form-blocked-by-failed">
            <p className="text-sm text-soft">{t.blockedByFailed}</p>
            <Button size="sm" onClick={openTasks.retry}>
              {t.blockedByRetry}
            </Button>
          </div>
        ) : (
          <CheckboxGroupField
            label={t.blockedBy(blockedByIds.length, MAX_BLOCKERS)}
            hint={t.blockedByHint}
            error={errors.blockedByIds}
            options={blockerChoices}
            selected={blockedByIds}
            onToggle={toggleBlocker}
            emptyState={openTasks.status === 'loading' ? t.blockedByLoading : t.blockedByEmpty}
            scroll
            testId="task-form-blocked-by"
            optionTestIdPrefix="task-form-blocker"
          />
        )}
        <div ref={participantsRef} className="flex flex-col gap-2" data-testid="task-form-participants">
          <PersonPicker
            label={t.participants}
            value={null}
            onChange={(next) => {
              if (next && !full && !participants.some((person) => person.id === next.id)) {
                setParticipants([...participants, next])
              }
            }}
            error={full ? t.participantsMax(MAX_PARTICIPANTS) : errors.participants}
            excludeIds={participants.map((person) => person.id)}
            clearOnSelect
            testId="task-form-participants-picker"
          />
          <PersonChips
            label={t.participants}
            people={participants}
            removeLabel={t.removeParticipant}
            focusAfterRemove={() => participantsRef.current?.querySelector('input') ?? null}
            onRemove={(id) => setParticipants(participants.filter((person) => person.id !== id))}
            testId="task-form-participants"
          />
        </div>
      </div>
    </FormDialog>
  )
}

/** The field a refusal names, as `{ field: message }`; empty when it names none (the dialog alert then speaks). */
function fieldsFor(failure: unknown): Errors<FieldName> {
  const t = strings.tasks
  if (!(failure instanceof ApiError)) return {}
  switch (failure.code) {
    case 'assignee_not_on_project':
      return { assignee: t.errors.assigneeNotOnProject }
    case 'blocker_cycle':
      return { blockedByIds: t.form.blockedByCycle }
    case 'blocker_is_self':
    case 'blocker_not_in_host':
      return { blockedByIds: failure.detail ?? strings.common.validation.fixErrors }
    case 'owner_not_app_user':
      return { participants: failure.detail ?? strings.common.validation.fixErrors }
    case 'image_not_found':
      return { description: failure.detail ?? strings.common.validation.fixErrors }
  }
  const named = fieldErrorOf(failure)
  const field = named ? SERVER_FIELDS[named.field] : undefined
  return named && field ? { [field]: named.message } : {}
}

const hasFieldError = (failure: unknown): boolean => hasErrors(fieldsFor(failure))
