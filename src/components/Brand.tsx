import { Link } from '../lib/router'

export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="The Blind Box Company demo home">
      <span className="brand-seal" aria-hidden="true" />
      <span className="brand-name"><b>THE BLIND BOX</b><br />COMPANY</span>
    </Link>
  )
}
