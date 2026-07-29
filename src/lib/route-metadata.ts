const TITLE_SUFFIX = 'The Blind Box Company | Demo / No Real Charge'

const ROUTE_LABELS: Readonly<Record<string, string>> = {
  '/': 'Home',
  '/auth': 'Auth',
  '/cart': 'Cart',
  '/checkout': 'Checkout',
  '/account': 'Account',
  '/claim/new': 'Claim',
  '/admin': 'Admin Overview',
  '/admin/users': 'Admin Users',
  '/admin/orders': 'Admin Orders',
  '/admin/payments': 'Admin Payments',
  '/admin/inventory': 'Admin Inventory',
  '/admin/fulfilment': 'Admin Fulfilment',
  '/admin/claims': 'Admin Claims',
  '/admin/audit': 'Admin Audit',
  '/unauthorized': 'Unauthorized',
  '/not-found': 'Not Found',
}

const PARAMETER_ROUTES: ReadonlyArray<{
  pattern: RegExp
  label: string
}> = [
  { pattern: /^\/pay\/([^/]+)\/([^/]+)$/, label: 'Mock Payment' },
  { pattern: /^\/payment-return\/([^/]+)$/, label: 'Payment Return' },
  { pattern: /^\/order\/([^/]+)$/, label: 'Order' },
  { pattern: /^\/open\/([^/]+)$/, label: 'Open Box' },
]

function hasValidEncodedParameters(pathname: string, pattern: RegExp) {
  const match = pathname.match(pattern)
  if (!match) return false
  try {
    match.slice(1).forEach((value) => decodeURIComponent(value))
    return true
  } catch {
    return false
  }
}

export function titleForRoute(pathname: string) {
  const exactLabel = ROUTE_LABELS[pathname]
  const parameterLabel = PARAMETER_ROUTES.find(({ pattern }) =>
    hasValidEncodedParameters(pathname, pattern),
  )?.label
  const label = exactLabel ?? parameterLabel ?? 'Not Found'
  return `${label} | ${TITLE_SUFFIX}`
}
