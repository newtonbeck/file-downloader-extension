import { useCallback, useEffect, useState } from 'react'
import { Button } from './button'
import { DestinationInput } from './panel/destination-input'
import { ProgressList } from './panel/progress-list'
import { RunControls } from './panel/run-controls'
import { ScanPanel } from './panel/scan-panel'
import { TreePreview } from './panel/tree-preview'
import { useActiveTab, useRunState } from './panel/use-run-state'
import { formatBytes } from './shared/paths'
import { sendToWorker } from './shared/messaging'
import { MessageType } from './types/messages'
import type { TreeResponse } from './types/messages'
import { ItemStatus, RunStatus } from './types/queue'
import type { RunStatus as RunStatusValue, TreeNode } from './types/queue'

const IN_FLIGHT: RunStatusValue[] = [
  RunStatus.Running,
  RunStatus.Paused,
  RunStatus.Blocked,
  RunStatus.Done,
]

function App() {
  const { state, error, refresh } = useRunState()
  const tab = useActiveTab()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [destination, setDestination] = useState('')
  const [tree, setTree] = useState<TreeNode[] | null>(null)

  const run = state?.run ?? null
  const items = state?.items ?? []
  const status = run?.status ?? null

  // The tree is fetched once when the scan lands, never on the state poll: it is far too big to
  // ship every second.
  useEffect(() => {
    if (status !== RunStatus.Scanned) return
    let cancelled = false
    void sendToWorker<TreeResponse>({ type: MessageType.GetTree })
      .then((response) => {
        if (!cancelled) setTree(response.tree)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [status])

  useEffect(() => {
    const suggested = run?.destination
    if (suggested) setDestination((current) => current || suggested)
  }, [run?.destination])

  // A blocked run is waiting for a Dropbox tab. The worker finds one on its own via its watchdog
  // and tab events, but the panel already knows about this one — telling it is immediate.
  useEffect(() => {
    if (status !== RunStatus.Blocked || tab.id === null) return
    if (!tab.url.startsWith('https://www.dropbox.com/')) return
    void sendToWorker({ type: MessageType.SetTab, tabId: tab.id }).catch(() => undefined)
  }, [status, tab.id, tab.url])

  const act = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true)
      setActionError(null)
      try {
        await work()
        await refresh()
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  const reset = useCallback(async () => {
    await sendToWorker({ type: MessageType.CancelRun })
    setTree(null)
    setDestination('')
  }, [])

  const banner = actionError ?? error
  const showScan = !run || status === RunStatus.ScanFailed
  const hasFailures = items.some((item) => item.status === ItemStatus.Failed)

  return (
    <div className="flex h-full w-full flex-col gap-4 p-4">
      <h1 className="text-center text-lg font-semibold">File Downloader</h1>

      {banner && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-900">{banner}</p>}
      {run?.message && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{run.message}</p>
      )}

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
        {showScan && (
          <ScanPanel
            tab={tab}
            busy={busy}
            onScan={(tabId) => void act(() => sendToWorker({ type: MessageType.Scan, tabId }))}
          />
        )}

        {status === RunStatus.Scanning && (
          <>
            <p className="text-sm text-gray-600">
              Scanning&hellip; {run?.scanProgress?.folders ?? 0} folders,{' '}
              {run?.scanProgress?.files ?? 0} files so far.
            </p>
            {/* An escape hatch: a scan lives in worker memory, so if the worker dies mid-walk
                there is nothing left to finish it and no other control on screen. */}
            <Button type="secondary" onClick={() => void act(reset)} disabled={busy}>
              Cancel scan
            </Button>
          </>
        )}

        {status === RunStatus.Scanned && run && (
          <>
            <p className="text-sm text-gray-600">
              {run.totals.files} files · {formatBytes(run.totals.bytes)}
            </p>
            <DestinationInput value={destination} onChange={setDestination} />
            <Button
              onClick={() =>
                void act(() => sendToWorker({ type: MessageType.Start, destination }))
              }
              disabled={busy || run.totals.files === 0}
            >
              Start download
            </Button>
            <Button type="secondary" onClick={() => void act(reset)} disabled={busy}>
              Discard
            </Button>
            {tree && <TreePreview nodes={tree} />}
          </>
        )}

        {run && status !== null && IN_FLIGHT.includes(status) && (
          <>
            <ProgressList run={run} items={items} active={state?.active ?? null} />
            <RunControls
              run={run}
              busy={busy}
              hasFailures={hasFailures}
              onPause={() => void act(() => sendToWorker({ type: MessageType.Pause }))}
              onResume={() => void act(() => sendToWorker({ type: MessageType.Resume }))}
              onRetryFailed={() => void act(() => sendToWorker({ type: MessageType.RetryFailed }))}
              onCancel={() => void act(reset)}
            />
          </>
        )}
      </div>
    </div>
  )
}

export default App
