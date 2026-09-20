import { dropboxProvider } from '../providers/dropbox'
import { asProviderError } from '../providers/types'
import type { EntryRef, FileRef, FolderRef } from '../providers/types'
import { joinRelPath, sanitizeSegment, uniquifyRelPath } from '../shared/paths'
import { ItemStatus, RunStatus } from '../types/queue'
import type { ActiveProgress, QueueItem, Run, TreeNode } from '../types/queue'
import {
  cancelDownload,
  eraseDownload,
  findDownload,
  findOrphan,
  setDownloadUiHidden,
  startDownload,
} from './downloads'
import {
  backoffMs,
  classifyInterrupt,
  Disposition,
  FREE_RETRY_DELAY_MS,
  MAX_ATTEMPTS,
  MAX_REFRESHES,
  REFRESH_DELAY_MS,
} from './retry'
import * as storage from './storage'
import { ensureProviderTab } from './tabs'

const provider = dropboxProvider

export const WATCHDOG_ALARM = 'queue-watchdog'
export const RETRY_ALARM = 'queue-retry'

/** A download sitting at zero bytes this long is almost always a save dialog nobody can see. */
const STALLED_AT_ZERO_MS = 120_000

const SAVE_PROMPT_HINT =
  'Nothing has downloaded yet. If Chrome is set to “Ask where to save each file”, turn that off in Settings → Downloads — it blocks unattended runs.'

// Only one service worker instance exists per profile, so an in-memory chain is enough to keep
// operations from interleaving. Nothing about the queue's correctness depends on it surviving.
let chain: Promise<unknown> = Promise.resolve()

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work)
  chain = next.catch(() => undefined)
  return next
}

async function persist(run: Run, items: QueueItem[]): Promise<void> {
  await storage.saveState(run, items)
}

/**
 * Enter a stopped state, restoring anything global we had taken.
 *
 * A blocked run keeps its watchdog on purpose: that alarm is what lets it notice a Dropbox tab
 * reappearing without an `onUpdated` event, which is the only way an unattended run un-sticks
 * itself when the tab was already open.
 */
async function haltRun(run: Run, status: RunStatus, message: string | null): Promise<void> {
  run.status = status
  run.message = message
  if (run.uiHidden) {
    await setDownloadUiHidden(false)
    run.uiHidden = false
  }
  if (status !== RunStatus.Blocked) await chrome.alarms.clear(WATCHDOG_ALARM)
}

function toFileRef(item: QueueItem): FileRef {
  return { kind: 'file', name: item.name, sizeBytes: item.sizeBytes, raw: item.fileRef }
}

function isEligible(item: QueueItem, now: number): boolean {
  if (item.status === ItemStatus.Pending) return true
  return item.status === ItemStatus.RetryWait && item.nextAttemptAt !== null && item.nextAttemptAt <= now
}

// ─── The queue driver ─────────────────────────────────────────────────────────

export function tick(): Promise<void> {
  return serialize(runTick)
}

