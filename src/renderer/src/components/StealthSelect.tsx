import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { computeListboxPlacement, type ListboxPlacement } from './listboxPlacement'

const OPTION_HEIGHT = 26
const LIST_PADDING = 8

export type StealthSelectOption<T extends string> = {
  value: T
  label: string
}

/**
 * A <select> replacement whose option list is ordinary page content.
 *
 * Chromium renders a native <select> popup as a separate OS-level window, which
 * does not inherit the overlay's WDA_EXCLUDEFROMCAPTURE affinity — so the list
 * stayed visible in a screen share while the overlay behind it was hidden. The
 * list here is rendered in the document (portalled to body, so no overflow-hidden
 * or backdrop-filter ancestor can clip or re-anchor it) and is therefore covered
 * by the window's capture exclusion like everything else.
 */
export function StealthSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  title,
  disabled = false,
  className = '',
  buttonClassName = ''
}: {
  value: T
  options: readonly StealthSelectOption<T>[]
  onChange: (value: T) => void
  /** Accessible name; there is no visible <label> in the overlay's dense chrome. */
  label: string
  title?: string
  disabled?: boolean
  className?: string
  buttonClassName?: string
}): React.JSX.Element {
  const listId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [placement, setPlacement] = useState<ListboxPlacement | null>(null)

  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const reposition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    setPlacement(
      computeListboxPlacement(
        trigger.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        options.length * OPTION_HEIGHT + LIST_PADDING
      )
    )
  }, [options.length])

  const close = useCallback((refocus = true) => {
    setOpen(false)
    setPlacement(null)
    if (refocus) triggerRef.current?.focus()
  }, [])

  // Measure before paint so the list never appears in the wrong spot for a frame.
  useLayoutEffect(() => {
    if (open) reposition()
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && triggerRef.current?.contains(target)) return
      if (target instanceof Element && target.closest(`[data-listbox="${listId}"]`)) return
      close(false)
    }
    // The overlay is small and scrolls internally; a list anchored to a moved
    // trigger would float away, so close rather than chase it.
    const onDismiss = (): void => close(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('scroll', onDismiss, true)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('blur', onDismiss)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('scroll', onDismiss, true)
      window.removeEventListener('resize', onDismiss)
      window.removeEventListener('blur', onDismiss)
    }
  }, [open, close, listId])

  function openList(): void {
    if (disabled) return
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }

  function commit(index: number): void {
    const option = options[index]
    if (option) onChange(option.value)
    close()
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (disabled) return
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openList()
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      commit(activeIndex)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(options.length - 1, index + 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(0, index - 1))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(options.length - 1)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
        className={`flex items-center justify-between gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-left text-xs text-zinc-100 hover:bg-white/10 focus:border-indigo-400/50 focus:outline-none disabled:opacity-50 ${className} ${buttonClassName}`}
      >
        <span className="min-w-0 truncate">{selected?.label ?? ''}</span>
        <span aria-hidden="true" className="shrink-0 text-[9px] text-zinc-400">
          ▾
        </span>
      </button>
      {open &&
        placement &&
        createPortal(
          <ul
            id={listId}
            role="listbox"
            data-listbox={listId}
            aria-label={label}
            className="fixed z-[90] overflow-y-auto rounded-md border border-white/15 bg-zinc-900/98 p-1 text-xs text-zinc-100 shadow-2xl"
            style={{
              top: placement.top,
              left: placement.left,
              width: placement.width,
              maxHeight: placement.maxHeight
            }}
          >
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                onPointerEnter={() => setActiveIndex(index)}
                onClick={() => commit(index)}
                className={`cursor-pointer truncate rounded px-1.5 py-1 ${
                  index === activeIndex ? 'bg-indigo-500/30 text-white' : 'hover:bg-white/10'
                } ${option.value === value ? 'font-semibold' : ''}`}
              >
                {option.label}
              </li>
            ))}
          </ul>,
          document.body
        )}
    </>
  )
}
