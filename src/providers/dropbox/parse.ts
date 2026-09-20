import type { EntryRef, MatchResult } from '../types'
import type { DropboxFileRaw, DropboxFolderRaw, StrippedEntry } from './api-types'

const HOSTS = new Set(['www.dropbox.com', 'dropbox.com'])

function reject(reason: string): MatchResult {
  return { ok: false, reason }
}

/**
 * The tab's URL → the folder to scan.
 *
 * A tab sitting deep inside the shared link is fine and desirable: that folder becomes the
 * download root, and the hash in the URL is already that folder's own.
 */
export function parseSharedFolderUrl(rawUrl: string): MatchResult {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return reject('That is not a web address.')
  }

  if (!HOSTS.has(url.hostname)) return reject('Open a Dropbox shared folder to scan it.')

  const segments = url.pathname.split('/').filter(Boolean)
  const rlkey = url.searchParams.get('rlkey') ?? ''

  if (segments[0] === 'scl' && segments[1] === 'fi') {
    return reject('That link points at a single file, not a folder.')
  }
  if (segments[0] === 's') {
    return reject('That link points at a single file, not a folder.')
  }
  if (segments[0] === 'home' || segments[0] === 'work') {
    return reject('Open the shared folder’s link, not your own Dropbox.')
  }

  // Modern content links (/scl/fo/) and legacy share links (/sh/) differ only in link_type.
  const isModern = segments[0] === 'scl' && segments[1] === 'fo'
  const isLegacy = segments[0] === 'sh'
  if (!isModern && !isLegacy) {
    return reject('Open a Dropbox shared folder to scan it.')
  }

  const offset = isModern ? 2 : 1
  const linkKey = segments[offset]
  const secureHash = segments[offset + 1]
  if (!linkKey || !secureHash) {
    return reject('That Dropbox link looks incomplete.')
  }

  // Modern links always carry rlkey; without it every request 404s, which would otherwise
  // surface as a confusing "folder not found".
  if (isModern && !rlkey) {
    return reject('Copy the whole link from Dropbox, including everything after the “?”.')
  }

  const subPath = segments
    .slice(offset + 2)
    .map((segment) => safeDecode(segment))
    .join('/')

  const raw: DropboxFolderRaw = {
    linkKey,
    linkType: isModern ? 'c' : 's',
    secureHash,
    subPath,
    rlkey,
  }

  const name = subPath ? (subPath.split('/').pop() ?? 'Dropbox folder') : 'Dropbox folder'
  return { ok: true, ref: { kind: 'folder', name, raw } }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** One listing entry → the ref the engine works with. */
export function entryToRef(entry: StrippedEntry, parent: DropboxFolderRaw): EntryRef | null {
  if (!entry.filename) return null

  if (!entry.isDir) {
    const raw: DropboxFileRaw = { href: entry.href, rlkey: parent.rlkey }
    return { kind: 'file', name: entry.filename, sizeBytes: entry.bytes, raw }
  }

  // Listing a subfolder needs that subfolder's OWN secure hash together with its full path from
  // the link root. The parent's hash with a child sub_path returns 404.
  const located = locateFolder(entry)
  if (!located) return null

  const raw: DropboxFolderRaw = {
    linkKey: parent.linkKey,
    linkType: parent.linkType,
    secureHash: located.secureHash,
    subPath: located.subPath,
    rlkey: parent.rlkey,
  }
  return { kind: 'folder', name: entry.filename, raw }
}

function locateFolder(entry: StrippedEntry): { secureHash: string; subPath: string } | null {
  if (entry.secureHash && entry.subPath !== null) {
    return { secureHash: entry.secureHash, subPath: entry.subPath.replace(/^\/+/, '') }
  }

  // Fallback: /scl/fo/<link_key>/<secure_hash>/<path segments>
  try {
    const segments = new URL(entry.href).pathname.split('/').filter(Boolean)
    const offset = segments[0] === 'scl' ? 2 : 1
    const secureHash = segments[offset + 1]
    if (!secureHash) return null
    return {
      secureHash,
      subPath: segments.slice(offset + 2).map(safeDecode).join('/'),
    }
  } catch {
    return null
  }
}

/**
 * The download URL for the primary path: the entry's own link with `dl=1`, which Chrome follows
 * through Dropbox's redirect chain to the signed host using the browser's own cookies.
 */
export function hrefToDownloadUrl(raw: DropboxFileRaw): string {
  try {
    const url = new URL(raw.href)
    url.searchParams.set('dl', '1')
    return url.toString()
  } catch {
    return raw.href
  }
}
