import { providerError } from '../types'
import type { EntryRef, Provider, ProviderCtx } from '../types'
import type { DropboxFileRaw, DropboxFolderRaw } from './api-types'
import { entryToRef, hrefToDownloadUrl, parseSharedFolderUrl } from './parse'
import { listAllEntries, resolveViaApi } from './protocol'

function requireTab(ctx: ProviderCtx): number {
  if (ctx.tabId === null) {
    throw providerError({
      code: 'TAB_REQUIRED',
      message: 'Open the Dropbox shared folder in a tab to continue.',
      retryable: true,
      needsTab: true,
    })
  }
  return ctx.tabId
}

export const dropboxProvider: Provider = {
  id: 'dropbox',

  // The primary download path hands Dropbox's own link to chrome.downloads, which follows the
  // redirect chain with the browser's cookies — no tab, no injection, no API call. The tab is
  // only needed for scanning, and for the fallback path when a file needs it.
  needsTabForDownload: false,

  matchUrl: parseSharedFolderUrl,

  async listFolder(ctx, ref) {
    const tabId = requireTab(ctx)
    const folder = ref.raw as DropboxFolderRaw
    const { entries } = await listAllEntries(tabId, folder)

    const refs: EntryRef[] = []
    for (const entry of entries) {
      const child = entryToRef(entry, folder)
      // Dropping an entry we cannot read would quietly shrink the download — and a dropped
      // folder would take its whole subtree with it, past the point where the count
      // reconciliation could notice.
      if (!child) {
        throw providerError({
          code: 'PROTOCOL_CHANGED',
          message: `Could not read the entry “${entry.filename || 'unnamed'}” from Dropbox, so this folder cannot be downloaded completely.`,
          retryable: false,
          fatal: true,
        })
      }
      refs.push(child)
    }
    return refs
  },

  async resolveDownloadUrl(ctx, ref, useFallback) {
    const file = ref.raw as DropboxFileRaw
    if (!useFallback) return hrefToDownloadUrl(file)
    return resolveViaApi(requireTab(ctx), file)
  },
}
