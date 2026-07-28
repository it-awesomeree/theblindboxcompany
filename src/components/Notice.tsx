export function Notice({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'danger' | 'success' }) {
  return <div className={`notice notice-${tone}`} role="status" aria-live="polite">{children}</div>
}
