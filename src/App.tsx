import { AdminGate } from './components/AdminGate'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Layout } from './components/Layout'
import { HashRouter, ParamsProvider } from './lib/router'
import { useLocation } from './lib/router-core'
import { AccountPage } from './pages/AccountPage'
import { AuthPage } from './pages/AuthPage'
import { CartPage } from './pages/CartPage'
import { CheckoutPage } from './pages/CheckoutPage'
import { ClaimPage } from './pages/ClaimPage'
import { HomePage } from './pages/HomePage'
import { MockPaymentPage } from './pages/MockPaymentPage'
import { OpenBoxPage } from './pages/OpenBoxPage'
import { OrderPage } from './pages/OrderPage'
import { PaymentReturnPage } from './pages/PaymentReturnPage'
import { NotFoundPage, UnauthorizedPage } from './pages/SystemPages'
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
} from './pages/admin/AdminPages'

function match(pathname: string, pattern: RegExp, keys: string[]) {
  const result = pathname.match(pattern)
  if (!result) return null
  return Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(result[index + 1])]))
}

function CustomerRoutes({ pathname }: { pathname: string }) {
  let params: Record<string, string> = {}
  let page: React.ReactNode
  if (pathname === '/') page = <HomePage />
  else if (pathname === '/auth') page = <AuthPage />
  else if (pathname === '/cart') page = <CartPage />
  else if (pathname === '/checkout') page = <CheckoutPage />
  else {
    const payment = match(pathname, /^\/pay\/([^/]+)\/([^/]+)$/, ['orderId', 'paymentId'])
    const paymentReturn = match(pathname, /^\/payment-return\/([^/]+)$/, ['paymentId'])
    const order = match(pathname, /^\/order\/([^/]+)$/, ['orderId'])
    const box = match(pathname, /^\/open\/([^/]+)$/, ['boxId'])
    if (payment) {
      params = payment
      page = <MockPaymentPage />
    } else if (paymentReturn) {
      params = paymentReturn
      page = <PaymentReturnPage />
    } else if (order) {
      params = order
      page = <OrderPage />
    } else if (box) {
      params = box
      page = <OpenBoxPage />
    } else if (pathname === '/account') page = <AccountPage />
    else if (pathname === '/claim/new') page = <ClaimPage />
    else if (pathname === '/unauthorized') page = <UnauthorizedPage />
    else if (pathname === '/not-found') page = <NotFoundPage />
    else return null
  }
  return <ParamsProvider params={params}>{page}</ParamsProvider>
}

function AdminRoutes({ pathname }: { pathname: string }) {
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
  return <AdminGate><AdminLayout>{page}</AdminLayout></AdminGate>
}

function AppRoutes() {
  const { pathname } = useLocation()
  const customer = CustomerRoutes({ pathname })
  const page = pathname === '/admin' || pathname.startsWith('/admin/')
    ? <AdminRoutes pathname={pathname} />
    : customer ?? <NotFoundPage />
  return <Layout>{page}</Layout>
}

export function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </ErrorBoundary>
  )
}
