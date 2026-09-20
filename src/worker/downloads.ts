export async function startDownload(url: string, filename: string): Promise<number> {
  return chrome.downloads.download({
    url,
    filename,
    // The destination is assumed empty, so 'uniquify' could only do damage: a retry would land
    // beside the stale attempt as "name (1).ext" instead of replacing it.
    conflictAction: 'overwrite',
    saveAs: false,
  })
}

export async function findDownload(id: number): Promise<chrome.downloads.DownloadItem | null> {
  const results = await chrome.downloads.search({ id })
  return results[0] ?? null
}

export async function cancelDownload(id: number): Promise<void> {
  try {
    await chrome.downloads.cancel(id)
  } catch {
    // Already gone; nothing to cancel.
  }
}

export async function eraseDownload(id: number): Promise<void> {
  try {
    await chrome.downloads.erase({ id })
  } catch {
    // Keeping Chrome's list tidy is a courtesy, never a reason to fail a run.
  }
}

/** Returns whether the change took, so startup can restore a UI we hid before dying. */
export async function setDownloadUiHidden(hidden: boolean): Promise<boolean> {
  try {
    await chrome.downloads.setUiOptions({ enabled: !hidden })
    return hidden
  } catch {
    // Another extension holds the same lock, or the API is unavailable. Never fatal.
    return false
  }
}

/**
 * Finds a download this worker started but died before recording.
 *
 * `startedAt` is written before `downloads.download` is called precisely so this window is
 * searchable; without it an orphan would be indistinguishable from a file never started.
 */
export async function findOrphan(
  destinationPath: string,
  startedAt: number,
): Promise<chrome.downloads.DownloadItem | null> {
  const results = await chrome.downloads.search({
    startedAfter: new Date(startedAt - 5_000).toISOString(),
    orderBy: ['-startTime'],
    limit: 25,
  })

  // Matched on the destination-qualified path, so a run into one folder cannot adopt a download
  // of the same relative path from a different run.
  const suffix = destinationPath.split('/').filter(Boolean).join('/')
  for (const item of results) {
    if (item.filename.split('\\').join('/').endsWith(suffix)) return item
  }
  return null
}
