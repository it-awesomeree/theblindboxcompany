import type { ReactNode } from 'react'

export function SectionHeader({
  code,
  name,
  meta,
  title,
  children,
}: {
  code: string
  name: string
  meta: string
  title?: ReactNode
  children?: ReactNode
}) {
  return (
    <header className="section-heading">
      <div className="section-code">
        <span>{code}</span><b>{name}</b><i /><small>{meta}</small>
      </div>
      {title && <h2>{title}</h2>}
      {children}
    </header>
  )
}
