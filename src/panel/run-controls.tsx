import { Button } from '../button'
import { RunStatus } from '../types/queue'
import type { Run } from '../types/queue'

interface Props {
  run: Run
  busy: boolean
  hasFailures: boolean
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onRetryFailed: () => void
}

export function RunControls({
  run,
  busy,
  hasFailures,
  onPause,
  onResume,
  onCancel,
  onRetryFailed,
}: Props) {
  const running = run.status === RunStatus.Running
  const stopped = run.status === RunStatus.Paused || run.status === RunStatus.Blocked
  const done = run.status === RunStatus.Done

  return (
    <div className="flex flex-col gap-2">
      {running && (
        <Button type="secondary" onClick={onPause} disabled={busy}>
          Pause
        </Button>
      )}
      {stopped && (
        <Button onClick={onResume} disabled={busy}>
          Resume
        </Button>
      )}
      {done && hasFailures && (
        <Button onClick={onRetryFailed} disabled={busy}>
          Retry failed
        </Button>
      )}
      <Button type="secondary" onClick={onCancel} disabled={busy}>
        {done ? 'Scan another folder' : 'Cancel'}
      </Button>
    </div>
  )
}
