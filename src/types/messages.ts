import type { ActiveProgress, QueueItem, Run, TreeNode } from './queue'

export const MessageType = {
  Scan: 'SCAN',
  GetState: 'GET_STATE',
  GetTree: 'GET_TREE',
  Start: 'START',
  Pause: 'PAUSE',
  Resume: 'RESUME',
  CancelRun: 'CANCEL_RUN',
  RetryFailed: 'RETRY_FAILED',
  SetTab: 'SET_TAB',
} as const
export type MessageType = (typeof MessageType)[keyof typeof MessageType]

export type Message =
  | { type: typeof MessageType.Scan; tabId: number }
  | { type: typeof MessageType.GetState }
  | { type: typeof MessageType.GetTree }
  | { type: typeof MessageType.Start; destination: string }
  | { type: typeof MessageType.Pause }
  | { type: typeof MessageType.Resume }
  | { type: typeof MessageType.CancelRun }
  | { type: typeof MessageType.RetryFailed }
  | { type: typeof MessageType.SetTab; tabId: number }

export interface StateResponse {
  run: Run | null
  items: QueueItem[]
  /** Live bytes for the in-flight download; only ever read, never persisted. */
  active: ActiveProgress | null
}

export interface TreeResponse {
  tree: TreeNode[] | null
  rootName: string | null
}

export type Response<T> = { success: true; data: T } | { success: false; error: string }
