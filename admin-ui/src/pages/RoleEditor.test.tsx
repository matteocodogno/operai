/**
 * @vitest-environment jsdom
 *
 * Component tests for RoleEditor — Screen A2, the rule composer (T18,
 * specs/004-auth-roles-permissions).
 *
 * Covers:
 *   (A) Loading: skeleton while role + catalog are both in-flight.
 *   (B) Populated: header (name/description/System badge), existing rules
 *       rendered as "Resource · Action" + condition chips.
 *   (C) Forbidden: a 403 on either fetch → PermissionDenied.
 *   (D) Role fetch error (non-403) → ErrorBanner + Retry.
 *   (E) Catalog fetch error → rule list stays read-only (no remove "×", no
 *       "+ Add rule"), ErrorBanner + Retry for the catalog specifically.
 *   (F) Off-catalog impossible: the Resource/Action <select>s only ever
 *       contain catalog-sourced <option>s.
 *   (G) aria-live: selecting a Resource announces "Action reset…"; selecting
 *       an Action announces the available conditions (or "no conditions").
 *   (H) Builds a conditioned rule: choose resource/action, set ownership to
 *       "own", check an attribute, Add rule → new row with the right chips.
 *   (I) Save rules → putRoleRules called with the draft; a 422 renders an
 *       inline banner with "Reload catalog", which re-fetches the catalog
 *       and clears the banner (draft preserved).
 *   (J) Delete: System role → aria-disabled Delete, no modal opens; custom
 *       role → ConfirmDeleteModal → confirm → deleteRole → navigate('/roles').
 *
 * Strategy mirrors RolesPage.test.tsx / AuditPage.test.tsx: `../lib/adminApi`
 * mocked at the module level (keeping the real `ApiError`); `useNavigate`
 * and `getRouteApi` (this page's route-param access, mirroring
 * `estimai-ui/src/pages/EstimatePage.tsx`'s own `getRouteApi` use) mocked
 * from `@tanstack/react-router`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import RoleEditor from './RoleEditor'
import type { Catalog, RoleDetail } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../lib/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/adminApi')>()
  return {
    ...original,
    getRole: vi.fn(),
    getCatalog: vi.fn(),
    patchRole: vi.fn(),
    deleteRole: vi.fn(),
    putRoleRules: vi.fn(),
  }
})

const navigateMock = vi.fn()
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...original,
    useNavigate: () => navigateMock,
    getRouteApi: () => ({ useParams: () => ({ id: 'role-1' }) }),
  }
})

import * as adminApi from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const catalogFixture: Catalog = [
  {
    appId: 'estimai',
    resources: [
      {
        key: 'estimate',
        label: 'Estimate',
        actions: [
          { key: 'view', label: 'View', supportedConditions: ['ownership'] },
          { key: 'edit', label: 'Edit', supportedConditions: ['ownership', 'entity'] },
        ],
      },
      { key: 'access', label: 'Access EstimAI', actions: [{ key: 'access', label: 'Access', supportedConditions: [] }] },
    ],
  },
  {
    appId: 'refund',
    resources: [
      {
        key: 'request',
        label: 'Refund request',
        actions: [
          // AC-5.1/T1: `approve` declares BOTH `entity` and the new `self-approval`
          // condition — the fixture mirrors the real refund catalog post-T1.
          { key: 'approve', label: 'Approve', supportedConditions: ['entity', 'self-approval'] },
          // `reject` intentionally lacks `self-approval` (AC-1.6/AC-4.3/D3) — used to
          // prove the toggle is not offered where the catalog doesn't declare it.
          { key: 'reject', label: 'Reject', supportedConditions: ['entity'] },
        ],
      },
    ],
  },
]

const roleFixture: RoleDetail = {
  id: 'role-1',
  name: 'Accounting Lead',
  description: 'Handles accounting estimates.',
  isSystem: false,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  rules: [{ resource: 'estimate', action: 'view', conditions: { ownership: 'any' } }],
}

const systemRoleFixture: RoleDetail = {
  ...roleFixture,
  id: 'role-employee',
  name: 'employee',
  isSystem: true,
  rules: [],
}

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  cleanup()
})

/** Renders with a loaded role + catalog and waits for the composer toggle to appear. */
async function renderLoaded(role: RoleDetail = roleFixture) {
  vi.mocked(adminApi.getRole).mockResolvedValue(role)
  vi.mocked(adminApi.getCatalog).mockResolvedValue(catalogFixture)
  const utils = render(<RoleEditor />)
  await waitFor(() => expect(screen.getByTestId('rule-composer-toggle')).not.toBeNull())
  return utils
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoleEditor — loading / error / forbidden', () => {
  it('renders a skeleton while role + catalog are in-flight', () => {
    vi.mocked(adminApi.getRole).mockReturnValue(new Promise(() => {}))
    vi.mocked(adminApi.getCatalog).mockReturnValue(new Promise(() => {}))

    render(<RoleEditor />)

    expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
    expect(screen.queryByTestId('role-name-input')).toBeNull()
  })

  it('renders PermissionDenied on a 403 from the role fetch', async () => {
    vi.mocked(adminApi.getRole).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Not an admin.' }),
    )
    vi.mocked(adminApi.getCatalog).mockResolvedValue(catalogFixture)

    render(<RoleEditor />)

    await waitFor(() => expect(screen.getByTestId('permission-denied')).not.toBeNull())
  })

  it('renders an ErrorBanner + Retry when the role fetch fails (non-403)', async () => {
    vi.mocked(adminApi.getRole)
      .mockRejectedValueOnce(
        new ApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: "Can't load role." }),
      )
      .mockResolvedValueOnce(roleFixture)
    vi.mocked(adminApi.getCatalog).mockResolvedValue(catalogFixture)

    render(<RoleEditor />)

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    expect(screen.getByRole('alert').textContent).toContain("Can't load role.")

    fireEvent.click(screen.getByTestId('error-banner-retry'))

    await waitFor(() => expect(screen.getByTestId('role-name-input')).not.toBeNull())
    expect(adminApi.getRole).toHaveBeenCalledTimes(2)
  })

  it('keeps the rule list read-only and shows an ErrorBanner when the catalog fetch fails', async () => {
    vi.mocked(adminApi.getRole).mockResolvedValue(roleFixture)
    vi.mocked(adminApi.getCatalog).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: "Can't load catalog." }),
    )

    render(<RoleEditor />)

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    expect(screen.getByRole('alert').textContent).toContain("Can't load catalog.")
    // Existing rule still renders...
    expect(screen.getByTestId('role-rule-0')).not.toBeNull()
    // ...but read-only: no remove button, no composer toggle.
    expect(screen.queryByTestId('role-rule-remove-0')).toBeNull()
    expect(screen.queryByTestId('rule-composer-toggle')).toBeNull()
  })
})

