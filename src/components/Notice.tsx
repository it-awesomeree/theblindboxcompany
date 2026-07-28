export function Notice({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'danger' | 'success' }) {
  const urgent = tone === 'danger'
  return (
    <div
      className={`notice notice-${tone}`}
      role={urgent ? 'alert' : 'status'}
      aria-live={urgent ? 'assertive' : 'polite'}
    >
      {children}
    </div>
  )
}
