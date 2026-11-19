/**
 * One trigger-anchored stat dialog seat for the composer-dock pills.
 * Replicates the official ui-chat stat-dialog.ts: open state (optionally
 * controlled so sibling dialogs share one exclusive slot), viewport-clamped
 * placement above the trigger, outside-pointer close, and Escape close.
 *
 * The document-level capture-phase `click` close is what keeps at most one
 * dialog open once each pill owns its own state (DSH 0.2.1-alpha.1 split the
 * dock row into one entry per pill, so the shared controlled slot is only
 * reachable from the pre-split single-entry row). A mouse click on a sibling
 * pill is outside this trigger AND this panel, so this listener closes the
 * incumbent during the capture phase — before the sibling's own onClick
 * bubble handler opens it. Keyboard activation of a sibling pill never
 * stacks a second dialog either, because the sibling's root is outside this
 * one. All imports are platform externals (react + primitives), so the
 * client-bundle purity gate accepts this module.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject, type RefObject } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'

/** Viewport margin the placement clamp keeps (the Menu portal margin). */
const PANEL_MARGIN = 12

/** Distance between the trigger's top edge and the panel's bottom. */
const PANEL_GAP = 8

/** Placement inputs, mirroring the official `AnchoredPositionOptions`. */
export interface AnchoredPositionOptions {
  /** Whether the floating element is mounted and should track its anchor. */
  open: boolean
  /** The element the panel is placed from. */
  anchorRef: RefObject<HTMLElement | null>
  /** The floating element, measured so the clamp uses real dimensions. */
  panelRef: RefObject<HTMLElement | null>
  /** Which anchor edge the panel hangs from. */
  side?: 'top' | 'bottom'
  /** Which anchor edge the panel lines up with. */
  align?: 'start' | 'end'
  /** Distance kept between the anchor edge and the panel. */
  gap: number
  /** Distance kept between the panel and each viewport edge. */
  margin: number
}

type AnchoredPositionHook = (options: AnchoredPositionOptions) => CSSProperties | null

/**
 * Local port of the official `useAnchoredPosition`, kept for hosts whose
 * primitives package no longer exports it (see {@link useAnchoredPosition}).
 * Same algorithm, same clamps: place against the anchor's viewport rect, clamp
 * inside the viewport once the panel has a real size, and re-place on scroll
 * (capture phase, so nested scrollers count), resize, and panel resize.
 */
export function useLocalAnchoredPosition(options: AnchoredPositionOptions): CSSProperties | null {
  const { open, anchorRef, panelRef, side = 'bottom', align = 'start', gap, margin } = options
  const [position, setPosition] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const place = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const panel = panelRef.current
      const width = panel?.offsetWidth ?? 0
      const height = panel?.offsetHeight ?? 0
      let left = align === 'end' ? rect.right - width : rect.left
      let top = side === 'top' ? rect.top - gap - height : rect.bottom + gap
      if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin)
      if (height > 0) top = Math.min(Math.max(top, margin), window.innerHeight - height - margin)
      setPosition({ left, top })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const panel = panelRef.current
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && panel !== null) {
      observer = new ResizeObserver(place)
      observer.observe(panel)
    }
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, anchorRef, panelRef, side, align, gap, margin])
  return position
}

/**
 * The anchored-placement hook the dialog seats call.
 *
 * DSH 0.2.2-rc.2 dropped `useAnchoredPosition` from the
 * `@deepseek-ai/dsh-client-ui-primitives` exports (issues #25 and #24: the
 * symbol survives only inside the app, not on the module's public surface),
 * with no replacement hook — `useAnchoredMaxHeight` clamps a height and
 * cannot position. A static call therefore threw `is not a function` on every
 * render, crashing the `conversation.composer.dock` slot.
 *
 * The implementation is resolved ONCE at module load: the host's hook where the
 * running primitives package still publishes it (every line up to 0.2.2-rc.1),
 * the local port otherwise. Resolving at module scope — rather than choosing
 * inside the render — keeps the hook order identical for the life of the
 * module, so React never sees a changed hook sequence.
 */
const useAnchoredPosition: AnchoredPositionHook = (() => {
  // Read the export as a PROPERTY, never as a named import: 0.2.2-rc.2 dropped
  // it from the package's export set, so a named import would also fail the
  // typecheck against that line even though the fallback would save it at
  // runtime.
  const primitives_ = primitives as unknown as { useAnchoredPosition?: AnchoredPositionHook }
  const official = primitives_.useAnchoredPosition
  return typeof official === 'function' ? official : useLocalAnchoredPosition
})()

/**
 * Unplaced portal panel: hidden but laid out so the clamp measures real
 * dimensions (the `useAnchoredPosition` measure pass).
 */
export const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** Open state, refs, and clamped placement for one stat dialog. */
export interface StatDialogSeat {
  open: boolean
  setOpen: (open: boolean) => void
  rootRef: MutableRefObject<HTMLSpanElement | null>
  panelRef: MutableRefObject<HTMLDivElement | null>
  pos: CSSProperties | null
}

/**
 * One trigger-anchored dialog seat: open state, viewport-clamped placement,
 * outside-close.
 * @param controlled - external open state; when given the seat reads and
 *   writes it instead of owning its own, letting sibling dialogs share one
 *   exclusive slot (the pre-split single-entry row).
 */
export function useStatDialog(controlled?: Pick<StatDialogSeat, 'open' | 'setOpen'>): StatDialogSeat {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlled?.open ?? ownOpen
  const setOpen = controlled?.setOpen ?? setOwnOpen
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const pos = useAnchoredPosition({
    open,
    anchorRef: rootRef,
    panelRef,
    side: 'top',
    gap: PANEL_GAP,
    margin: PANEL_MARGIN,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onClick = (e: MouseEvent): void => {
      const target = e.target as Node
      if (rootRef.current?.contains(target) !== true && panelRef.current?.contains(target) !== true) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('click', onClick, true)
    }
  }, [open, setOpen])
  return { open, setOpen, rootRef, panelRef, pos }
}
