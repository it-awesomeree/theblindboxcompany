import { titleCase } from '../lib/format'

export function StatusBadge({ value }: { value: string }) {
  const tone = ['succeeded', 'confirmed', 'fulfilled', 'delivered', 'active', 'opened'].includes(value)
    ? 'ok'
    : ['failed', 'cancelled', 'expired', 'lost', 'suspended', 'refunded', 'disputed'].includes(value)
      ? 'danger'
      : ['pending', 'processing', 'picking', 'packed', 'shipped', 'partially_fulfilled'].some((part) => value.includes(part))
        ? 'cyan'
        : 'neutral'
  return <span className={`status status-${tone}`}>{titleCase(value)}</span>
}
