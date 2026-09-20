import { useCallback, useEffect, useRef, useState } from 'react'
import { sendToWorker } from '../shared/messaging'
import { MessageType } from '../types/messages'
import type { StateResponse } from '../types/messages'

const POLL_MS = 1000

/**
 * Progress is pulled, not pushed: `downloads.onChanged` never reports bytesReceived, so there is
 * nothing for the worker to broadcast — and broadcasting to a closed panel throws anyway.
 */
export function useRunState() {
  const [state, setState] = useState<StateResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      setState(await sendToWorker<StateResponse>({ type: MessageType.GetState }))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      if (cancelled) return
      if (!document.hidden) await refresh()
      if (!cancelled) timer.current = window.setTimeout(poll, POLL_MS)
    }
    void poll()

    return () => {
      cancelled = true
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [refresh])

  return { state, error, refresh }
}

export interface ActiveTab {
  id: number | null
  url: string
}

/** The side panel outlives the tab it was opened on, so the active tab is tracked, not read once. */
export function useActiveTab(): ActiveTab {
  const [tab, setTab] = useState<ActiveTab>({ id: null, url: '' })

  useEffect(() => {
    let cancelled = false

    const sync = async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!cancelled) setTab({ id: active?.id ?? null, url: active?.url ?? '' })
    }
    void sync()

    const onActivated = () => {
      void sync()
    }
    const onUpdated = (_tabId: number, change: chrome.tabs.OnUpdatedInfo, updated: chrome.tabs.Tab) => {
      if (updated.active && change.url) void sync()
    }

    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onUpdated.addListener(onUpdated)

    return () => {
      cancelled = true
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    }
  }, [])

  return tab
}
