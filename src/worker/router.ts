import { MessageType } from '../types/messages'
import type { Message } from '../types/messages'
import * as engine from './engine'

async function handle(message: Message): Promise<unknown> {
  switch (message.type) {
    case MessageType.Scan:
      await engine.scan(message.tabId)
      return { started: true }
    case MessageType.GetState:
      return engine.getState()
    case MessageType.GetTree:
      return engine.getTree()
    case MessageType.Start:
      return { run: await engine.startRun(message.destination) }
    case MessageType.Pause:
      return { run: await engine.pauseRun() }
    case MessageType.Resume:
      return { run: await engine.resumeRun() }
    case MessageType.CancelRun:
      await engine.cancelRun()
      return { ok: true }
    case MessageType.RetryFailed:
      return { run: await engine.retryFailed() }
    case MessageType.SetTab:
      return { run: await engine.adoptTab(message.tabId) }
    default:
      throw new Error(`Unknown message: ${JSON.stringify(message)}`)
  }
}

export function registerRouter(): void {
  chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
    handle(message)
      .then((data) => sendResponse({ success: true, data }))
      .catch((error: unknown) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    // Every branch answers asynchronously, so the channel is held open unconditionally.
    return true
  })
}
