import type { Message, Response } from '../types/messages'

/** Panel side of the seam: unwraps `{ success, data | error }` into a value or a throw. */
export async function sendToWorker<T>(message: Message): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as Response<T> | undefined
  if (!response) throw new Error('The extension service worker did not respond.')
  if (!response.success) throw new Error(response.error)
  return response.data
}
