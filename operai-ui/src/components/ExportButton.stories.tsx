import type { Meta, StoryObj } from '@storybook/react-vite'
import { ExportButton } from './ExportButton'
import type { ExportButtonProps } from './ExportButton'

/**
 * "Export" as a download: the button builds a file in the browser (`build` runs on click — the app
 * fetches its pages and lazy-imports its spreadsheet library there) and hands it to the browser.
 * While it builds the button is `aria-busy`, never `disabled` (which would drop keyboard focus), and
 * a second click is ignored; a polite status line says "preparing", then "ready" (or the app's
 * `readyMessage` when the file has a caveat); a failure is an inline alert and the same button tries
 * again. A new `resetKey` (the filters changed) clears a status that described another file.
 *
 * Place it next to the list or figures it exports, in a `secondary` (default) or `ghost` button, and
 * never as the page's primary action. The stories download a small CSV; a real app passes an XLSX
 * buffer and keeps the default `mimeType`. Switch the theme in the toolbar to see each state in both.
 */
const meta = {
  title: 'Components/Actions/ExportButton',
  component: ExportButton,
  tags: ['autodocs'],
  parameters: { controls: { disable: true }, docs: { story: { inline: false, iframeHeight: 140 } } },
} satisfies Meta<typeof ExportButton>
export default meta

type Story = StoryObj

const messages: ExportButtonProps['messages'] = {
  busy: 'Preparing file…',
  ready: 'File ready',
  failed: 'The export could not be prepared. Try again.',
}

const CSV = 'Day,Person,Hours\n2026-11-12,Anna Keller,2.5\n2026-11-12,Luca Ferrari,4\n'

const after = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))

const buildCsv: ExportButtonProps['build'] = () => after(1200, { data: CSV, fileName: 'hours-2026-11.csv' })

const common = { label: 'Export', messages, mimeType: 'text/csv', testId: 'story-export' }

/** Clicks the button as soon as the story renders, so the state it leads to is on screen. */
const clickOnLoad: Story['play'] = ({ canvasElement }) => {
  canvasElement.querySelector<HTMLButtonElement>('button')?.click()
}

/** Click it: busy for a moment, then the file downloads and the status says it is ready. */
export const Playground: Story = {
  render: () => <ExportButton {...common} build={buildCsv} />,
}

export const Ghost: Story = {
  name: 'Ghost variant',
  render: () => <ExportButton {...common} variant="ghost" build={buildCsv} />,
}

/** Click it: the file is made, and the status carries the app's caveat instead of "File ready". */
export const ReadyWithAMessage: Story = {
  name: 'Ready, with a message',
  render: () => (
    <ExportButton
      {...common}
      build={() =>
        after(800, {
          data: CSV,
          fileName: 'hours-2026-11.csv',
          readyMessage: 'File ready. Some names could not be loaded and are missing.',
        })
      }
    />
  ),
}

/** Never finishes: the button stays `aria-busy` (not disabled, still focusable) with the polite "preparing" line. */
export const Busy: Story = {
  render: () => <ExportButton {...common} build={() => new Promise(() => {})} />,
  play: clickOnLoad,
}

/** A failed build or download: nothing was saved, the alert says so, the button is usable again. */
export const Failed: Story = {
  render: () => <ExportButton {...common} build={() => Promise.reject(new Error('503'))} />,
  play: clickOnLoad,
}
