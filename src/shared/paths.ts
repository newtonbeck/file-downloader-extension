// Control characters are matched on purpose: they are legal in a Dropbox filename and illegal
// in a path on every OS this runs on.
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g
const RESERVED_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
// Well under the 255-byte OS limit, with headroom for a conflict counter.
const MAX_SEGMENT = 150

/**
 * One path component, made safe for `chrome.downloads.download`, which rejects the whole
 * download if any component starts or ends with a dot.
 *
 * Provider filenames arrive already decoded — never decodeURIComponent them again, or a literal
 * `%20` in a real filename silently becomes a space.
 */
export function sanitizeSegment(raw: string): string {
  const cleaned = raw.replace(ILLEGAL, '_').replace(/^[\s.]+/, '').replace(/[\s.]+$/, '')
  if (cleaned.length === 0) return '_'

  const dot = cleaned.lastIndexOf('.')
  const ext = dot > 0 ? cleaned.slice(dot) : ''
  let base = dot > 0 ? cleaned.slice(0, dot) : cleaned

  if (RESERVED_BASE.test(base)) base = `_${base}`

  const maxBase = Math.max(1, MAX_SEGMENT - ext.length)
  if (base.length > maxBase) {
    // Trim again: slicing can leave a trailing dot or space, which would make Chrome reject the
    // whole download rather than just this name.
    base = base.slice(0, maxBase).replace(/[\s.]+$/, '')
    if (base.length === 0) base = '_'
  }

  return `${base}${ext}`
}

/**
 * Sanitizing is lossy — `a: b.mp4` and `a_ b.mp4` collapse onto the same name — and downloads
 * use `conflictAction: 'overwrite'`, so two files landing on one path would silently leave one
 * of them missing from a run that still reports success.
 */
export function uniquifyRelPath(relPath: string, taken: Set<string>): string {
  if (!taken.has(relPath)) {
    taken.add(relPath)
    return relPath
  }

  const slash = relPath.lastIndexOf('/')
  const dir = slash >= 0 ? relPath.slice(0, slash + 1) : ''
  const name = slash >= 0 ? relPath.slice(slash + 1) : relPath
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${dir}${base} (${suffix})${ext}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

export function joinRelPath(segments: string[]): string {
  return segments.filter((s) => s.length > 0).map(sanitizeSegment).join('/')
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${UNITS[unit]}`
}
