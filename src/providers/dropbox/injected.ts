import type { InjectedResult, StrippedEntry, StrippedListPage } from './api-types'

/**
 * ⚠ EVERY function in this file is handed to `chrome.scripting.executeScript({ func })`, which
 * serializes it with `Function.prototype.toString()` and re-parses it inside the Dropbox page.
 * The page has no access to this module's scope, so in this file only:
 *
 *   - take every input as a parameter
 *   - reference nothing but your own locals and page globals (`fetch`, `document`, `atob`,
 *     `URLSearchParams`, `JSON`)
 *   - never import a runtime value. `import type` is fine — types are erased before bundling.
 *   - catch internally and RETURN an error object: Chrome requires a JSON-serializable result,
 *     so a thrown Error arrives as `{}` and `undefined` arrives as `null`.
 *   - stay dumb. One request in, stripped data out. Loops, guards and reconciliation live in
 *     protocol.ts where they are typed, linted and readable.
 *
 * The build must stay at `target: 'esnext'` (see vite.worker.config.ts), or esbuild lowers
 * async/spread into module-scope helpers that do not exist in the page and every function here
 * throws a ReferenceError on injection.
 */

export async function dropboxListInjected(params: {
  linkKey: string
  linkType: string
  secureHash: string
  subPath: string
  rlkey: string
  voucher: string | null
}): Promise<InjectedResult<StrippedListPage>> {
  const readCookie = (name: string): string | null => {
    for (const part of document.cookie.split('; ')) {
      if (!part) continue
      const split = part.indexOf('=')
      if (split < 0) continue
      if (part.slice(0, split) !== name) continue
      try {
        return decodeURIComponent(part.slice(split + 1))
      } catch {
        return part.slice(split + 1)
      }
    }
    return null
  }

  try {
    // Dropbox mirrors the CSRF token into `t` precisely so page scripts can read it. Re-read it
    // every call rather than caching: it is free, and Dropbox rotates it on session refresh.
    const token = readCookie('__Host-js_csrf') ?? readCookie('t')
    if (!token) {
      return {
        ok: false,
        error: {
          code: 'NO_CSRF',
          message:
            'Could not read the Dropbox session from this page. Reload the Dropbox folder tab and try again.',
          retryable: false,
        },
      }
    }

    const body = new URLSearchParams()
    body.set('is_xhr', 'true')
    body.set('t', token)
    body.set('link_key', params.linkKey)
    body.set('link_type', params.linkType)
    body.set('secure_hash', params.secureHash)
    body.set('sub_path', params.subPath)
    if (params.rlkey) body.set('rlkey', params.rlkey)
    // The continuation field is `voucher`. Sending it under any other name is NOT rejected —
    // Dropbox ignores it and returns page one forever, which silently truncates the tree.
    if (params.voucher) body.set('voucher', params.voucher)

    const response = await fetch('https://www.dropbox.com/list_shared_link_folder_entries', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    })

    const text = await response.text()

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('Retry-After')
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN
      const bandwidthBlocked = response.status === 509
      return {
        ok: false,
        error: {
          code: bandwidthBlocked
            ? 'BANDWIDTH_BLOCKED'
            : response.status === 401
              ? 'NOT_LOGGED_IN'
              : response.status === 429
                ? 'THROTTLED'
                : 'REQUEST_REJECTED',
          message: bandwidthBlocked
            ? 'Dropbox has temporarily blocked this link for too much traffic. This usually clears after a few hours.'
            : response.status === 401
              ? 'You are signed out of Dropbox. Sign in and reload the folder tab.'
              : 'Dropbox refused the request. It may be rate-limiting, or the link may no longer be shared with you.',
          // 400/403/404 mid-walk are routinely throttle responses rather than real refusals, so
          // they are retried on a budget and only reported once that budget is spent.
          retryable: response.status !== 401,
          status: response.status,
          retryAfterMs: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : undefined,
          detail: text.slice(0, 400),
        },
      }
    }

    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      // A 200 carrying HTML is a login wall, an interstitial, or a redesigned endpoint. It must
      // never be swallowed as "empty folder".
      return {
        ok: false,
        error: {
          code: 'PROTOCOL_CHANGED',
          message:
            'Dropbox returned a web page instead of folder data. Its internal endpoints have probably changed, so this extension cannot read the folder reliably. Syncing the folder in the Dropbox desktop app will still work.',
          retryable: false,
          fatal: true,
          detail: text.slice(0, 400),
        },
      }
    }

    const data = payload as {
      entries?: unknown
      share_tokens?: unknown
      total_num_entries?: unknown
      has_more_entries?: unknown
      next_request_voucher?: unknown
      folder?: { filename?: unknown }
      takedown_request_type?: unknown
    }

    if (data.takedown_request_type) {
      return {
        ok: false,
        error: {
          code: 'LINK_TAKEDOWN',
          message: 'Dropbox has disabled this shared link.',
          retryable: false,
        },
      }
    }

    if (!Array.isArray(data.entries)) {
      return {
        ok: false,
        error: {
          code: 'PROTOCOL_CHANGED',
          message:
            'Dropbox returned folder data in a shape this extension does not recognise. Its internal endpoints have probably changed.',
          retryable: false,
          fatal: true,
          detail: text.slice(0, 400),
        },
      }
    }

    const rawEntries = data.entries as Array<Record<string, unknown>>
    const tokens = Array.isArray(data.share_tokens)
      ? (data.share_tokens as Array<Record<string, unknown>>)
      : null

    // share_tokens is positionally parallel to entries. Guard that rather than trusting it.
    if (tokens && tokens.length !== rawEntries.length) {
      return {
        ok: false,
        error: {
          code: 'PROTOCOL_CHANGED',
          message:
            'Dropbox returned mismatched folder data. Its internal endpoints have probably changed.',
          retryable: false,
          fatal: true,
        },
      }
    }

    // Project each entry down before returning: the untouched `preview` payloads are megabytes
    // of transcode and thumbnail data that would be serialized, copied and parsed for nothing.
    const entries: StrippedEntry[] = rawEntries.map((entry, index) => {
      const token = tokens ? tokens[index] : null
      return {
        filename: typeof entry.filename === 'string' ? entry.filename : '',
        isDir: entry.is_dir === true,
        bytes: typeof entry.bytes === 'number' ? entry.bytes : 0,
        href: typeof entry.href === 'string' ? entry.href : '',
        secureHash:
          token && typeof token.secureHash === 'string' ? token.secureHash : null,
        subPath: token && typeof token.subPath === 'string' ? token.subPath : null,
      }
    })

    return {
      ok: true,
      value: {
        entries,
        totalNumEntries:
          typeof data.total_num_entries === 'number' ? data.total_num_entries : null,
        hasMore: data.has_more_entries === true,
        voucher:
          typeof data.next_request_voucher === 'string' ? data.next_request_voucher : null,
        folderName:
          data.folder && typeof data.folder.filename === 'string' ? data.folder.filename : null,
      },
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'NETWORK',
        message: 'Could not reach Dropbox from the folder tab.',
        retryable: true,
        detail: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * The fallback download path: ask Dropbox for a signed URL the way its own UI does.
 *
 * `headerMode` escalates only when a call is refused — 0 sends the minimum, 1 adds the account
 * id, 2 adds the namespace. Evidence says 0 is enough, but being wrong should cost one retry
 * rather than a redesign.
 */
export async function dropboxDownloadUrlInjected(
  linkUrl: string,
  rlkey: string,
  headerMode: number,
): Promise<InjectedResult<{ downloadUrl: string }>> {
  const readCookie = (name: string): string | null => {
    for (const part of document.cookie.split('; ')) {
      if (!part) continue
      const split = part.indexOf('=')
      if (split < 0) continue
      if (part.slice(0, split) !== name) continue
      try {
        return decodeURIComponent(part.slice(split + 1))
      } catch {
        return part.slice(split + 1)
      }
    }
    return null
  }

  try {
    const token = readCookie('__Host-js_csrf') ?? readCookie('t')
    if (!token) {
      return {
        ok: false,
        error: {
          code: 'NO_CSRF',
          message:
            'Could not read the Dropbox session from this page. Reload the Dropbox folder tab and try again.',
          retryable: false,
        },
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    }

    if (headerMode > 0) {
      // The `jar` cookie is base64 of a JSON array; a multi-account session has more than one
      // element, so fall back to the anonymous sentinel rather than guessing which is current.
      let uid = '-1'
      let namespace: string | null = null
      const jar = readCookie('jar')
      if (jar) {
        try {
          const parsed = JSON.parse(atob(jar)) as Array<{ uid?: unknown; ns?: unknown }>
          if (Array.isArray(parsed) && parsed.length === 1) {
            if (typeof parsed[0].uid === 'number') uid = String(parsed[0].uid)
            if (typeof parsed[0].ns === 'number') namespace = String(parsed[0].ns)
          }
        } catch {
          // Unreadable jar is not fatal; the sentinel covers the anonymous path.
        }
      }
      headers['x-dropbox-uid'] = uid
      if (headerMode > 1 && namespace) headers['x-dropbox-path-root'] = namespace
    }

    const response = await fetch(
      'https://www.dropbox.com/2/sharing_receiving/generate_download_url',
      {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          link_url: linkUrl,
          optional_rlkey: rlkey,
          optional_grant_book: '',
        }),
      },
    )

    const text = await response.text()

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('Retry-After')
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN
      return {
        ok: false,
        error: {
          code: response.status === 509 ? 'BANDWIDTH_BLOCKED' : 'DOWNLOAD_URL_REJECTED',
          message:
            response.status === 509
              ? 'Dropbox has temporarily blocked this link for too much traffic. This usually clears after a few hours.'
              : 'Dropbox would not hand out a download link for this file.',
          retryable: true,
          status: response.status,
          retryAfterMs: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : undefined,
          detail: text.slice(0, 400),
        },
      }
    }

    let downloadUrl: unknown
    try {
      downloadUrl = (JSON.parse(text) as { download_url?: unknown }).download_url
    } catch {
      downloadUrl = undefined
    }

    if (typeof downloadUrl !== 'string' || !downloadUrl) {
      return {
        ok: false,
        error: {
          code: 'PROTOCOL_CHANGED',
          message:
            'Dropbox did not return a download link in the expected shape. Its internal endpoints have probably changed.',
          retryable: false,
          fatal: true,
          detail: text.slice(0, 400),
        },
      }
    }

    return { ok: true, value: { downloadUrl } }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'NETWORK',
        message: 'Could not reach Dropbox from the folder tab.',
        retryable: true,
        detail: error instanceof Error ? error.message : String(error),
      },
    }
  }
}
