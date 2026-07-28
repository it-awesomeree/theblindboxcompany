import { Link } from '../lib/router'
import { useNavigate } from '../lib/router-core'
import { BOX_PRICE_SEN, MAX_CART_QUANTITY } from '../domain/constants'
import { formatMYR } from '../lib/format'
import { useAppState } from '../state/AppStateContext'

export function CartPage() {
  const { state, services } = useAppState()
  const navigate = useNavigate()
  const item = state.cart[0]
  const quantity = item?.quantity ?? 0

  return (
    <section className="route-page">
      <div className="content">
        <div className="page-heading">
          <div><span className="eyebrow">CUSTOMER / CART</span><h1>Demo cargo list.</h1><p>RM100 per Series 001 box. Maximum 10 per demo order.</p></div>
          <span className="huge-code">CART</span>
        </div>
        {!item ? (
          <div className="empty-state"><span>00</span><h2>Your demo cart is empty.</h2><Link className="button" to="/">Return to the vault</Link></div>
        ) : (
          <div className="cart-layout">
            <article className="panel cart-product">
              <div className="product-glyph" aria-hidden="true"><span>001</span></div>
              <div>
                <span className="eyebrow">PUBLISHED · FIXED POOL</span>
                <h2>Series 001 Blind Box</h2>
                <p>One immutable paid prize after a valid mock webhook. Every declared value is at least RM100.</p>
                <div className="quantity-control" aria-label="Cart quantity">
                  <button type="button" aria-label="Decrease quantity" onClick={() => services.orders.setCartQuantity(Math.max(0, quantity - 1))}>−</button>
                  <label><span>Quantity</span><input type="number" min="1" max={MAX_CART_QUANTITY} value={quantity} onChange={(event) => services.orders.setCartQuantity(Number(event.target.value))} /></label>
                  <button type="button" aria-label="Increase quantity" onClick={() => services.orders.setCartQuantity(Math.min(MAX_CART_QUANTITY, quantity + 1))}>+</button>
                </div>
                <button className="text-button" type="button" onClick={() => services.orders.setCartQuantity(0)}>Remove from cart</button>
              </div>
              <strong>{formatMYR(BOX_PRICE_SEN * quantity)}</strong>
            </article>
            <aside className="panel order-summary">
              <div className="panel-heading"><div><span>ORDER REVIEW</span><h2>Before shipping</h2></div></div>
              <dl>
                <div><dt>{quantity} × demo box</dt><dd>{formatMYR(BOX_PRICE_SEN * quantity)}</dd></div>
                <div><dt>Shipping</dt><dd>Calculated next</dd></div>
                <div className="summary-total"><dt>Current subtotal</dt><dd>{formatMYR(BOX_PRICE_SEN * quantity)}</dd></div>
              </dl>
              <button className="button button-full" type="button" onClick={() => navigate(state.sessionUserId ? '/checkout' : '/auth', { state: { from: '/checkout' } })}>
                {state.sessionUserId ? 'Continue to checkout' : 'Sign in to checkout'}
              </button>
              <small>No real charge. Stock is reserved only inside this browser.</small>
            </aside>
          </div>
        )}
      </div>
    </section>
  )
}