describe('RoleEditor — populated header + rule list', () => {
  it('renders the role name/description and the existing rule with its condition chip', async () => {
    await renderLoaded()

    expect((screen.getByTestId('role-name-input') as HTMLInputElement).value).toBe('Accounting Lead')
    expect((screen.getByTestId('role-description-input') as HTMLTextAreaElement).value).toBe(
      'Handles accounting estimates.',
    )
    expect(screen.getByTestId('role-rule-0').textContent).toContain('Estimate · View')
    expect(screen.getByTestId('condition-chip-any')).not.toBeNull()
  })

  it('shows the System badge and an aria-disabled Delete for a system role, with no modal on click', async () => {
    await renderLoaded(systemRoleFixture)

    expect(screen.getByTestId('system-badge')).not.toBeNull()
    const deleteBtn = screen.getByTestId('role-delete-button')
    expect(deleteBtn.getAttribute('aria-disabled')).toBe('true')
    expect(deleteBtn.getAttribute('title')).toBe("System roles can't be deleted")

    fireEvent.click(deleteBtn)
    expect(screen.queryByTestId('confirm-delete-modal')).toBeNull()
  })
})

describe('RoleEditor — off-catalog impossible', () => {
  it('the Resource select only contains catalog-sourced options', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId('rule-composer-toggle'))

    const resourceSelect = screen.getByTestId('rule-composer-resource') as HTMLSelectElement
    const optionValues = Array.from(resourceSelect.querySelectorAll('option')).map((o) => o.textContent)
    expect(optionValues).toEqual(['Select a resource…', 'Estimate', 'Access EstimAI', 'Refund request'])
  })

  it('the Action select only contains the selected resource\'s catalog actions', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId('rule-composer-toggle'))

    fireEvent.change(screen.getByTestId('rule-composer-resource'), { target: { value: 'estimai::estimate' } })

    const actionSelect = screen.getByTestId('rule-composer-action') as HTMLSelectElement
    const optionValues = Array.from(actionSelect.querySelectorAll('option')).map((o) => o.textContent)
    expect(optionValues).toEqual(['Select an action…', 'View', 'Edit'])
  })
})

