import { PRIZES, SERIES_ALLOCATION_TOTAL } from '../domain/constants'
import { exactOddsLabel } from '../domain/odds'
import { formatMYR } from '../lib/format'
import { useAppState } from '../state/AppStateContext'

export function PrizePoolTable() {
  const { state } = useAppState()
  const published = state.series.find((series) => series.status === 'published')
  const prizes = published?.publishedPrizes ?? PRIZES
  const allocationTotal = published?.allocationTotal ?? SERIES_ALLOCATION_TOTAL

  return (
    <>
      <div className="responsive-table prize-table-wrap">
        <table className="data-table prize-table">
          <thead><tr><th>#</th><th>Prize</th><th>Declared value</th><th>Per 10,000</th><th>Odds</th><th>Tier</th></tr></thead>
          <tbody>
            {prizes.map((item, index) => (
              <tr key={item.id} className={item.tier === 'Grail' ? 'grail-row' : ''}>
                <td data-label="#">{String(index + 1).padStart(2, '0')}</td>
                <td data-label="Prize">{item.name}</td>
                <td data-label="Value" className="money">{formatMYR(item.valueSen)}</td>
                <td data-label="Per case">{item.allocation.toLocaleString('en-MY')}</td>
                <td data-label="Odds">{exactOddsLabel(item.allocation, allocationTotal)}</td>
                <td data-label="Tier"><span className={`tier tier-${item.tier.toLowerCase()}`}>{item.tier}</span></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td /><td>Total — one sealed case</td><td>Fixture entries declare ≥ RM100</td><td>{allocationTotal.toLocaleString('en-MY')}</td><td>100%</td><td /></tr></tfoot>
        </table>
      </div>
      <p className="table-note"><b>Declared value</b> is unverified fixture data for reviewing this concept. It is not a current retail-price claim. The mock pool deliberately shows that 9,500 boxes are dapur tier.</p>
    </>
  )
}
