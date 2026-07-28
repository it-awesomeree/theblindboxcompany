import { useEffect, useId, useRef } from 'react'

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  children: React.ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog ref={dialogRef} className="confirm-dialog" aria-labelledby={titleId} onCancel={onCancel}>
      <div className="dialog-code">SENSITIVE DEMO ACTION</div>
      <h2 id={titleId}>{title}</h2>
      <div className="dialog-copy">{children}</div>
      <div className="dialog-actions">
        <button className="button button-ghost" type="button" onClick={onCancel}>Go back</button>
        <button className={`button ${danger ? 'button-danger' : ''}`} type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
