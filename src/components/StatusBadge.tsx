import { titleCase } from '../lib/format'

export function StatusBadge({ value }: { value: string }) {
  const tone = [
    'succeeded',
    'confirmed',
    'fulfilled',
    'delivered',
    'active',
    'opened',
    'resolved',
    'refund_completed',
    'replacement_delivered',
  ].includes(value)
    ? 'ok'
    : [
      'failed',
      'failed_delivery',
      'returned',
      'rejected',
      'cancelled',
      'expired',
      'lost',
      'suspended',
      'refunded',
      'disputed',
    ].includes(value)
      ? 'danger'
      : [
        'submitted',
        'reviewing',
        'approved',
        'issued',
        'sent',
        'label_created',
        'refund_linked',
        'rma_created',
        'rma_received',
        'rma_inspected',
        'replacement_authorized',
      ].includes(value) ||
        ['pending', 'processing', 'picking', 'packed', 'shipped', 'partially_fulfilled'].some((part) => value.includes(part))
        ? 'cyan'
        : 'neutral'
  return <span className={`status status-${tone}`}>{titleCase(value)}</span>
}
