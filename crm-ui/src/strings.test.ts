import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogGaps } from '@operai/ui'
import { describe, expect, it } from 'vitest'
import { en, it as italian, strings } from './strings'

const STRINGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'strings')

describe('strings aggregate', () => {
  it('aggregates every file under src/strings/ (a namespace file nobody wired in would be invisible)', () => {
    const namespaces = readdirSync(STRINGS_DIR).map((file) => path.basename(file, '.ts'))
    expect(namespaces.length).toBeGreaterThan(0)
    expect(Object.keys(strings).sort()).toEqual([...namespaces].sort())
  })
})

describe('strings catalogs (INC-24, INC-25)', () => {
  it('the Italian catalog has every English key, with the same shape', () => {
    expect(catalogGaps(en, italian)).toEqual([])
  })

  it('the Italian catalog is a translation, not a copy of the English', () => {
    expect(italian.nav.companies).not.toBe(en.nav.companies)
    expect(italian.badges.dealStage.won).not.toBe(en.badges.dealStage.won)
    expect(italian.contacts.eraseDialog.body).not.toBe(en.contacts.eraseDialog.body)
  })

  it('sentence values with a parameter render it in both languages', () => {
    expect(en.deals.pipeline.closedIn(2026)).toContain('2026')
    expect(italian.deals.pipeline.closedIn(2026)).toContain('2026')
  })

  it('tests run with an English browser, so the selected catalog is English', () => {
    expect(strings).toBe(en)
  })

  it('the Record hours fallback link reads in both languages (specs/20261116-record-hours-in-place AC-4.5, AC-4.6)', () => {
    expect(en.recordHours.fallbackLink).toBe('Record hours in My hours')
    expect(italian.recordHours.fallbackLink).toBe('Registra ore in Le mie ore')
  })
})

/**
 * The offer wizard's copy (specs/20261115-crm-offer-wizard design § Copy keys, AC-10.1). A path a screen of the wizard
 * needs but the catalog lacks would render `undefined`, so every key of the design is pinned here, in both languages,
 * next to the parity test above (which only proves the two languages agree with each other).
 */
