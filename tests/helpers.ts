import type { StorageLike } from '../src/data/MockRepository'
import type { AppServices } from '../src/services/AppServices'

export class MemoryStorage implements StorageLike {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  seed(key: string, value: string) { this.values.set(key, value) }
}

export class CountingStorage extends MemoryStorage {
  writes = 0

  setItem(key: string, value: string) {
    this.writes += 1
    super.setItem(key, value)
  }
}

export const FIXED_NOW = '2026-07-28T04:00:00.000Z'

export function makeProcessingOrderTwoPhysicalShipments(services: AppServices) {
  services.repository.update((state) => {
    const box = state.boxes.find((entry) => entry.id === 'box-processing-02')!
    box.prizeId = 'air-fryer'
    const series = state.series.find((entry) => entry.id === box.seriesId)!
    series.inventory.find((entry) => entry.prizeId === 'tng')!.assigned -= 1
    series.inventory.find((entry) => entry.prizeId === 'air-fryer')!.assigned += 1
    const shipment = state.shipments.find((entry) => entry.id === 'shp-digital')!
    shipment.kind = 'PARCEL'
    shipment.carrier = 'Demo Express'
    shipment.insured = false
    shipment.signatureRequired = false
    shipment.timeline[0].label = 'PARCEL fulfilment queued'
  })
}
