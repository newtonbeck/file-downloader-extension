import { sanitizeSegment } from '../shared/paths'

interface Props {
  value: string
  onChange: (value: string) => void
}

export function DestinationInput({ value, onChange }: Props) {
  const resolved = sanitizeSegment(value) || 'download'

  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-gray-900">Save to</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Folder name"
        className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
      />
      <span className="text-xs break-all text-gray-500">
        Downloads/{resolved}/
      </span>
      {/* Chrome refuses absolute paths, so everything lands under the browser's download folder. */}
      <span className="text-xs text-gray-400">
        To put these somewhere else, change Chrome&rsquo;s download location in Settings first.
      </span>
    </label>
  )
}
