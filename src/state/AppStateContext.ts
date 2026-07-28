import { createContext, useContext } from 'react'
import type { DemoState } from '../domain/types'
import type { AppServices } from '../services/AppServices'

interface AppStateValue {
  state: DemoState
  services: AppServices
}

export const AppStateContext = createContext<AppStateValue | null>(null)

export function useAppState() {
  const value = useContext(AppStateContext)
  if (!value) throw new Error('AppStateProvider is missing.')
  return value
}
