import { lazy, Suspense } from 'react'
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

const AdminRoutes = lazy(async () => {
  const module = await import('./pages/admin/AdminRoutes')
  return { default: module.AdminRoutes }
})

function match(pathname: string, pattern: RegExp, keys: string[]) {
  const result = pathname.match(pattern)
  if (!result) return null
  try {
    return Object.fromEntries(keys.map((key, index) => [
      key,
      decodeURIComponent(result[index + 1]),
    ]))
  } catch {
    return null
  }
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
    else return <NotFoundPage />
  }
  return <ParamsProvider params={params}>{page}</ParamsProvider>
}

function AppRoutes() {
  const { pathname, search } = useLocation()
  const page = pathname === '/admin' || pathname.startsWith('/admin/')
    ? (
        <Suspense
          fallback={(
            <section className="panel" role="status" aria-live="polite">
              Opening the admin demo…
            </section>
          )}
        >
          <AdminRoutes pathname={pathname} />
        </Suspense>
      )
    : <CustomerRoutes key={`${pathname}${search}`} pathname={pathname} />
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
