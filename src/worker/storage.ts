import type { QueueItem, Run, TreeNode } from '../types/queue'

const KEY_RUN = 'run'
const KEY_ITEMS = 'items'
const KEY_TREE = 'tree'

export async function loadRun(): Promise<Run | null> {
  const stored = await chrome.storage.local.get(KEY_RUN)
  return (stored[KEY_RUN] as Run | undefined) ?? null
}

export async function saveRun(run: Run): Promise<void> {
  await chrome.storage.local.set({ [KEY_RUN]: run })
}

export async function loadItems(): Promise<QueueItem[]> {
  const stored = await chrome.storage.local.get(KEY_ITEMS)
  return (stored[KEY_ITEMS] as QueueItem[] | undefined) ?? []
}

export async function saveItems(items: QueueItem[]): Promise<void> {
  await chrome.storage.local.set({ [KEY_ITEMS]: items })
}

/**
 * Both keys in one write.
 *
 * Two separate `set` calls can be interrupted by the worker dying between them, leaving a run
 * that has moved on next to items that have not — which strands a file as `downloading` forever
 * while the run happily reports itself finished.
 */
export async function saveState(run: Run, items: QueueItem[]): Promise<void> {
  await chrome.storage.local.set({ [KEY_RUN]: run, [KEY_ITEMS]: items })
}

export async function loadTree(): Promise<TreeNode[] | null> {
  const stored = await chrome.storage.local.get(KEY_TREE)
  return (stored[KEY_TREE] as TreeNode[] | undefined) ?? null
}

export async function saveTree(tree: TreeNode[]): Promise<void> {
  await chrome.storage.local.set({ [KEY_TREE]: tree })
}

export async function clearAll(): Promise<void> {
  await chrome.storage.local.remove([KEY_RUN, KEY_ITEMS, KEY_TREE])
}

/** Drops the previous scan's results without disturbing the run record being written. */
export async function clearScanResults(): Promise<void> {
  await chrome.storage.local.remove([KEY_ITEMS, KEY_TREE])
}