const WIZARD_PATHS = [
  'offerWizard.page.titleNew',
  'offerWizard.page.titleEdit',
  'offerWizard.page.titleRevision',
  'offerWizard.page.back',
  'offerWizard.page.draft',
  'offerWizard.page.loading',
  'offerWizard.page.notFound.title',
  'offerWizard.page.notFound.body',
  'offerWizard.steps.label',
  'offerWizard.steps.template',
  'offerWizard.steps.client',
  'offerWizard.steps.scope',
  'offerWizard.steps.conditions',
  'offerWizard.steps.costs',
  'offerWizard.steps.annexes',
  'offerWizard.steps.preview',
  'offerWizard.steps.count',
  'offerWizard.steps.intro.client',
  'offerWizard.steps.intro.costs',
  'offerWizard.steps.intro.annexes',
  'offerWizard.steps.intro.preview',
  'offerWizard.bar.back',
  'offerWizard.bar.next',
  'offerWizard.bar.preview',
  'offerWizard.bar.generate',
  'offerWizard.bar.stepOf',
  'offerWizard.bar.progress',
  'offerWizard.bar.counts',
  'offerWizard.bar.generateBlocked',
  'offerWizard.bar.generating',
  'offerWizard.bar.generatingLive',
  'offerWizard.save.saved',
  'offerWizard.save.saving',
  'offerWizard.save.retrying',
  'offerWizard.save.conflict.title',
  'offerWizard.save.conflict.body',
  'offerWizard.save.reload',
  'offerWizard.save.gone.title',
  'offerWizard.save.gone.body',
  'offerWizard.save.leave',
  'offerWizard.save.rejected',
  'offerWizard.save.tooLarge',
  'offerWizard.target.edit',
  'offerWizard.target.revision',
  'offerWizard.target.legacy',
  'offerWizard.target.archived',
  'offerWizard.estimate.missing',
  'offerWizard.estimate.override',
  'offerWizard.estimate.go',
  'offerWizard.unsent.body',
  'offerWizard.unsent.editInstead',
  'offerWizard.changed.title',
  'offerWizard.changed.body',
  'offerWizard.changed.see',
  'offerWizard.changed.dialog.title',
  'offerWizard.changed.dialog.answers',
  'offerWizard.changed.dialog.edits',
  'offerWizard.changed.dialog.copy',
  'offerWizard.changed.dialog.close',
  'offerWizard.changed.orphans.title',
  'offerWizard.changed.orphans.body',
  'offerWizard.archived.title',
  'offerWizard.archived.body',
  'offerWizard.draftExists',
  'offerWizard.template.heading',
  'offerWizard.template.uses',
  'offerWizard.template.use',
  'offerWizard.template.current',
  'offerWizard.template.starting',
  'offerWizard.template.classic.title',
  'offerWizard.template.classic.intro',
  'offerWizard.template.classic.use',
  'offerWizard.template.empty.title',
  'offerWizard.template.empty.body',
  'offerWizard.template.switch.title',
  'offerWizard.template.switch.body',
  'offerWizard.template.switch.confirm',
  'offerWizard.template.switch.busy',
  'offerWizard.template.switch.done',
  'offerWizard.client.card',
  'offerWizard.client.lines',
  'offerWizard.client.linesHint',
  'offerWizard.client.contacts',
  'offerWizard.client.contactsLimit',
  'offerWizard.client.contactsEmpty',
  'offerWizard.client.place',
  'offerWizard.client.date',
  'offerWizard.client.dateToday',
  'offerWizard.client.dateOn',
  'offerWizard.client.dateRange',
  'offerWizard.client.reference',
  'offerWizard.client.referencePending',
  'offerWizard.client.referenceNext',
  'offerWizard.client.currency',
  'offerWizard.field.optional',
  'offerWizard.field.withCurrency',
  'offerWizard.field.derived',
  'offerWizard.field.fills',
  'offerWizard.field.filledLive',
  'offerWizard.field.handEdited',
  'offerWizard.field.more',
  'offerWizard.field.select',
  'offerWizard.field.notAnOption',
  'offerWizard.list.add',
  'offerWizard.list.remove',
  'offerWizard.list.up',
  'offerWizard.list.down',
  'offerWizard.list.removedLive',
  'offerWizard.table.row',
  'offerWizard.table.addRow',
  'offerWizard.table.removeRow',
  'offerWizard.table.empty',
  'offerWizard.table.limit',
  'offerWizard.invalid.required',
  'offerWizard.invalid.out_of_range',
  'offerWizard.invalid.not_integer',
  'offerWizard.invalid.days_out_of_range',
  'offerWizard.invalid.not_a_number',
  'offerWizard.invalid.date_out_of_range',
  'offerWizard.invalid.not_an_option',
  'offerWizard.invalid.discounts_exceed_span',
  'offerWizard.invalid.discounts_exceed_one_off',
  'offerWizard.invalid.discount_without_base',
  'offerWizard.invalid.percent_discount_multi_total',
  'offerWizard.invalid.no_counted_line',
  'offerWizard.invalid.cost_total_too_large',
  'offerWizard.invalid.too_many_cost_lines',
  'offerWizard.invalid.heading_too_long',
  'offerWizard.invalid.section_too_long',
  'offerWizard.costs.card',
  'offerWizard.costs.add',
  'offerWizard.costs.addLimit',
  'offerWizard.costs.kind.one_off',
  'offerWizard.costs.kind.yearly',
  'offerWizard.costs.kind.discount',
  'offerWizard.costs.kind.option',
  'offerWizard.costs.optionNote',
  'offerWizard.costs.unit',
  'offerWizard.costs.quantity',
  'offerWizard.costs.total',
  'offerWizard.costs.discountAmount',
  'offerWizard.costs.discountPercent',
  'offerWizard.costs.comesWith',
  'offerWizard.costs.row',
  'offerWizard.costs.remove',
  'offerWizard.costs.layout',
  'offerWizard.costs.position',
  'offerWizard.costs.unitCols',
  'offerWizard.costs.showTotals',
  'offerWizard.costs.validity',
  'offerWizard.costs.validityHint',
  'offerWizard.costs.spanEmpty',
  'offerWizard.costs.spanEmptyLive',
  'offerWizard.costs.spanIncomplete',
  'offerWizard.annexes.effort',
  'offerWizard.annexes.effortHint',
  'offerWizard.annexes.ai',
  'offerWizard.annexes.aiHint',
  'offerWizard.annexes.noEstimate',
  'offerWizard.annexes.pdfs',
  'offerWizard.annexes.pdfsEmpty',
  'offerWizard.annexes.pdfsLimit',
  'offerWizard.annexes.pdfsSize',
  'offerWizard.issues.title',
  'offerWizard.issues.missing',
  'offerWizard.issues.invalid',
  'offerWizard.issues.item',
  'offerWizard.issues.invalidItem',
  'offerWizard.issues.costExtra',
  'offerWizard.issues.costTable',
  'offerWizard.issues.none',
  'offerWizard.sections.caption',
  'offerWizard.sections.section',
  'offerWizard.sections.step',
  'offerWizard.sections.status',
  'offerWizard.sections.actions',
  'offerWizard.sections.edited',
  'offerWizard.sections.edit',
  'offerWizard.sections.restore',
  'offerWizard.edit.title',
  'offerWizard.edit.description',
  'offerWizard.edit.heading',
  'offerWizard.edit.text',
  'offerWizard.edit.counter',
  'offerWizard.edit.save',
  'offerWizard.edit.saving',
  'offerWizard.edit.restore',
  'offerWizard.edit.missingBanner',
  'offerWizard.edit.tokenLeft',
  'offerWizard.edit.bracketStray',
  'offerWizard.edit.tooLong',
  'offerWizard.edit.savedLive',
  'offerWizard.edit.restoredLive',
  'offerWizard.restore.title',
  'offerWizard.restore.body',
  'offerWizard.restore.confirm',
  'offerWizard.restore.busy',
  'offerWizard.preview.title',
  'offerWizard.preview.note',
  'offerWizard.preview.drawerTitle',
  'offerWizard.preview.missingBadge',
  'offerWizard.preview.letterhead',
  'offerWizard.preview.pending',
  'offerWizard.preview.missing',
  'offerWizard.preview.edited',
  'offerWizard.preview.annexAppended',
  'offerWizard.generate.fail.incomplete',
  'offerWizard.generate.fail.contact',
  'offerWizard.generate.fail.attachment',
  'offerWizard.generate.fail.templateChanged',
  'offerWizard.generate.fail.chooseAnother',
  'offerWizard.generate.fail.offerChanged',
  'offerWizard.generate.fail.retry',
  'offerWizard.generate.fail.retryAction',
  'offerWizard.generate.fail.go',
  'offerWizard.generate.done',
  // The deal page (offers.ts)
  'offers.new',
  'offers.starting',
  'offers.draft.row',
  'offers.draft.target.new',
  'offers.draft.target.edit',
  'offers.draft.target.revision',
  'offers.draft.changed',
  'offers.draft.continue',
  'offers.draft.discard',
  'offers.draft.discardOf',
  'offers.draft.discardDialog.title',
  'offers.draft.discardDialog.body',
  'offers.draft.discardDialog.bodyOffer',
  'offers.draft.discardDialog.confirm',
  'offers.draft.discardDialog.busy',
  'offers.draft.discardDialog.done',
  'offers.draft.checkFailed',
  'offers.draft.checkRetry',
  'offers.draft.templateChanged',
  'offers.draft.templateArchived',
  'offers.draft.changedMeanwhile',
  'offers.draft.exists.title',
  'offers.draft.exists.body',
  'offers.draft.exists.discard',
  'offers.draft.exists.continue',
  'offers.origin.sections',
  'offers.errors.draftExists',
  'offers.errors.draftNotFound',
  'offers.errors.templateChanged',
  'offers.errors.templateFormatMismatch',
  'offers.errors.templateRequired',
  'offers.errors.offerChanged',
  'offers.errors.answersInvalid',
  'offers.errors.draftTooLarge',
  'offers.errors.offerIncomplete',
  // The template list and editor (templates.ts)
  'templates.list.format',
  'templates.list.wizard',
  'templates.list.classic',
  'templates.list.errors.last_template',
  'templates.list.errors.template_superseded',
  'templates.wizardEditor.views',
  'templates.wizardEditor.edit',
  'templates.wizardEditor.tryLabel',
  'templates.wizardEditor.details',
  'templates.wizardEditor.description',
  'templates.wizardEditor.descriptionHint',
  'templates.wizardEditor.uses',
  'templates.wizardEditor.usesHint',
  'templates.wizardEditor.text',
  'templates.wizardEditor.textHint',
  'templates.wizardEditor.status',
  'templates.wizardEditor.goToProblems',
  'templates.wizardEditor.syntax',
  'templates.wizardEditor.problems',
  'templates.wizardEditor.noProblems',
  'templates.wizardEditor.error',
  'templates.wizardEditor.warning',
  'templates.wizardEditor.line',
  'templates.wizardEditor.outline',
  'templates.wizardEditor.outlineEmpty.title',
  'templates.wizardEditor.outlineEmpty.body',
  'templates.wizardEditor.outlineStale',
  'templates.wizardEditor.kind.text',
  'templates.wizardEditor.kind.longtext',
  'templates.wizardEditor.kind.number',
  'templates.wizardEditor.kind.percentage',
  'templates.wizardEditor.kind.date',
  'templates.wizardEditor.kind.amount',
  'templates.wizardEditor.kind.list',
  'templates.wizardEditor.kind.table',
  'templates.wizardEditor.kind.block',
  'templates.wizardEditor.kind.choice',
  'templates.wizardEditor.kind.costs',
  'templates.wizardEditor.kind.derived',
  'templates.wizardEditor.saveBlocked',
  'templates.wizardEditor.supersede',
  'templates.wizardEditor.try.banner',
  'templates.wizardEditor.try.reset',
  'templates.wizardEditor.try.blocked',
  'templates.wizardEditor.try.goProblems',
  'templates.wizardEditor.try.noGenerate',
]

