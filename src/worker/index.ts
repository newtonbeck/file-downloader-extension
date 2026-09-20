import {
  onProviderTabReady,
  onTabClosed,
  restoreAfterStartup,
  RETRY_ALARM,
  tick,
  WATCHDOG_ALARM,
} from './engine'
import { registerRouter } from './router'
import { isProviderUrl } from './tabs'

/**
 * Every listener below is registered synchronously at the top level. That is not style: it is
 * what allows a terminated service worker to be woken by these events rather than miss them,
 * which is the whole reason a multi-hour run can survive the worker dying between files.
 */

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return
  // Opened before the options are set, since Chrome only grants the open while the click that
  // asked for it is still in hand.
  await chrome.sidePanel.open({ tabId: tab.id })
  await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'index.html', enabled: true })
})

registerRouter()

chrome.downloads.onChanged.addListener((delta) => {
  // Progress never arrives here — onChanged reports every property except bytesReceived and
  // estimatedEndTime — so anything that does arrive is a transition worth acting on.
  if (!delta.state && !delta.error && !delta.exists) return
  void tick()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM && alarm.name !== RETRY_ALARM) return
  void tick()
})

chrome.runtime.onStartup.addListener(() => {
  void restoreAfterStartup()
})

chrome.runtime.onInstalled.addListener(() => {
  void restoreAfterStartup()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void onTabClosed(tabId)
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return
  if (!isProviderUrl(tab.url)) return
  void onProviderTabReady(tabId)
})
