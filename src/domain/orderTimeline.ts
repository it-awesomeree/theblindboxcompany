import type { Order } from './types'

export function sealedCustomerTimeline(order: Order): Order['timeline'] {
  let paymentConfirmed = false
  return order.timeline.flatMap((entry, index) => {
    if (index === 0) {
      return [{
        id: entry.id,
        status: 'pending_payment' as const,
        label: 'Demo order created',
        at: entry.at,
      }]
    }
    if (entry.status === 'pending_payment') {
      return [{ ...entry, label: 'Demo payment reservation updated' }]
    }
    if (entry.status === 'confirmed' && !paymentConfirmed) {
      paymentConfirmed = true
      return [{ ...entry, label: 'Mock payment confirmed' }]
    }
    if (entry.financialHoldPreviousStatus) {
      return [{
        ...entry,
        label: `Demo order placed on ${entry.status.replaceAll('_', ' ')} financial hold`,
      }]
    }
    return []
  })
}
