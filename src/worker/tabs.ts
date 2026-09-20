const PROVIDER_ORIGIN = 'https://www.dropbox.com/'
const PROVIDER_PATTERN = 'https://www.dropbox.com/*'

export function isProviderUrl(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith(PROVIDER_ORIGIN)
}

/**
 * A usable provider tab, or null.
 *
 * The remembered id is checked against its current URL rather than trusted: Chrome recycles tab
 * ids across restarts, so a stale id can name somebody else's tab.
 */
export async function ensureProviderTab(preferred: number | null): Promise<number | null> {
  if (preferred !== null) {
    try {
      const tab = await chrome.tabs.get(preferred)
      if (isProviderUrl(tab.url) && tab.id !== undefined) return tab.id
    } catch {
      // Closed since we last saw it.
    }
  }

  const tabs = await chrome.tabs.query({ url: PROVIDER_PATTERN })
  for (const tab of tabs) {
    if (tab.id !== undefined) return tab.id
  }
  return null
}
