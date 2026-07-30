import type { Order } from './types'

export function sealedCustomerTimeline(order: Order): Order['timeline'] {
  let paymentConfirmed = false
  let financialHoldActive = false
  return order.timeline.flatMap((entry, index) => {
    if (index === 0) {
      return [{
        id: entry.id,
        status: 'pending_payment' as const,
        label: 'Demo order created',
        at: entry.at,
      }]
    }
    if (entry.status === 'confirmed' && !paymentConfirmed) {
      paymentConfirmed = true
      return [{ ...entry, label: 'Mock payment confirmed' }]
    }
    if (entry.financialHoldPreviousStatus) {
      financialHoldActive = true
      return [{
        ...entry,
        label: `Demo order placed on ${entry.status.replaceAll('_', ' ')} financial hold`,
      }]
    }
    if (financialHoldActive) {
      financialHoldActive = false
      return [{
        id: entry.id,
        status: entry.status,
        label: 'Demo financial hold resolved',
        at: entry.at,
      }]
    }
    return []
  })
}