/** One message per `ProblemCode` of plan § Engine contracts (syntax.ts); a new code needs its message here. */
const PROBLEM_CODES = [
  'block_not_closed',
  'unexpected_close',
  'field_undeclared',
  'label_missing',
  'declared_unused',
  'choice_too_few_options',
  'choice_option_unknown',
  'no_costs_section',
  'costs_not_first',
  'costs_not_closed',
  'cost_line_invalid',
  'cost_key_duplicate',
  'name_duplicate',
  'table_column_unknown',
  'column_in_two_tables',
  'compute_invalid',
  'compute_cycle',
  'fills_unknown',
  'source_unknown',
  'step_unknown',
  'annex_designation_invalid',
  'annex_designation_duplicate',
  'salutation_missing',
  'too_many_sections',
  'too_many_annexes',
  'too_many_annex_sections',
  'heading_too_long',
  'too_large',
  'nesting_too_deep',
  'reserved_character',
  'cost_line_after_last_total',
  'percent_discount_multi_total',
  'non_printable_character',
  'optional_heading_not_last',
].map((code) => `templates.wizardEditor.problem.${code}`)

const at = (root: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], root)

describe('offer wizard copy (AC-10.1)', () => {
  it.each([
    ['en', en],
    ['it', italian],
  ] as const)('every key of design § Copy keys exists in %s, as a non-empty string or a function', (_name, catalog) => {
    for (const path of [...WIZARD_PATHS, ...PROBLEM_CODES]) {
      const value = at(catalog, path)
      expect(value, path).toBeDefined()
      if (typeof value === 'string') expect(value.length, path).toBeGreaterThan(0)
      else expect(typeof value, path).toBe('function')
    }
  })

  it('values render in both languages, in the right order', () => {
    expect(en.offerWizard.bar.stepOf(2, 7, 'Client')).toBe('Step 2 of 7 · Client')
    expect(italian.offerWizard.bar.stepOf(2, 7, 'Cliente')).toBe('Passo 2 di 7 · Cliente')
    expect(en.offerWizard.target.revision('0042/2026', '0042/2026r1')).toContain('0042/2026r1')
    expect(italian.offerWizard.draftExists('Anna', '01.02.2026')).toContain('Anna')
  })

  it('the Italian wizard copy is a translation, not a copy of the English', () => {
    for (const path of ['offerWizard.bar.next', 'offerWizard.steps.client', 'offerWizard.invalid.required']) {
      expect(at(italian, path), path).not.toBe(at(en, path))
    }
  })

  it('a problem message names the thing it is about when the code has a name', () => {
    expect(en.templates.wizardEditor.problem.field_undeclared('ACCONTO')).toContain('ACCONTO')
    expect(italian.templates.wizardEditor.problem.field_undeclared('ACCONTO')).toContain('ACCONTO')
  })
})