async function runTick(): Promise<void> {
  const run = await storage.loadRun()
  if (!run) return

  if (run.status === RunStatus.Blocked) {
    const recovered = await ensureProviderTab(null)
    if (recovered === null) return
    run.tabId = recovered
    run.status = RunStatus.Running
    run.message = null
    run.uiHidden = await setDownloadUiHidden(true)
    await storage.saveRun(run)
  }

  if (run.status !== RunStatus.Running) return

  const items = await storage.loadItems()

  // Repair anything a worker death stranded mid-flight. Without this an item left `downloading`
  // or `resolving` while it is not the active item is never eligible again, never retried, and
  // never reported — and the run still declares itself finished.
  let repaired = false
  for (const item of items) {
    if (item.id === run.activeItemId) continue
    if (item.status !== ItemStatus.Downloading && item.status !== ItemStatus.Resolving) continue
    item.status = ItemStatus.Pending
    item.downloadId = null
    item.startedAt = null
    repaired = true
  }
  if (repaired) await storage.saveItems(items)

  if (run.activeItemId !== null) {
    const active = items.find((item) => item.id === run.activeItemId) ?? null
    if (!active) {
      run.activeItemId = null
    } else {
      const outcome = await settleActive(run, active)
      if (outcome === 'in_progress') {
        await persist(run, items)
        return
      }
      if (outcome === 'aborted') {
        await persist(run, items)
        return
      }
    }
  }

  const now = Date.now()
  const next = items.find((item) => isEligible(item, now)) ?? null

  if (!next) {
    let soonest: number | null = null
    for (const item of items) {
      if (item.status !== ItemStatus.RetryWait) continue
      const at = item.nextAttemptAt
      if (at === null) continue
      if (soonest === null || at < soonest) soonest = at
    }

    if (soonest !== null) {
      await chrome.alarms.create(RETRY_ALARM, { when: soonest })
      await persist(run, items)
      return
    }

    await finishRun(run, items)
    return
  }

  // The tab is only consulted when this particular resolution needs one, so an in-flight run
  // does not stall the moment the user closes Dropbox.
  let tabId: number | null = null
  if (provider.needsTabForDownload || next.useFallbackPath) {
    tabId = await ensureProviderTab(run.tabId)
    if (tabId === null) {
      next.status = ItemStatus.Pending
      await haltRun(run, RunStatus.Blocked, 'Open the Dropbox shared folder in a tab to continue.')
      run.tabId = null
      await persist(run, items)
      return
    }
    run.tabId = tabId
  }

  // Take the lock durably before doing anything that could outlive this worker.
  next.status = ItemStatus.Resolving
  next.nextAttemptAt = null
  // A timestamp left over from a previous attempt would widen the orphan search window.
  next.startedAt = null
  run.activeItemId = next.id
  await persist(run, items)

  let url: string
  try {
    url = await provider.resolveDownloadUrl({ tabId }, toFileRef(next), next.useFallbackPath)
  } catch (error) {
    await handleResolveFailure(run, items, next, error)
    return
  }

  // Intent is recorded BEFORE the call, so a worker that dies during it leaves a searchable
  // trace rather than an untraceable orphan.
  next.startedAt = Date.now()
  next.status = ItemStatus.Downloading
  await persist(run, items)

  try {
    next.downloadId = await startDownload(url, `${run.destination}/${next.relPath}`)
  } catch (error) {
    await handleResolveFailure(run, items, next, error)
    return
  }

  await persist(run, items)
}

type SettleOutcome = 'in_progress' | 'settled' | 'aborted'

async function settleActive(run: Run, item: QueueItem): Promise<SettleOutcome> {
  let downloadId = item.downloadId
  if (downloadId === null) {
    const orphan =
      item.startedAt !== null
        ? await findOrphan(`${run.destination}/${item.relPath}`, item.startedAt)
        : null
    if (!orphan) {
      item.status = ItemStatus.Pending
      run.activeItemId = null
      return 'settled'
    }
    downloadId = orphan.id
    item.downloadId = downloadId
  }

  const download = await findDownload(downloadId)
  if (!download) {
    // Chrome erased the record out from under us; not the file's fault.
    applyDisposition(run, item, Disposition.FreeRetry, 'UNKNOWN_ERASED')
    return 'settled'
  }

  if (download.state === 'in_progress') {
    if (
      download.bytesReceived === 0 &&
      item.startedAt !== null &&
      Date.now() - item.startedAt > STALLED_AT_ZERO_MS
    ) {
      // A hint rather than a pause: a false positive must not halt a legitimate slow transfer.
      run.message = SAVE_PROMPT_HINT
    }
    return 'in_progress'
  }

  if (download.state === 'complete') {
    // "complete" only means the transfer finished, not that it transferred the right thing.
    if (item.sizeBytes > 0 && download.fileSize > 0 && download.fileSize !== item.sizeBytes) {
      item.error = `Expected ${item.sizeBytes} bytes, received ${download.fileSize}`
      await eraseDownload(download.id)
      applyDisposition(run, item, Disposition.SizeMismatch, item.error)
      return 'settled'
    }

    item.status = ItemStatus.Complete
    item.error = null
    item.downloadId = download.id
    run.completed.files += 1
    run.completed.bytes += item.sizeBytes
    run.activeItemId = null
    if (run.message === SAVE_PROMPT_HINT) run.message = null
    return 'settled'
  }

  const disposition = classifyInterrupt(download.error)
  await eraseDownload(download.id)
  applyDisposition(run, item, disposition, download.error ?? 'interrupted')

  if (disposition === Disposition.OutOfSpace) {
    // Grinding through the rest of the queue to fail identically is worse than stopping.
    await haltRun(run, RunStatus.Paused, 'Out of disk space. Free some space, then resume.')
    return 'aborted'
  }
  return 'settled'
}

