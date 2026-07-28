import { assert } from './guards'
import type { Box, DemoState, PrizeDefinition, PrizeSeries } from './types'

export function publishedPrizesFor(series: PrizeSeries): PrizeDefinition[] {
  assert(
    series.status === 'published' && Array.isArray(series.publishedPrizes),
    'Published prize snapshot is missing.',
    'SERIES_SNAPSHOT_MISSING',
  )
  return series.publishedPrizes
}

export function prizeForBox(state: DemoState, box: Box | undefined) {
  if (!box?.prizeId) return undefined
  const series = state.series.find((entry) => entry.id === box.seriesId)
  if (!series || series.status !== 'published' || !series.publishedPrizes) return undefined
  return series.publishedPrizes.find((prize) => prize.id === box.prizeId)
}

export function boxRevealEligibility(state: DemoState, box: Box | undefined) {
  if (!box) return { eligible: false, reason: 'Box record is missing.' }
  if (box.revealedAt) return { eligible: true, reason: 'The immutable reveal remains viewable.' }
  const order = state.orders.find((entry) => entry.id === box.orderId)
  if (!order || ['cancelled', 'refunded', 'disputed'].includes(order.status) || box.status === 'on_hold') {
    return {
      eligible: false,
      reason: 'Opening is paused because this order is cancelled, refunded, disputed, or on fulfilment hold.',
    }
  }
  if (!box.prizeId) return { eligible: false, reason: 'Opening waits for a confirmed demo payment.' }
  return { eligible: true, reason: 'This paid demo box can be opened once.' }
}
