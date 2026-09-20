import type { ProviderError } from '../types'

/** Identifies one folder within a shared link. `subPath` is from the link root, no leading slash. */
export interface DropboxFolderRaw {
  linkKey: string
  linkType: string
  secureHash: string
  subPath: string
  rlkey: string
}

export interface DropboxFileRaw {
  href: string
  rlkey: string
}

/** What the injected function returns per entry — everything else is stripped in the page. */
export interface StrippedEntry {
  filename: string
  isDir: boolean
  bytes: number
  href: string
  /** From the parallel `share_tokens[]`, which is more robust than re-parsing `href`. */
  secureHash: string | null
  subPath: string | null
}

export interface StrippedListPage {
  entries: StrippedEntry[]
  totalNumEntries: number | null
  hasMore: boolean
  voucher: string | null
  folderName: string | null
}

/**
 * Chrome requires an `executeScript` result to be JSON-serializable, so a thrown Error arrives
 * as `{}`. Injected functions therefore catch internally and return this envelope instead.
 */
export type InjectedResult<T> = { ok: true; value: T } | { ok: false; error: ProviderError }
