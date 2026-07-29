import { useEffect, useId, useRef, useState } from 'react'

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  children: React.ReactNode
  confirmLabel: string
  danger?: boolean
  error?: string | null
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const submittingRef = useRef(false)
  const wasOpenRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const [caughtError, setCaughtError] = useState<string | null>(null)
  const titleId = useId()
  const copyId = useId()
  const errorId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !wasOpenRef.current) {
      openerRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      setCaughtError(null)
      if (!dialog.open) dialog.showModal()
    }
    if (!open && wasOpenRef.current) {
      if (dialog.open) dialog.close()
      const opener = openerRef.current
      if (opener?.isConnected) opener.focus()
      openerRef.current = null
      submittingRef.current = false
      setSubmitting(false)
      setCaughtError(null)
    }
    wasOpenRef.current = open
  }, [open])

  const handleConfirm = async () => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setCaughtError(null)
    try {
      await onConfirm()
    } catch (caught) {
      setCaughtError(caught instanceof Error ? caught.message : 'The action was blocked.')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const visibleError = error || caughtError

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={`${copyId}${visibleError ? ` ${errorId}` : ''}`}
      aria-busy={submitting}
      onCancel={(event) => {
        if (submittingRef.current) {
          event.preventDefault()
          return
        }
        onCancel()
      }}
    >
      <div className="dialog-code">SENSITIVE DEMO ACTION</div>
      <h2 id={titleId}>{title}</h2>
      <div className="dialog-copy" id={copyId}>{children}</div>
      {visibleError && <div className="dialog-error" id={errorId} role="alert">{visibleError}</div>}
      <div className="dialog-actions">
        <button className="button button-ghost" type="button" disabled={submitting} onClick={onCancel}>Go back</button>
        <button
          className={`button ${danger ? 'button-danger' : ''}`}
          type="button"
          disabled={submitting}
          aria-busy={submitting}
          onClick={handleConfirm}
        >
          {submitting ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