function fail(run: Run, item: QueueItem): void {
  item.status = ItemStatus.Failed
  run.failedCount += 1
}

function scheduleRetry(item: QueueItem, delayMs: number): void {
  item.status = ItemStatus.RetryWait
  item.nextAttemptAt = Date.now() + delayMs
}

function applyDisposition(
  run: Run,
  item: QueueItem,
  disposition: Disposition,
  reason: string,
): void {
  run.activeItemId = null
  item.downloadId = null
  item.error = reason

  switch (disposition) {
    case Disposition.UserCanceled:
      if (item.expectCancel) {
        item.expectCancel = false
        item.status = ItemStatus.Pending
        item.error = null
      } else {
        // Cancelled from Chrome's own download UI. Respect it: never retry, never count failed.
        item.status = ItemStatus.Skipped
      }
      return

    case Disposition.FreeRetry:
      scheduleRetry(item, FREE_RETRY_DELAY_MS)
      return

    case Disposition.Refresh:
      if (item.refreshes >= MAX_REFRESHES) {
        fail(run, item)
        return
      }
      item.refreshes += 1
      scheduleRetry(item, REFRESH_DELAY_MS)
      return

    case Disposition.SizeMismatch:
      item.attempts += 1
      // Twice wrong means the primary path is being handed something other than the file.
      if (item.attempts >= 2) item.useFallbackPath = true
      if (item.attempts >= MAX_ATTEMPTS) fail(run, item)
      else scheduleRetry(item, backoffMs(item.attempts))
      return

    case Disposition.Retry:
      item.attempts += 1
      if (item.attempts >= MAX_ATTEMPTS) fail(run, item)
      else scheduleRetry(item, backoffMs(item.attempts))
      return

    case Disposition.OutOfSpace:
    case Disposition.Terminal:
      fail(run, item)
      return
  }
}

async function handleResolveFailure(
  run: Run,
  items: QueueItem[],
  item: QueueItem,
  error: unknown,
): Promise<void> {
  const info = asProviderError(error)
  run.activeItemId = null
  item.downloadId = null
  item.error = info?.message ?? (error instanceof Error ? error.message : String(error))

  if (info?.fatal) {
    // What we hold can no longer be trusted — stop loudly rather than finish "successfully".
    item.status = ItemStatus.Pending
    await haltRun(run, RunStatus.Paused, info.message)
    await persist(run, items)
    return
  }

  if (info?.needsTab) {
    item.status = ItemStatus.Pending
    await haltRun(run, RunStatus.Blocked, info.message)
    run.tabId = null
    await persist(run, items)
    return
  }

  // A bandwidth block clears in hours; burning retries against it only deepens it.
  if (info?.status === 509) {
    item.status = ItemStatus.Pending
    await haltRun(run, RunStatus.Paused, info.message)
    await persist(run, items)
    return
  }

  if (info && !info.retryable) {
    fail(run, item)
    await persist(run, items)
    return
  }

  item.attempts += 1
  if (item.attempts >= MAX_ATTEMPTS) fail(run, item)
  else scheduleRetry(item, info?.retryAfterMs ?? backoffMs(item.attempts))
  await persist(run, items)
}

