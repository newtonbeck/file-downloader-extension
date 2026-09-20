import { formatBytes } from '../shared/paths'
import type { TreeNode } from '../types/queue'

function Row({ node }: { node: TreeNode }) {
  if (node.kind === 'file') {
    return (
      <li className="flex items-baseline justify-between gap-2 py-0.5 pl-4">
        <span className="truncate text-gray-700">{node.name}</span>
        <span className="shrink-0 text-xs text-gray-400">{formatBytes(node.bytes)}</span>
      </li>
    )
  }

  return (
    <li className="py-0.5">
      <details open>
        <summary className="flex cursor-pointer items-baseline justify-between gap-2">
          <span className="truncate font-medium text-gray-900">{node.name}</span>
          <span className="shrink-0 text-xs text-gray-400">
            {node.fileCount} · {formatBytes(node.bytes)}
          </span>
        </summary>
        <ul className="border-l border-gray-100 pl-2">
          {node.children.map((child, index) => (
            <Row key={`${child.kind}:${child.name}:${index}`} node={child} />
          ))}
        </ul>
      </details>
    </li>
  )
}

export function TreePreview({ nodes }: { nodes: TreeNode[] }) {
  if (nodes.length === 0) {
    return <p className="text-sm text-gray-500">This folder is empty.</p>
  }

  return (
    <ul className="text-sm">
      {nodes.map((node, index) => (
        <Row key={`${node.kind}:${node.name}:${index}`} node={node} />
      ))}
    </ul>
  )
}
