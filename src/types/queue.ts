// `erasableSyntaxOnly` is on, so status sets are const objects plus a derived union, never enums.

export const RunStatus = {
  Scanning: 'scanning',
  ScanFailed: 'scan_failed',
  Scanned: 'scanned',
  Running: 'running',
  Paused: 'paused',
  Blocked: 'blocked',
  Done: 'done',
} as const
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus]

export const ItemStatus = {
  Pending: 'pending',
  Resolving: 'resolving',
  Downloading: 'downloading',
  RetryWait: 'retry_wait',
  Complete: 'complete',
  Failed: 'failed',
  Skipped: 'skipped',
} as const
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus]

export interface Run {
  id: string
  source: { url: string; rootName: string }
  /** Destination subfolder under the browser's Downloads directory. Already sanitized. */
  destination: string
  status: RunStatus
  /** Last known provider tab. Always revalidated before use — ids are recycled across restarts. */
  tabId: number | null
  /** The one-at-a-time lock. Lives here, in storage, not in a worker variable. */
  activeItemId: string | null
  totals: { files: number; bytes: number }
  completed: { files: number; bytes: number }
  failedCount: number
  /** User-facing reason for `blocked` / `paused`, or a fatal abort message. */
  message: string | null
  scanProgress: { folders: number; files: number } | null
  /** Whether we hid Chrome's download UI, so startup can restore it if we died with it off. */
  uiHidden: boolean
  startedAt: number
}

export type TreeNode =
  | { kind: 'folder'; name: string; children: TreeNode[]; bytes: number; fileCount: number }
  | { kind: 'file'; name: string; bytes: number }

export interface QueueItem {
  id: string
  /** Sanitized, '/'-joined, WITHOUT the destination prefix. */
  relPath: string
  name: string
  sizeBytes: number
  /** Provider-opaque; whatever resolveDownloadUrl needs. */
  fileRef: unknown
  status: ItemStatus
  downloadId: number | null
  /** Written BEFORE downloads.download is called — the anchor orphan reconciliation searches on. */
  startedAt: number | null
  /** Failures that were the file's own fault. */
  attempts: number
  /** URL re-resolves, budgeted separately so an expiry storm can't exhaust `attempts`. */
  refreshes: number
  nextAttemptAt: number | null
  /** We cancelled it (a pause) rather than the user cancelling from Chrome's own UI. */
  expectCancel: boolean
  /** Switched to the provider's fallback resolution path after repeated size mismatches. */
  useFallbackPath: boolean
  error: string | null
}

export interface ActiveProgress {
  downloadId: number
  bytesReceived: number
  totalBytes: number
  estimatedEndTime: string | null
}
