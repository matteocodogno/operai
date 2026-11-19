/**
 * AccountingLinkNote — the sentence that heads the Default classification view of Settings
 * (specs/20261119-accounting, AC-4.6, UX-16, UX-17): ledger accounts, VAT codes and exchange rates now live in the
 * Accounting app. A permanent explanation, not a notification, so it is plain secondary text, not a `Banner`.
 *
 * With Accounting among the user's `apps` (read from the shell's cached grants, UX only: the Accounting app and
 * its API enforce access themselves) the note ends in a link; without it, the note says who keeps the entries
 * and no link is offered. The link is a plain `<a className="link" href>` (the projects-ui precedent): a real
 * `href` works with open-in-new-tab, and a full document load is fine for a link that leaves the tool.
 */

import { usePermissions } from 'shell/session'
import { strings } from '../strings'

const t = strings.settings.accountingLink

/** The Accounting app's entry route in the shell. */
export const ACCOUNTING_APP_PATH = '/accounting'

export default function AccountingLinkNote() {
  const { apps } = usePermissions()
  const hasAccounting = apps.includes('accounting')

  return (
    <p className="m-0 text-sm text-soft" data-testid="settings-accounting-link-note">
      {hasAccounting ? (
        <>
          {t.withAccess}{' '}
          <a className="link" href={ACCOUNTING_APP_PATH} aria-label={t.linkLabel} data-testid="settings-accounting-link">
            {t.linkText}
          </a>
        </>
      ) : (
        t.withoutAccess
      )}
    </p>
  )
}
