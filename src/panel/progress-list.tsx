import { formatBytes } from '../shared/paths'
import { ItemStatus } from '../types/queue'
import type { ActiveProgress, QueueItem, Run } from '../types/queue'

const STATUS_LABEL: Record<ItemStatus, string> = {
  pending: 'Waiting',
  resolving: 'Preparing',
  downloading: 'Downloading',
  retry_wait: 'Retrying',
  complete: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
}

interface Props {
  run: Run
  items: QueueItem[]
  active: ActiveProgress | null
}

export function ProgressList({ run, items, active }: Props) {
  const activeItem = items.find((item) => item.id === run.activeItemId) ?? null
  const failed = items.filter((item) => item.status === ItemStatus.Failed)
  const overall =
    run.totals.files > 0 ? Math.round((100 * run.completed.files) / run.totals.files) : 0

  const activePercent =
    active && active.totalBytes > 0
      ? Math.min(100, Math.round((100 * active.bytesReceived) / active.totalBytes))
      : 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium text-gray-900">
            {run.completed.files} of {run.totals.files} files
          </span>
          <span className="text-gray-500">
            {formatBytes(run.completed.bytes)} of {formatBytes(run.totals.bytes)}
          </span>
        </div>
        <Bar percent={overall} />
      </div>

      {activeItem && (
        <div className="flex flex-col gap-1 rounded-lg bg-gray-50 p-3">
          <span className="truncate text-sm font-medium text-gray-900">{activeItem.name}</span>
          <Bar percent={activePercent} />
          <span className="text-xs text-gray-500">
            {active
              ? `${formatBytes(active.bytesReceived)} of ${formatBytes(active.totalBytes)} · ${activePercent}%`
              : STATUS_LABEL[activeItem.status]}
          </span>
        </div>
      )}

      {failed.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg bg-red-50 p-3">
          <span className="text-sm font-medium text-red-900">
            {failed.length} file{failed.length === 1 ? '' : 's'} failed
          </span>
          <ul className="flex flex-col gap-1">
            {failed.slice(0, 10).map((item) => (
              <li key={item.id} className="text-xs">
                <span className="block truncate text-red-900">{item.name}</span>
                {item.error && <span className="block truncate text-red-500">{item.error}</span>}
              </li>
            ))}
          </ul>
          {failed.length > 10 && (
            <span className="text-xs text-red-500">and {failed.length - 10} more</span>
          )}
        </div>
      )}

      {/* Collapsed by default: 190 rows re-rendering once a second is a waste of a paint. */}
      <details>
        <summary className="cursor-pointer text-sm text-gray-500">All files</summary>
        <ul className="mt-2 flex flex-col gap-0.5">
          {items.map((item) => (
            <li key={item.id} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-gray-700">{item.relPath}</span>
              <span className="shrink-0 text-gray-400">{STATUS_LABEL[item.status]}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}

function Bar({ percent }: { percent: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
      <div className="h-full bg-gray-900 transition-all" style={{ width: `${percent}%` }} />
    </div>
  )
}
