export interface ProviderCtx {
  /** Null when no provider tab is open. A provider that needs one throws with `needsTab`. */
  tabId: number | null
}

export interface FolderRef {
  kind: 'folder'
  name: string
  /** Provider-opaque. */
  raw: unknown
}

export interface FileRef {
  kind: 'file'
  name: string
  sizeBytes: number
  raw: unknown
}

export type EntryRef = FolderRef | FileRef

export interface ProviderError {
  code: string
  /** User-facing and actionable. No jargon, no status codes. */
  message: string
  /** The engine branches on this, never on `code`. */
  retryable: boolean
  /** Cannot proceed until a provider tab is available. */
  needsTab?: boolean
  /** What we hold can no longer be trusted — abort the run loudly rather than continue. */
  fatal?: boolean
  retryAfterMs?: number
  status?: number
  /** Log only, never shown. */
  detail?: string
}

type Tagged = Error & { providerError: ProviderError }

/** A real Error (so stacks survive) carrying the typed payload the engine branches on. */
export function providerError(error: ProviderError): Tagged {
  const err = new Error(error.message) as Tagged
  err.providerError = error
  return err
}

export function asProviderError(value: unknown): ProviderError | null {
  if (value && typeof value === 'object' && 'providerError' in value) {
    return (value as Tagged).providerError
  }
  return null
}

export type MatchResult = { ok: true; ref: FolderRef } | { ok: false; reason: string }

export interface Provider {
  readonly id: string
  /**
   * Whether the primary download path needs a live provider tab. When false the tab is only
   * required for scanning, and a run can continue with every provider tab closed.
   */
  readonly needsTabForDownload: boolean
  matchUrl(url: string): MatchResult
  /** Drains pagination internally — the engine never sees a cursor. */
  listFolder(ctx: ProviderCtx, ref: FolderRef): Promise<EntryRef[]>
  resolveDownloadUrl(ctx: ProviderCtx, ref: FileRef, useFallback: boolean): Promise<string>
}