async function finishRun(run: Run, items: QueueItem[]): Promise<void> {
  run.status = RunStatus.Done
  run.activeItemId = null
  run.message = run.failedCount > 0 ? `${run.failedCount} file(s) could not be downloaded.` : null
  await chrome.alarms.clear(WATCHDOG_ALARM)
  await chrome.alarms.clear(RETRY_ALARM)
  if (run.uiHidden) {
    await setDownloadUiHidden(false)
    run.uiHidden = false
  }
  await persist(run, items)
}

// ─── Scanning ─────────────────────────────────────────────────────────────────

interface CollectedFile {
  segments: string[]
  ref: FileRef
}

export async function scan(tabId: number): Promise<void> {
  // A second walk would race the first one's writes to the same three keys.
  const existing = await storage.loadRun()
  if (existing?.status === RunStatus.Scanning) throw new Error('Already scanning that folder.')
  if (existing?.status === RunStatus.Running) {
    throw new Error('Finish or cancel the current download before scanning another folder.')
  }

  const tab = await chrome.tabs.get(tabId)
  const match = provider.matchUrl(tab.url ?? '')
  if (!match.ok) throw new Error(match.reason)

  const run: Run = {
    id: crypto.randomUUID(),
    source: { url: tab.url ?? '', rootName: match.ref.name },
    destination: sanitizeSegment(match.ref.name),
    status: RunStatus.Scanning,
    tabId,
    activeItemId: null,
    totals: { files: 0, bytes: 0 },
    completed: { files: 0, bytes: 0 },
    failedCount: 0,
    message: null,
    scanProgress: { folders: 0, files: 0 },
    uiHidden: false,
    startedAt: Date.now(),
  }

  await storage.clearScanResults()
  await storage.saveRun(run)

  // Deliberately not awaited: a 190-file walk outlives the message channel. The panel follows
  // along through run.scanProgress.
  void walk(run, match.ref, tabId)
}

async function walk(run: Run, root: FolderRef, tabId: number): Promise<void> {
  const files: CollectedFile[] = []
  try {
    const tree = await walkFolder(run, root, tabId, [], files)

    run.status = RunStatus.Scanned
    run.scanProgress = null
    run.totals = {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.ref.sizeBytes, 0),
    }
    const taken = new Set<string>()
    await storage.saveTree(tree)
    await storage.saveItems(files.map((file, index) => toQueueItem(file, index, taken)))
    await storage.saveRun(run)
  } catch (error) {
    const info = asProviderError(error)
    // The user-facing message is deliberately generic; the specific cause only exists here, and
    // this replays undocumented endpoints, so it is worth having in the worker console.
    console.warn('[file-downloader] scan failed', info?.code ?? error, info?.detail ?? '')
    run.status = RunStatus.ScanFailed
    run.scanProgress = null
    run.message = info?.message ?? (error instanceof Error ? error.message : String(error))
    await storage.saveRun(run)
  }
}

async function walkFolder(
  run: Run,
  ref: FolderRef,
  tabId: number,
  prefix: string[],
  sink: CollectedFile[],
): Promise<TreeNode[]> {
  const entries: EntryRef[] = await provider.listFolder({ tabId }, ref)

  if (run.scanProgress) {
    run.scanProgress.folders += 1
    await storage.saveRun(run)
  }

  const nodes: TreeNode[] = []
  for (const entry of entries) {
    if (entry.kind === 'file') {
      sink.push({ segments: [...prefix, entry.name], ref: entry })
      nodes.push({ kind: 'file', name: entry.name, bytes: entry.sizeBytes })
      if (run.scanProgress) run.scanProgress.files += 1
      continue
    }

    const children = await walkFolder(run, entry, tabId, [...prefix, entry.name], sink)
    nodes.push({
      kind: 'folder',
      name: entry.name,
      children,
      bytes: totalBytes(children),
      fileCount: totalFiles(children),
    })
  }

  if (run.scanProgress) await storage.saveRun(run)
  return nodes
}

