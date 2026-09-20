export const Disposition = {
  /** Not the file's fault — retry without charging the attempt budget. */
  FreeRetry: 'free_retry',
  /** The signed URL went stale; re-resolve it. */
  Refresh: 'refresh',
  /** The bytes arrived but were the wrong bytes. */
  SizeMismatch: 'size_mismatch',
  Retry: 'retry',
  Terminal: 'terminal',
  UserCanceled: 'user_canceled',
  OutOfSpace: 'out_of_space',
} as const
export type Disposition = (typeof Disposition)[keyof typeof Disposition]

const FREE_RETRY = new Set(['USER_SHUTDOWN', 'CRASH', 'UNKNOWN_ERASED'])

// The expired-signature signature: the fix is regenerating the URL, not waiting longer.
const REFRESH = new Set(['SERVER_UNAUTHORIZED', 'SERVER_FORBIDDEN', 'SERVER_CROSS_ORIGIN_REDIRECT'])

const RETRYABLE = new Set([
  'NETWORK_FAILED',
  'NETWORK_TIMEOUT',
  'NETWORK_DISCONNECTED',
  'NETWORK_SERVER_DOWN',
  'SERVER_FAILED',
  'SERVER_UNREACHABLE',
  'SERVER_NO_RANGE',
  'SERVER_CONTENT_LENGTH_MISMATCH',
  'FILE_FAILED',
  'FILE_TRANSIENT_ERROR',
  'FILE_TOO_SHORT',
  'FILE_HASH_MISMATCH',
])

const TERMINAL = new Set([
  'FILE_ACCESS_DENIED',
  'FILE_NAME_TOO_LONG',
  'FILE_TOO_LARGE',
  'FILE_VIRUS_INFECTED',
  'FILE_BLOCKED',
  'FILE_SECURITY_CHECK_FAILED',
  'FILE_SAME_AS_SOURCE',
  'NETWORK_INVALID_REQUEST',
  'SERVER_BAD_CONTENT',
  'SERVER_CERT_PROBLEM',
])

export function classifyInterrupt(reason: string | undefined): Disposition {
  if (!reason) return Disposition.Retry
  if (reason === 'USER_CANCELED') return Disposition.UserCanceled
  if (reason === 'FILE_NO_SPACE') return Disposition.OutOfSpace
  if (FREE_RETRY.has(reason)) return Disposition.FreeRetry
  if (REFRESH.has(reason)) return Disposition.Refresh
  if (RETRYABLE.has(reason)) return Disposition.Retry
  if (TERMINAL.has(reason)) return Disposition.Terminal
  // An unrecognised reason gets the benefit of the doubt, bounded by the attempt budget.
  return Disposition.Retry
}

export const MAX_ATTEMPTS = 5
export const MAX_REFRESHES = 2

// Chrome clamps alarms in a packed extension to a 30s minimum, so nothing here asks for less —
// a shorter delay would silently become 30s anyway.
export const FREE_RETRY_DELAY_MS = 30_000
export const REFRESH_DELAY_MS = 30_000

export function backoffMs(attempts: number): number {
  const base = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000)
  return Math.round(base * (0.8 + Math.random() * 0.4))
}
