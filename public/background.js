// Service worker: the only place that will hold provider tokens and talk to the
// network once a provider is wired up. For now it just opens the side panel.

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'index.html',
    enabled: true
  });
});