describe('RoleEditor — aria-live status', () => {
  it('announces "Action reset" when Resource changes, then the available conditions when Action changes', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId('rule-composer-toggle'))

    fireEvent.change(screen.getByTestId('rule-composer-resource'), { target: { value: 'estimai::estimate' } })
    expect(screen.getByTestId('rule-composer-status').textContent).toMatch(/action reset/i)

    fireEvent.change(screen.getByTestId('rule-composer-action'), { target: { value: 'edit' } })
    expect(screen.getByTestId('rule-composer-status').textContent).toBe('Conditions available: ownership, entity.')
  })

  it('announces "This action has no conditions." for an action with an empty supportedConditions', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId('rule-composer-toggle'))

    fireEvent.change(screen.getByTestId('rule-composer-resource'), { target: { value: 'estimai::access' } })
    fireEvent.change(screen.getByTestId('rule-composer-action'), { target: { value: 'access' } })

    expect(screen.getByTestId('rule-composer-status').textContent).toBe('This action has no conditions.')
    expect(screen.getByTestId('rule-composer-no-conditions')).not.toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })
})

describe('RoleEditor — building a conditioned rule', () => {
  it('composes ownership=own + entity attribute and appends it to the draft on Add rule', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId('rule-composer-toggle'))

    fireEvent.change(screen.getByTestId('rule-composer-resource'), { target: { value: 'estimai::estimate' } })
    fireEvent.change(screen.getByTestId('rule-composer-action'), { target: { value: 'edit' } })

    expect(screen.getByRole('radiogroup')).not.toBeNull()

    // The Entity condition carries an explanatory help tooltip (title + aria-label).
    const entityHelp = screen.getByTestId('rule-composer-attr-entity-help')
    expect(entityHelp.getAttribute('title')).toMatch(/scope this permission to the user's own entity/i)
    expect(entityHelp.getAttribute('aria-label')).toContain('Entity condition')

    fireEvent.click(screen.getByTestId('rule-composer-ownership-own'))
    fireEvent.click(screen.getByTestId('rule-composer-attr-entity'))

    fireEvent.click(screen.getByTestId('rule-composer-add'))

    // Composer collapses after Add.
    expect(screen.queryByTestId('rule-composer')).toBeNull()

    // Original rule (row 0) + the new one (row 1).
    const newRow = screen.getByTestId('role-rule-1')
    expect(newRow.textContent).toContain('Estimate · Edit')
    expect(newRow.querySelector('[data-testid="condition-chip-own"]')).not.toBeNull()
    expect(newRow.querySelector('[data-testid="condition-chip-entity"]')).not.toBeNull()
  })

  it('"Add rule" is disabled until both Resource and Action are chosen', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId('rule-composer-toggle'))

    expect((screen.getByTestId('rule-composer-add') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByTestId('rule-composer-resource'), { target: { value: 'estimai::estimate' } })
    expect((screen.getByTestId('rule-composer-add') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByTestId('rule-composer-action'), { target: { value: 'view' } })
    expect((screen.getByTestId('rule-composer-add') as HTMLButtonElement).disabled).toBe(false)
  })

  it('removes a rule from the draft', async () => {
    await renderLoaded()

    expect(screen.getByTestId('role-rule-0')).not.toBeNull()
    fireEvent.click(screen.getByTestId('role-rule-remove-0'))

    expect(screen.queryByTestId('role-rule-0')).toBeNull()
    expect(screen.getByTestId('rules-empty-state')).not.toBeNull()
  })
})

