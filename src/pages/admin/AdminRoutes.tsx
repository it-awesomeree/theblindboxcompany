import { useEffect } from 'react'
import { AdminGate } from '../../components/AdminGate'
import { NotFoundPage } from '../SystemPages'
import {
  AdminAuditPage,
  AdminClaimsPage,
  AdminDashboardPage,
  AdminFulfilmentPage,
  AdminInventoryPage,
  AdminLayout,
  AdminOrdersPage,
  AdminPaymentsPage,
  AdminUsersPage,
} from './AdminPages'

export function AdminRoutes({ pathname }: { pathname: string }) {
  useEffect(() => {
    const heading = document.querySelector<HTMLElement>(
      '#main-content h1',
    )
    heading?.setAttribute('tabindex', '-1')
    heading?.focus({ preventScroll: true })
  }, [pathname])

  let page: React.ReactNode
  if (pathname === '/admin') page = <AdminDashboardPage />
  else if (pathname === '/admin/users') page = <AdminUsersPage />
  else if (pathname === '/admin/orders') page = <AdminOrdersPage />
  else if (pathname === '/admin/payments') page = <AdminPaymentsPage />
  else if (pathname === '/admin/inventory') page = <AdminInventoryPage />
  else if (pathname === '/admin/fulfilment') page = <AdminFulfilmentPage />
  else if (pathname === '/admin/claims') page = <AdminClaimsPage />
  else if (pathname === '/admin/audit') page = <AdminAuditPage />
  else page = <NotFoundPage />
  return (
    <AdminGate>
      <AdminLayout>{page}</AdminLayout>
    </AdminGate>
  )
}
