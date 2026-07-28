import { Component, type ReactNode } from 'react'

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <main className="route-page">
          <div className="content narrow">
            <div className="error-panel">
              <span className="eyebrow">DEMO SAFETY STOP</span>
              <h1>That action was blocked.</h1>
              <p>{this.state.error.message}</p>
              <button className="button" type="button" onClick={() => { this.setState({ error: null }); window.location.hash = '#/' }}>
                Return to vault
              </button>
            </div>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}