describe('RoleEditor — self-approval condition (T4, specs/010-self-approval-control, ADR-0026)', () => {
  it('offers a self-approval toggle distinct from the entity checkbox for request.approve; not offered for reject (AC-1.1/1.6)', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId('rule-composer-toggle'))

    fireEvent.change(screen.getByTestId('rule-composer-resource'), { target: { value: 'refund::request' } })
    fireEvent.change(screen.getByTestId('rule-composer-action'), { target: { value: 'approve' } })

    const selfApproval = screen.getByTestId('rule-composer-self-approval')
    const entity = screen.getByTestId('rule-composer-attr-entity')
    expect(selfApproval).not.toBeNull()
    expect(entity).not.toBeNull()
    expect(selfApproval).not.toBe(entity)
    // Its own fieldset/legend — never folded into the entity/attribute group.
    expect(screen.getByText('Segregation of duties')).not.toBeNull()
    expect(selfApproval.closest('fieldset')).not.toBe(entity.closest('fieldset'))

    // `reject`'s catalog entry doesn't declare `self-approval` (D3/AC-4.3) — the
    // toggle disappears, while entity (which reject DOES support) stays offered.
    fireEvent.change(screen.getByTestId('rule-composer-action'), { target: { value: 'reject' } })
    expect(screen.queryByTestId('rule-composer-self-approval')).toBeNull()
    expect(screen.getByTestId('rule-composer-attr-entity')).not.toBeNull()
  })

  it('composes entity + self-approval independently: two chips on Add, toggling one leaves the other checked (AC-1.3/2.4)', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId('rule-composer-toggle'))
    fireEvent.change(screen.getByTestId('rule-composer-resource'), { target: { value: 'refund::request' } })
    fireEvent.change(screen.getByTestId('rule-composer-action'), { target: { value: 'approve' } })

    fireEvent.click(screen.getByTestId('rule-composer-attr-entity'))
    fireEvent.click(screen.getByTestId('rule-composer-self-approval'))
    expect((screen.getByTestId('rule-composer-attr-entity') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('rule-composer-self-approval') as HTMLInputElement).checked).toBe(true)

    // Toggling entity off leaves self-approval untouched, and vice versa (AC-1.3).
    fireEvent.click(screen.getByTestId('rule-composer-attr-entity'))
    expect((screen.getByTestId('rule-composer-attr-entity') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId('rule-composer-self-approval') as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByTestId('rule-composer-attr-entity'))
    fireEvent.click(screen.getByTestId('rule-composer-add'))

    const newRow = screen.getByTestId('role-rule-1')
    expect(newRow.textContent).toContain('Refund request · Approve')
    expect(newRow.querySelector('[data-testid="condition-chip-entity"]')).not.toBeNull()
    expect(newRow.querySelector('[data-testid="condition-chip-self-approval"]')).not.toBeNull()
  })

  it('renders both chips independently for an already-saved rule with both conditions, never conflated (AC-1.3 reopen, AC-1.4)', async () => {
    const roleWithBoth: RoleDetail = {
      ...roleFixture,
      rules: [
        {
          resource: 'request',
          action: 'approve',
          conditions: {
            attributes: [
              { key: 'entity', match: 'user' },
              { key: 'self-approval', match: 'deny' },
            ],
          },
        },
      ],
    }
    await renderLoaded(roleWithBoth)

    const row = screen.getByTestId('role-rule-0')
    expect(row.querySelector('[data-testid="condition-chip-entity"]')).not.toBeNull()
    expect(row.querySelector('[data-testid="condition-chip-self-approval"]')).not.toBeNull()
    // Exactly the two independent chips — never merged into one.
    expect(row.querySelectorAll('[data-testid^="condition-chip-"]').length).toBe(2)
  })

  it('persists both conditions as independent attributes[] entries matching the plan contract (AC-1.2/1.3)', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId('rule-composer-toggle'))
    fireEvent.change(screen.getByTestId('rule-composer-resource'), { target: { value: 'refund::request' } })
    fireEvent.change(screen.getByTestId('rule-composer-action'), { target: { value: 'approve' } })
    fireEvent.click(screen.getByTestId('rule-composer-attr-entity'))
    fireEvent.click(screen.getByTestId('rule-composer-self-approval'))
    fireEvent.click(screen.getByTestId('rule-composer-add'))

    vi.mocked(adminApi.putRoleRules).mockResolvedValue(roleFixture)
    fireEvent.click(screen.getByTestId('role-save-rules'))

    await waitFor(() => {
      expect(adminApi.putRoleRules).toHaveBeenCalledWith('role-1', [
        ...roleFixture.rules,
        {
          resource: 'request',
          action: 'approve',
          conditions: {
            attributes: [
              { key: 'entity', match: 'user' },
              { key: 'self-approval', match: 'deny' },
            ],
          },
        },
      ])
    })
  })
})

