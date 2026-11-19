/**
 * The primitives-export compatibility shim (issues #25 / #24).
 *
 * DSH 0.2.2-rc.2 dropped `useAnchoredPosition` from
 * `@deepseek-ai/dsh-client-ui-primitives` with no replacement hook, so the
 * dialog seats' static call threw `is not a function` on every render and
 * crashed the `conversation.composer.dock` slot. The module resolves the
 * implementation once at load: the host's hook where it exists, the local port
 * otherwise. This file simulates the newer host by removing the export before
 * the module graph loads.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  // The 0.2.2-rc.2/0.2.2-rc.3 surface: everything else still exported, this one
  // symbol gone.
  return { ...actual, useAnchoredPosition: undefined }
})

import { useStatDialog } from '../src/client/stat-dialog.ts'

/** One seat rendered as a trigger plus its portal panel. */
function Probe(): JSX.Element {
  const seat = useStatDialog()
  return (
    <span>
      <span ref={seat.rootRef} data-testid="root" />
      <button type="button" data-testid="trigger" onClick={() => { seat.setOpen(!seat.open) }}>
        pill
      </button>
      {seat.open && <div ref={seat.panelRef} data-testid="panel">dialog</div>}
      <span data-testid="pos">{seat.pos === null ? 'null' : 'placed'}</span>
    </span>
  )
}

afterEach(() => { cleanup() })

describe('stat dialog on a host without useAnchoredPosition', () => {
  it('renders without throwing when the export is missing', () => {
    expect(() => { render(<Probe />) }).not.toThrow()
    expect(screen.getByTestId('pos').textContent).toBe('null')
  })

  it('still places the panel once it opens', () => {
    render(<Probe />)
    fireEvent.click(screen.getByTestId('trigger'))
    // The local port measured the anchor and produced coordinates, so the
    // panel is placed instead of the seat crashing.
    expect(screen.getByTestId('pos').textContent).toBe('placed')
  })
})