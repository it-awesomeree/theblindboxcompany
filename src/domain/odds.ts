function positiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer.`)
  }
}

function groupInteger(value: number) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function exactOddsLabel(allocation: number, allocationTotal: number) {
  positiveInteger(allocation, 'Allocation')
  positiveInteger(allocationTotal, 'Allocation total')
  if (allocation > allocationTotal) {
    throw new RangeError('Allocation cannot exceed allocation total.')
  }
  return `${groupInteger(allocation)} in ${groupInteger(allocationTotal)}`
}
