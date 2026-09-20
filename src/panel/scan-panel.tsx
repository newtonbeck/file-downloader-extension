import { Button } from '../button'
import { EmptyState } from '../empty-state'
import { parseSharedFolderUrl } from '../providers/dropbox/parse'
import type { ActiveTab } from './use-run-state'

interface Props {
  tab: ActiveTab
  busy: boolean
  onScan: (tabId: number) => void
}

export function ScanPanel({ tab, busy, onScan }: Props) {
  // Chrome only exposes tab.url for hosts we hold permission for, so an empty url usually means
  // "some other site" rather than a genuinely blank tab.
  const match = tab.url ? parseSharedFolderUrl(tab.url) : null

  if (!match || !match.ok) {
    return (
      <div className="flex flex-col gap-3">
        <EmptyState />
        {match && <p className="text-center text-sm text-gray-500">{match.reason}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 rounded-lg bg-gray-50 p-3">
        <span className="text-sm font-medium text-gray-900">{match.ref.name}</span>
        <span className="truncate text-xs text-gray-500">{tab.url}</span>
      </div>
      <Button onClick={() => tab.id !== null && onScan(tab.id)} disabled={busy || tab.id === null}>
        {busy ? 'Scanning…' : 'Scan this folder'}
      </Button>
    </div>
  )
}
