import type { PropsWithChildren } from 'react'
import { Navigate } from '../lib/router'
import { useLocation } from '../lib/router-core'
import { useAppState } from '../state/AppStateContext'

export function AdminGate({ children }: PropsWithChildren) {
  const { services } = useAppState()
  const location = useLocation()
  try {
    services.admin.assertAccess()
    return children
  } catch {
    return <Navigate to="/unauthorized" replace state={{ from: location.pathname }} />
  }
}
