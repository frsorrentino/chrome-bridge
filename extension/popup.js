const indicator = document.getElementById('indicator');
const statusText = document.getElementById('status-text');

const labels = {
  connected: 'Connected',
  connecting: 'Connecting...',
  disconnected: 'Disconnected',
};

function updateUI(state) {
  indicator.className = `indicator ${state}`;
  statusText.textContent = labels[state] || state;
}

// Ascolta aggiornamenti dal service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'connectionState') {
    updateUI(msg.state);
  }
});

// Richiedi stato attuale al service worker
chrome.runtime.sendMessage({ type: 'getConnectionState' }, (response) => {
  if (response && response.state) {
    updateUI(response.state);
  }
});
