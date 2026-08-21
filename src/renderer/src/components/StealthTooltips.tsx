import { useEffect, useState } from 'react'
import { computeHintPlacement, type HintPlacement } from './hintPlacement'

const HINT_ATTRIBUTE = 'data-hint'
const SHOW_DELAY_MS = 320

type Hint = HintPlacement & { text: string }

/**
 * Paints element hints as ordinary page content instead of native tooltips.
 *
 * Windows applies capture exclusion (WDA_EXCLUDEFROMCAPTURE) to a window HANDLE.
 * A native tooltip is its own OS-level window and does not inherit the overlay's
 * affinity, so every `title` attribute stayed visible in a screen share even with
 * stealth on — the overlay was hidden while its tooltips narrated it.
 *
 * Rather than hand-editing every call site (and leaking again the next time
 * someone adds a `title`), this moves each title into `data-hint` and renders the
 * hint inside the overlay, where the window's own capture exclusion covers it.
 */
export function StealthTooltips(): React.JSX.Element | null {
  const [hint, setHint] = useState<Hint | null>(null)

  useEffect(() => {
    let showTimer: number | null = null
    let active: Element | null = null

    const cancelPending = (): void => {
      if (showTimer !== null) {
        window.clearTimeout(showTimer)
        showTimer = null
      }
    }

    const hide = (): void => {
      cancelPending()
      active = null
      setHint(null)
    }

    /**
     * A `title` is the accessible name for controls with no text of their own, so
     * preserve it as `aria-label` before taking the attribute away.
     */
    const adopt = (element: Element): void => {
      const title = element.getAttribute('title')
      if (title === null) return
      element.removeAttribute('title')
      const text = title.trim()
      if (!text) return
      element.setAttribute(HINT_ATTRIBUTE, text)
      if (!element.hasAttribute('aria-label') && !element.textContent?.trim()) {
        element.setAttribute('aria-label', text)
      }
    }

    const adoptWithin = (root: ParentNode): void => {
      if (root instanceof Element) adopt(root)
      root.querySelectorAll('[title]').forEach(adopt)
    }

    adoptWithin(document.body)

    // React rewrites `title` whenever its value changes, so keep stripping. The
    // filtered observer stays quiet otherwise: most hints are constant strings.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof Element) {
          adopt(record.target)
        }
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) adoptWithin(node)
        })
      }
    })
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['title']
    })

    const show = (element: Element): void => {
      const text = element.getAttribute(HINT_ATTRIBUTE)
      if (!text || !element.isConnected) return
      const rect = element.getBoundingClientRect()
      setHint({ text, ...computeHintPlacement(rect, window.innerWidth) })
    }

    const target = (event: Event): Element | null => {
      const node = event.target
      return node instanceof Element ? node.closest(`[${HINT_ATTRIBUTE}]`) : null
    }

    const onOver = (event: PointerEvent | FocusEvent): void => {
      const element = target(event)
      if (!element || element === active) return
      cancelPending()
      active = element
      showTimer = window.setTimeout(() => {
        showTimer = null
        if (active === element) show(element)
      }, SHOW_DELAY_MS)
    }

    const onOut = (event: PointerEvent | FocusEvent): void => {
      const element = target(event)
      if (element && element === active) hide()
      else if (!element) hide()
    }

    // Clicking a control, scrolling, or pressing Escape should drop the hint at
    // once rather than leaving it stranded over changed content.
    const onDismiss = (event: Event): void => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      hide()
    }

    document.addEventListener('pointerover', onOver as EventListener, true)
    document.addEventListener('pointerout', onOut as EventListener, true)
    document.addEventListener('focusin', onOver as EventListener, true)
    document.addEventListener('focusout', onOut as EventListener, true)
    document.addEventListener('pointerdown', onDismiss, true)
    document.addEventListener('keydown', onDismiss, true)
    document.addEventListener('scroll', onDismiss, true)
    window.addEventListener('blur', onDismiss)

    return () => {
      cancelPending()
      observer.disconnect()
      document.removeEventListener('pointerover', onOver as EventListener, true)
      document.removeEventListener('pointerout', onOut as EventListener, true)
      document.removeEventListener('focusin', onOver as EventListener, true)
      document.removeEventListener('focusout', onOut as EventListener, true)
      document.removeEventListener('pointerdown', onDismiss, true)
      document.removeEventListener('keydown', onDismiss, true)
      document.removeEventListener('scroll', onDismiss, true)
      window.removeEventListener('blur', onDismiss)
    }
  }, [])

  if (!hint) return null

  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[100] rounded-md border border-white/15 bg-zinc-900/95 px-2 py-1 text-[11px] leading-snug text-zinc-100 shadow-xl"
      style={{
        top: hint.top,
        left: hint.left,
        maxWidth: hint.maxWidth,
        transform: hint.placement === 'above' ? 'translateY(-100%)' : undefined
      }}
    >
      {hint.text}
    </div>
  )
}