describe('RoleEditor — save rules + 422 stale catalog', () => {
  it('saves the draft via putRoleRules', async () => {
    await renderLoaded()
    vi.mocked(adminApi.putRoleRules).mockResolvedValue(roleFixture)

    fireEvent.click(screen.getByTestId('role-save-rules'))

    await waitFor(() => {
      expect(adminApi.putRoleRules).toHaveBeenCalledWith('role-1', roleFixture.rules)
    })
  })

  it('shows a "Reload catalog" banner on a 422 and re-fetches the catalog on click', async () => {
    await renderLoaded()
    vi.mocked(adminApi.putRoleRules).mockRejectedValue(
      new ApiError({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'One or more rules reference a permission that no longer exists.',
      }),
    )

    fireEvent.click(screen.getByTestId('role-save-rules'))

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    expect(screen.getByRole('alert').textContent).toContain('no longer exists')
    expect(screen.getByTestId('error-banner-retry').textContent).toBe('Reload catalog')

    // Draft preserved through the failed save.
    expect(screen.getByTestId('role-rule-0')).not.toBeNull()

    fireEvent.click(screen.getByTestId('error-banner-retry'))

    await waitFor(() => {
      expect(adminApi.getCatalog).toHaveBeenCalledTimes(2)
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('RoleEditor — delete (custom role)', () => {
  it('confirms delete via ConfirmDeleteModal and navigates to /roles', async () => {
    await renderLoaded()
    vi.mocked(adminApi.deleteRole).mockResolvedValue(undefined)

    fireEvent.click(screen.getByTestId('role-delete-button'))
    expect(screen.getByTestId('confirm-delete-modal')).not.toBeNull()

    fireEvent.click(screen.getByTestId('confirm-delete-confirm'))

    await waitFor(() => {
      expect(adminApi.deleteRole).toHaveBeenCalledWith('role-1')
    })
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({ to: '/roles' })
    })
  })

  it('surfaces a GuardrailDialog (not the inline modal error) on a 422 delete', async () => {
    await renderLoaded()
    vi.mocked(adminApi.deleteRole).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: "Can't remove the last admin." }),
    )

    fireEvent.click(screen.getByTestId('role-delete-button'))
    fireEvent.click(screen.getByTestId('confirm-delete-confirm'))

    await waitFor(() => expect(screen.getByTestId('guardrail-dialog')).not.toBeNull())
    expect(screen.getByTestId('guardrail-dialog').textContent).toContain("Can't remove the last admin.")
    expect(screen.queryByTestId('confirm-delete-modal')).toBeNull()
    expect(navigateMock).not.toHaveBeenCalledWith({ to: '/roles' })
  })
})

describe('RoleEditor — header PATCH', () => {
  it('saves name/description via patchRole', async () => {
    await renderLoaded()
    vi.mocked(adminApi.patchRole).mockResolvedValue({ ...roleFixture, name: 'Accounting Admin' })

    fireEvent.change(screen.getByTestId('role-name-input'), { target: { value: 'Accounting Admin' } })
    fireEvent.click(screen.getByTestId('role-header-save'))

    await waitFor(() => {
      expect(adminApi.patchRole).toHaveBeenCalledWith('role-1', {
        name: 'Accounting Admin',
        description: 'Handles accounting estimates.',
      })
    })
  })

  it('shows an inline name error on a 409 duplicate name', async () => {
    await renderLoaded()
    vi.mocked(adminApi.patchRole).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'A role named "hr" already exists.' }),
    )

    fireEvent.change(screen.getByTestId('role-name-input'), { target: { value: 'hr' } })
    fireEvent.click(screen.getByTestId('role-header-save'))

    await waitFor(() => {
      expect(screen.getByTestId('role-name-error').textContent).toBe('A role named "hr" already exists.')
    })
  })
})
