import { asProviderError, providerError } from '../types'
import type { ProviderError } from '../types'
import type {
  DropboxFileRaw,
  DropboxFolderRaw,
  InjectedResult,
  StrippedEntry,
  StrippedListPage,
} from './api-types'
import { dropboxDownloadUrlInjected, dropboxListInjected } from './injected'

/** Paced well under what the Dropbox UI itself generates when a human scrolls a big folder. */
const LIST_DELAY_MS = 300
const MAX_PAGES = 500
const LIST_ATTEMPTS = 3
/** Dropbox's "link is generating too much traffic" — an hours-long block, never worth retrying. */
const BANDWIDTH_BLOCKED = 509

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Synchronised fixed-interval traffic is what naive bots look like; jitter costs one line. */
function jittered(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4))
}

function folderLabel(folder: DropboxFolderRaw): string {
  return folder.subPath || 'the shared folder'
}

function protocolChanged(detail: string): Error {
  return providerError({
    code: 'PROTOCOL_CHANGED',
    message:
      'Dropbox’s folder listing did not behave as expected, so this extension cannot read the folder reliably. Syncing the folder in the Dropbox desktop app will still work.',
    retryable: false,
    fatal: true,
    detail,
  })
}

async function runInPage<Args extends unknown[], Value>(
  tabId: number,
  func: (...args: Args) => Promise<InjectedResult<Value>>,
  args: Args,
): Promise<Value> {
  let results
  try {
    results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args })
  } catch (error) {
    // The tab was closed, navigated, or is not injectable.
    throw providerError({
      code: 'TAB_LOST',
      message: 'Lost the Dropbox tab. Open the shared folder again to continue.',
      retryable: true,
      needsTab: true,
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  const result = results[0]?.result
  if (!result) throw protocolChanged('injection returned nothing')
  if (!result.ok) throw providerError(result.error)
  return result.value
}

async function listOnePage(
  tabId: number,
  folder: DropboxFolderRaw,
  voucher: string | null,
): Promise<StrippedListPage> {
  let lastError: ProviderError | null = null

  for (let attempt = 1; attempt <= LIST_ATTEMPTS; attempt += 1) {
    try {
      return await runInPage(tabId, dropboxListInjected, [{ ...folder, voucher }])
    } catch (error) {
      const info = asProviderError(error)
      // A bandwidth block clears in hours, not seconds; retrying only deepens it.
      if (!info || !info.retryable || info.status === BANDWIDTH_BLOCKED) throw error
      lastError = info
      if (attempt < LIST_ATTEMPTS) await sleep(Math.min(info.retryAfterMs ?? 0, 10_000) || jittered(1500 * attempt))
    }
  }

  // The budget is the escalation: a refusal that survives three tries with a fresh token is
  // reported to the user rather than retried forever.
  throw providerError({
    ...(lastError ?? {
      code: 'REQUEST_REJECTED',
      message: 'Dropbox would not list this folder.',
      status: undefined,
    }),
    retryable: false,
  })
}

/**
 * Every entry in one folder, pagination drained.
 *
 * The guards here are the most safety-critical logic in the extension: the continuation field is
 * `voucher`, and sending it wrongly is not rejected — Dropbox returns page one forever, which
 * silently truncates the tree. A short listing must be a hard error, never a warning.
 */
export async function listAllEntries(
  tabId: number,
  folder: DropboxFolderRaw,
): Promise<{ entries: StrippedEntry[]; folderName: string | null }> {
  const all: StrippedEntry[] = []
  let voucher: string | null = null
  let previousVoucher: string | null = null
  let expected: number | null = null
  let folderName: string | null = null

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const value = await listOnePage(tabId, folder, voucher)

    if (page === 0) {
      // The count is the only actual proof of completeness. Without it the shortfall check below
      // would silently pass, which is precisely the truncation this whole function exists to
      // prevent — so its absence is fatal rather than tolerated.
      if (value.totalNumEntries === null) {
        throw protocolChanged(`no total_num_entries for ${folderLabel(folder)}`)
      }
      expected = value.totalNumEntries
      folderName = value.folderName
    }

    all.push(...value.entries)

    if (!value.hasMore) {
      if (expected !== null && all.length !== expected) {
        throw providerError({
          code: 'INCOMPLETE_LISTING',
          message: `Dropbox listed only ${all.length} of ${expected} items in “${folderLabel(folder)}”. Stopping rather than downloading part of the folder.`,
          retryable: false,
          fatal: true,
        })
      }
      return { entries: all, folderName }
    }

    // Checked only once more entries are actually promised, so a legitimately empty final page
    // is not mistaken for a stalled continuation.
    if (voucher !== null && value.entries.length === 0) {
      throw protocolChanged(`continuation returned no entries in ${folderLabel(folder)}`)
    }
    if (!value.voucher) throw protocolChanged(`more entries promised with no voucher in ${folderLabel(folder)}`)
    if (value.voucher === previousVoucher) throw protocolChanged(`voucher did not advance in ${folderLabel(folder)}`)

    previousVoucher = value.voucher
    voucher = value.voucher
    await sleep(jittered(LIST_DELAY_MS))
  }

  throw protocolChanged(`more than ${MAX_PAGES} pages in ${folderLabel(folder)}`)
}

/**
 * Header shape that last worked, escalated only on refusal and remembered for the rest of this
 * worker's life. Losing it to a worker restart just re-escalates once — it is an optimisation,
 * never load-bearing state.
 */
let cachedHeaderMode: number | null = null

/** The fallback resolution path: ask Dropbox for a signed URL the way its own UI does. */
export async function resolveViaApi(tabId: number, file: DropboxFileRaw): Promise<string> {
  for (let mode = cachedHeaderMode ?? 0; mode <= 2; mode += 1) {
    try {
      const value = await runInPage(tabId, dropboxDownloadUrlInjected, [file.href, file.rlkey, mode])
      cachedHeaderMode = mode
      return value.downloadUrl
    } catch (error) {
      const info = asProviderError(error)
      if (!info || info.code !== 'DOWNLOAD_URL_REJECTED' || mode === 2) throw error
    }
  }

  throw providerError({
    code: 'DOWNLOAD_URL_REJECTED',
    message: 'Dropbox would not hand out a download link for this file.',
    retryable: true,
  })
}