function totalBytes(nodes: TreeNode[]): number {
  return nodes.reduce((sum, node) => sum + node.bytes, 0)
}

function totalFiles(nodes: TreeNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.kind === 'file' ? 1 : node.fileCount), 0)
}

function toQueueItem(file: CollectedFile, index: number, taken: Set<string>): QueueItem {
  // Sanitizing is lossy, so two distinct files can collapse onto one path. Left alone, the
  // second would overwrite the first while the run still counted both as downloaded.
  const relPath = uniquifyRelPath(joinRelPath(file.segments), taken)
  return {
    id: `${index}:${relPath}`,
    relPath,
    name: file.ref.name,
    sizeBytes: file.ref.sizeBytes,
    fileRef: file.ref.raw,
    status: ItemStatus.Pending,
    downloadId: null,
    startedAt: null,
    attempts: 0,
    refreshes: 0,
    nextAttemptAt: null,
    expectCancel: false,
    useFallbackPath: false,
    error: null,
  }
}

// ─── Run control ──────────────────────────────────────────────────────────────

export function startRun(destination: string): Promise<Run> {
  return serialize(async () => {
    const run = await storage.loadRun()
    if (!run) throw new Error('Scan a Dropbox folder first.')

    const items = await storage.loadItems()
    if (items.length === 0) throw new Error('That folder has no files to download.')

    // Checked before sanitizing: sanitizeSegment('') returns '_', which is truthy, so an empty
    // box would otherwise become a folder literally named "_".
    const chosen = destination.trim() || run.source.rootName
    run.destination = sanitizeSegment(chosen)
    run.status = RunStatus.Running
    run.message = null
    run.activeItemId = null
    run.completed = { files: 0, bytes: 0 }
    run.failedCount = 0
    run.startedAt = Date.now()
    run.uiHidden = await setDownloadUiHidden(true)

    await storage.saveRun(run)
    await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 })
    void tick()
    return run
  })
}

export function pauseRun(): Promise<Run> {
  return serialize(async () => {
    const run = await storage.loadRun()
    if (!run) throw new Error('There is no run to pause.')
    const items = await storage.loadItems()

    const active = run.activeItemId ? items.find((item) => item.id === run.activeItemId) : undefined
    if (active && active.downloadId !== null) {
      // The pause is recorded — status included — before the cancel, so a worker death in the
      // middle cannot be read on the next wake as a Running run whose file the user cancelled,
      // which would silently restart the transfer we were trying to stop.
      active.expectCancel = true
      run.status = RunStatus.Paused
      await persist(run, items)
      await cancelDownload(active.downloadId)
      await eraseDownload(active.downloadId)
      active.expectCancel = false
      active.downloadId = null
      active.status = ItemStatus.Pending
    } else if (active) {
      active.status = ItemStatus.Pending
    }

    run.activeItemId = null
    await haltRun(run, RunStatus.Paused, null)
    await chrome.alarms.clear(RETRY_ALARM)

    await persist(run, items)
    return run
  })
}

export function resumeRun(): Promise<Run> {
  return serialize(async () => {
    const run = await storage.loadRun()
    if (!run) throw new Error('There is no run to resume.')

    run.status = RunStatus.Running
    run.message = null
    run.uiHidden = await setDownloadUiHidden(true)
    await storage.saveRun(run)
    await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 })
    void tick()
    return run
  })
}

export function cancelRun(): Promise<void> {
  return serialize(async () => {
    const run = await storage.loadRun()
    const items = await storage.loadItems()

    const active = run?.activeItemId ? items.find((item) => item.id === run.activeItemId) : undefined
    if (active && active.downloadId !== null) {
      await cancelDownload(active.downloadId)
      await eraseDownload(active.downloadId)
    }

    await chrome.alarms.clear(WATCHDOG_ALARM)
    await chrome.alarms.clear(RETRY_ALARM)
    if (run?.uiHidden) await setDownloadUiHidden(false)
    await storage.clearAll()
  })
}

