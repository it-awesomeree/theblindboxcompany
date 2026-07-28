import {
  assert,
  isoNow,
  stableHash,
  transitionBox,
  transitionBoxForReveal,
} from '../domain/guards'
import { publishedPrizesFor, prizeForBox } from '../domain/selectors'
import type { Box, DemoState, Order, PrizeDefinition } from '../domain/types'

export class PrizeService {
  private choose(state: DemoState, order: Order, box: Box): PrizeDefinition {
    const series = state.series.find((entry) => entry.id === order.snapshot.seriesId)
    assert(series, 'Prize series is missing.', 'SERIES_MISSING')
    const prizes = publishedPrizesFor(series)
    const weighted = prizes.map((prize) => {
      const counter = series.inventory.find((item) => item.prizeId === prize.id)
      const remaining = prize.allocation - (counter?.assigned ?? 0)
      return { prize, remaining }
    }).filter((entry) => entry.remaining > 0)
    const totalRemaining = weighted.reduce((sum, entry) => sum + entry.remaining, 0)
    assert(totalRemaining > 0, 'Series 001 is sold out.', 'SOLD_OUT')
    let pick = stableHash(`${order.id}:${box.id}:${series.oddsVersion}`) % totalRemaining
    for (const entry of weighted) {
      if (pick < entry.remaining) return entry.prize
      pick -= entry.remaining
    }
    return weighted[weighted.length - 1].prize
  }

  allocatePaidBoxes(state: DemoState, order: Order, at = isoNow()) {
    const series = state.series.find((entry) => entry.id === order.snapshot.seriesId)
    assert(series, 'Published series is missing.', 'SERIES_MISSING')
    const allocated: Box[] = []
    let newlyAllocated = 0
    for (const boxId of order.boxIds) {
      const box = state.boxes.find((entry) => entry.id === boxId)
      assert(box, `Box ${boxId} is missing.`, 'BOX_MISSING')
      if (box.prizeId) {
        allocated.push(box)
        continue
      }
      assert(box.status === 'reserved', 'Only reserved boxes can receive a paid prize.', 'BOX_NOT_RESERVED')
      const prize = this.choose(state, order, box)
      const counter = series.inventory.find((entry) => entry.prizeId === prize.id)
      assert(counter, 'Inventory counter is missing.', 'INVENTORY_MISSING')
      counter.assigned += 1
      box.prizeId = prize.id
      box.assignedAt = at
      box.status = transitionBox(box.status, 'paid_unopened')
      newlyAllocated += 1
      allocated.push(box)
    }
    assert(series.reservedBoxes >= newlyAllocated, 'Reserved stock counter is inconsistent.', 'RESERVATION_DRIFT')
    series.reservedBoxes -= newlyAllocated
    return allocated
  }

  openOwnedBox(state: DemoState, boxId: string, userId: string, at = isoNow()) {
    const box = state.boxes.find((entry) => entry.id === boxId)
    assert(box, 'Box was not found.', 'BOX_MISSING')
    assert(box.ownerId === userId, 'This box belongs to another fictional user.', 'FORBIDDEN')
    assert(box.prizeId, 'Prize allocation is still waiting for confirmed payment.', 'NOT_ALLOCATED')
    if (box.revealedAt) return { box, changed: false }
    const order = state.orders.find((entry) => entry.id === box.orderId)
    assert(order, 'Box order is missing.', 'ORDER_MISSING')
    assert(
      !['cancelled', 'refunded', 'disputed'].includes(order.status) && box.status !== 'on_hold',
      'This unopened box is on financial hold and cannot be opened.',
      'BOX_ON_HOLD',
    )
    box.revealedAt = at
    box.status = transitionBoxForReveal(box.status)
    return { box, changed: true }
  }

  prizeFor(state: DemoState, box: Box) {
    return prizeForBox(state, box)
  }
}
