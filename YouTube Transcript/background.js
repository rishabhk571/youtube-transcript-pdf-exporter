/**
 * background.js  –  Manifest V3 Service Worker
 *
 * Responsibilities:
 *   • Relays PROGRESS messages from content.js → popup via a long-lived port.
 *   • Popup connects with name 'popup' on load; port is cleared on disconnect.
 */

'use strict';

let popupPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPort = port;
    port.onDisconnect.addListener(() => { popupPort = null; });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if (message.action === 'PROGRESS' && popupPort) {
    try {
      popupPort.postMessage(message);
    } catch (_) {
      // Popup closed mid-operation; swallow.
    }
  }
  // No async sendResponse — do NOT return true.
});