export function retryFailed(): Promise<Run> {
  return serialize(async () => {
    const run = await storage.loadRun()
    if (!run) throw new Error('There is no run to retry.')
    const items = await storage.loadItems()

    for (const item of items) {
      if (item.status !== ItemStatus.Failed) continue
      item.status = ItemStatus.Pending
      item.attempts = 0
      item.refreshes = 0
      item.nextAttemptAt = null
      item.error = null
    }

    run.failedCount = 0
    run.status = RunStatus.Running
    run.message = null
    run.uiHidden = await setDownloadUiHidden(true)
    await persist(run, items)
    await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 })
    void tick()
    return run
  })
}

/** The panel reporting the active tab, which can un-block a run when onUpdated was missed. */
export function adoptTab(tabId: number): Promise<Run | null> {
  return serialize(async () => {
    const run = await storage.loadRun()
    if (!run) return null

    const resolved = await ensureProviderTab(tabId)
    if (resolved === null) return run

    run.tabId = resolved
    if (run.status === RunStatus.Blocked) {
      run.status = RunStatus.Running
      run.message = null
      await storage.saveRun(run)
      await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 })
      void tick()
      return run
    }

    await storage.saveRun(run)
    return run
  })
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getState(): Promise<{
  run: Run | null
  items: QueueItem[]
  active: ActiveProgress | null
}> {
  const run = await storage.loadRun()
  const items = run ? await storage.loadItems() : []

  let active: ActiveProgress | null = null
  if (run?.activeItemId) {
    const item = items.find((entry) => entry.id === run.activeItemId)
    if (item?.downloadId !== undefined && item?.downloadId !== null) {
      // Live bytes are read here and never persisted — onChanged does not report progress, and
      // polling that wrote to storage would rewrite the queue once a second for nothing.
      const download = await findDownload(item.downloadId)
      if (download) {
        active = {
          downloadId: download.id,
          bytesReceived: download.bytesReceived,
          totalBytes: download.totalBytes || item.sizeBytes,
          estimatedEndTime: download.estimatedEndTime ?? null,
        }
      }
    }
  }

  return { run, items, active }
}

export async function getTree(): Promise<{ tree: TreeNode[] | null; rootName: string | null }> {
  const [tree, run] = await Promise.all([storage.loadTree(), storage.loadRun()])
  return { tree, rootName: run?.source.rootName ?? null }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/** Chrome restarts cancel in-flight downloads and recycle tab ids; assume nothing survived. */
export async function restoreAfterStartup(): Promise<void> {
  const run = await storage.loadRun()
  if (!run) return

  if (run.uiHidden) {
    run.uiHidden = await setDownloadUiHidden(true)
  }

  // The scan lived entirely in the memory of a worker that no longer exists, so a run caught
  // mid-scan can only be restarted. Left as `scanning` it would wedge the panel: scanning offers
  // no controls, and a new scan is refused because one is "already running".
  if (run.status === RunStatus.Scanning) {
    run.status = RunStatus.ScanFailed
    run.scanProgress = null
    run.message = 'The scan was interrupted. Scan the folder again.'
    await storage.saveRun(run)
    return
  }

  if (run.status === RunStatus.Running) {
    run.tabId = null
    await storage.saveRun(run)
    await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 })
    void tick()
    return
  }

  await storage.saveRun(run)
}

/** A provider tab appeared; a blocked run can pick up where it left off. */
export function onProviderTabReady(tabId: number): Promise<void> {
  return serialize(async () => {
    const run = await storage.loadRun()
    if (!run || run.status !== RunStatus.Blocked) return

    run.tabId = tabId
    run.status = RunStatus.Running
    run.message = null
    await storage.saveRun(run)
    await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 })
    void tick()
  })
}

/** The run's tab went away. The in-flight download does not need it — only the next resolve. */
export function onTabClosed(tabId: number): Promise<void> {
  return serialize(async () => {
    const run = await storage.loadRun()
    if (!run || run.tabId !== tabId) return
    run.tabId = null
    await storage.saveRun(run)
  })
}
