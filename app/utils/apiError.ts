import { ContractError } from '../../shared/client'

export function apiError(error: unknown): string {
  if (error instanceof ContractError) return error.message
  if (error && typeof error === 'object' && 'data' in error) {
    const data = error.data
    if (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string') return data.message
  }
  return 'Could not reach the server. Please try again.'
}
