document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startButton');
  const stopBtn = document.getElementById('stopButton');
  const viewBtn = document.getElementById('viewButton');
  const exportBtn = document.getElementById('exportButton');
  const outputBox = document.getElementById('outputBox');

  function log(...args) { console.log('[Popup]', ...args); }

  function showMessage(text, timeout = 3000) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.position = 'fixed';
    el.style.bottom = '14px';
    el.style.left = '50%';
    el.style.transform = 'translateX(-50%)';
    el.style.background = 'rgba(52,152,219,0.95)';
    el.style.color = 'white';
    el.style.padding = '8px 12px';
    el.style.borderRadius = '6px';
    el.style.zIndex = 9999;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), timeout);
  }

  function escapeXml(unsafe) {
    return String(unsafe).replace(/[<>&'"]/g, c => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case "'": return '&apos;';
        case '"': return '&quot;';
      }
      return c;
    });
  }

  function convertObjectToXml(obj, rootName = 'event') {
    let xml = `<${rootName}>`;
    for (const key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      const value = obj[key];
      const tag = String(key).replace(/[^a-zA-Z0-9_]/g, '');
      if (Array.isArray(value)) {
        value.forEach(item => xml += convertObjectToXml(item, tag));
      } else if (typeof value === 'object' && value !== null) {
        xml += convertObjectToXml(value, tag);
      } else {
        xml += `<${tag}>${escapeXml(String(value))}</${tag}>`;
      }
    }
    xml += `</${rootName}>\n`;
    return xml;
  }

  function convertArrayLogToXml(arr) {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<eventLog>\n`;
    arr.forEach(entry => {
      xml += convertObjectToXml(entry, 'event');
    });
    xml += `</eventLog>`;
    return xml;
  }

  // Start recording
  startBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'startRecording' }, (resp) => {
      log('startRecording response', resp, chrome.runtime.lastError);
      if (chrome.runtime.lastError) {
        alert('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      if (resp && resp.success) {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        showMessage('Recording started');
      } else {
        alert('Start failed: ' + (resp?.error || 'unknown'));
      }
    });
  });

  // Stop recording
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopRecording' }, (resp) => {
      log('stopRecording response', resp, chrome.runtime.lastError);
      if (chrome.runtime.lastError) {
        alert('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      if (resp && resp.success) {
        startBtn.disabled = false;
        stopBtn.disabled = true;
        showMessage('Recording stopped');
      } else {
        alert('Stop failed: ' + (resp?.error || 'unknown'));
      }
    });
  });

  // View events (display in popup)
  viewBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'getEventLog' }, (response) => {
      log('getEventLog response', response, chrome.runtime.lastError);
      if (chrome.runtime.lastError) {
        outputBox.textContent = 'Error: ' + chrome.runtime.lastError.message;
        return;
      }
      if (!response) {
        outputBox.textContent = '<eventLog>No response from background</eventLog>';
        return;
      }

      // If background returned XML string
      if (response.format === 'xml' || typeof response.log === 'string') {
        outputBox.textContent = response.log || '<eventLog></eventLog>';
      } else if (Array.isArray(response.log)) {
        outputBox.textContent = convertArrayLogToXml(response.log);
      } else {
        // fallback: pretty JSON
        outputBox.textContent = JSON.stringify(response.log || response, null, 2);
      }
    });
  });

  // Export events (download)
  exportBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'getEventLog' }, (response) => {
      log('getEventLog for export', response, chrome.runtime.lastError);
      if (chrome.runtime.lastError) {
        alert('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      if (!response) {
        alert('No response from background.');
        return;
      }

      let xmlData = '';
      if (response.format === 'xml' || typeof response.log === 'string') {
        xmlData = response.log || '<eventLog></eventLog>';
      } else if (Array.isArray(response.log)) {
        xmlData = convertArrayLogToXml(response.log);
      } else if (response.log) {
        // best-effort fallback
        xmlData = '<?xml version="1.0" encoding="UTF-8"?>\n<eventLog>\n' +
                  `<raw>${escapeXml(JSON.stringify(response.log))}</raw>\n</eventLog>`;
      } else {
        alert('No events to export.');
        return;
      }

      const filename = `steepgraph_events_${new Date().toISOString().replace(/[:.]/g, '-')}.xml`;
      const blob = new Blob([xmlData], { type: 'text/xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);     // necessary on some browsers
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      showMessage('Export started — check your downloads folder');
    });
  });

  // optional: initialize UI state by checking recording state from background
  chrome.runtime.sendMessage({ action: 'checkRecordingState' }, (resp) => {
    log('checkRecordingState', resp);
    if (resp && resp.isRecording) {
      startBtn.disabled = true;
      stopBtn.disabled = false;
    } else {
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  });
});
