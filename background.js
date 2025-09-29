let isRecording = false;
let eventLog = [];
let activeTabId = null;
let pageLoadTime = Date.now();
let windowId = null; 
let windowState = 'normal'; 
//jshint esversion: 6
// Utility: escape XML chars
function escapeXml(unsafe) {
    return String(unsafe).replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
        return c;
    });
}

// Utility: convert JSON → XML
function toXml(data, rootName = 'event') {
    let xml = `<${rootName}>`;
    for (const key in data) {
        if (data.hasOwnProperty(key)) {
            const value = data[key];
            const tagName = key.replace(/[^a-zA-Z0-9_]/g, '');

            if (Array.isArray(value)) {
                value.forEach(item => {
                    xml += toXml(item, tagName);
                });
            } else if (typeof value === 'object' && value !== null) {
                xml += toXml(value, tagName);
            } else {
                xml += `<${tagName}>${escapeXml(value)}</${tagName}>`;
            }
        }
    }
    xml += `</${rootName}>`;
    return xml;
}

function convertEventLogToXml(log) {
    let xml = '<eventLog>';
    log.forEach(entry => {
        xml += toXml(entry);
    });
    xml += '</eventLog>';
    return xml;
}

function addEventToLog(entry, tabId) {
    eventLog.push(entry);

    // Save to storage
    chrome.storage.local.set({ recordedEvents: eventLog }, () => {
        console.log("[Background] Event saved:", entry);
    });
}

// Check if window maximized
function isWindowMaximized(window) {
    return window.state === "maximized" ||
        (window.width >= screen.width && window.height >= screen.height);
}

// Background message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[Background] Received message:", message);

    if (message.action === 'startRecording') {
        if (isRecording) {
            sendResponse({ success: false, error: "Already recording" });
            return true;
        }

        isRecording = true;
        eventLog = [];
        chrome.storage.local.set({ recordedEvents: [] }); // reset
        pageLoadTime = Date.now();

        chrome.windows.getCurrent({}, (window) => {
            windowId = window.id;
            windowState = window.state;
            addEventToLog({
                type: 'windowState',
                time: new Date().toISOString(),
                details: { state: window.state }
            }, activeTabId);
        });

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length > 0) {
                activeTabId = tabs[0].id;

                addEventToLog({
                    type: 'navigation',
                    time: new Date().toISOString(),
                    details: { url: tabs[0].url }
                }, activeTabId);

                chrome.tabs.query({}, (allTabs) => {
                    allTabs.forEach(tab => {
                        try {
                            chrome.tabs.sendMessage(tab.id, {
                                action: 'updateRecordingState',
                                isRecording: true
                            });
                        } catch (err) {
                            console.error(`[Background] Could not send to tab ${tab.id}: ${err.message}`);
                        }
                    });
                });

                sendResponse({ success: true });
            } else {
                sendResponse({ success: false, error: "No active tab" });
            }
        });

        return true;

    } else if (message.action === 'stopRecording') {
        if (!isRecording) {
            sendResponse({ success: false, error: "No recording in progress" });
            return true;
        }

        isRecording = false;

        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                try {
                    chrome.tabs.sendMessage(tab.id, {
                        action: 'updateRecordingState',
                        isRecording: false
                    });
                } catch (err) {
                    console.error(`[Background] Could not send to tab ${tab.id}: ${err.message}`);
                }
            });
        });

        sendResponse({ success: true });
        return true;

    } else if (message.action === 'getEventLog') {
        chrome.storage.local.get(['recordedEvents'], (result) => {
            const log = result.recordedEvents || [];
            const xmlLog = convertEventLogToXml(log);
            sendResponse({ log: xmlLog, format: 'xml' });
        });
        return true;

    } else if (message.action === 'logEvent' && isRecording) {
        const entry = {
            type: message.type,
            time: new Date().toISOString(),
            details: message.details || {}
        };

        if (message.type === 'Fileupload') {
            entry.priority = message.priority || 'normal';
            if (message.details && message.details.fileNames) {
                console.log("[Background] File names:", message.details.fileNames);
            }
        }

        const tabId = sender?.tab?.id ?? activeTabId ?? -1;
        addEventToLog(entry, tabId);

        sendResponse({ success: true });
        return true;

    } else if (message.action === 'checkRecordingState') {
        sendResponse({ isRecording });
        return true;
    }

    return false;
});

// Navigation event logging
chrome.webNavigation.onCompleted.addListener((details) => {
    if (isRecording && details.frameId === 0) {
        chrome.tabs.get(details.tabId, (tab) => {
            if (tab && tab.url) {
                addEventToLog({
                    type: 'navigation',
                    time: new Date().toISOString(),
                    details: { url: tab.url }
                }, details.tabId);
            }
        });
    }
});

// Tab switch logging
chrome.tabs.onActivated.addListener((activeInfo) => {
    if (isRecording) {
        chrome.tabs.get(activeInfo.tabId, (tab) => {
            if (tab && tab.url) {
                if (activeTabId !== activeInfo.tabId) {
                    activeTabId = activeInfo.tabId;
                    addEventToLog({
                        type: 'tabswitch',
                        time: new Date().toISOString(),
                        details: { url: tab.url }
                    }, activeInfo.tabId);
                }
            }
        });
    }
});

// Window state logging
chrome.windows.onBoundsChanged.addListener((window) => {
    if (isRecording && window.id === windowId) {
        chrome.windows.get(window.id, {}, (updatedWindow) => {
            if (updatedWindow.state !== windowState) {
                const previousState = windowState;
                windowState = updatedWindow.state;

                addEventToLog({
                    type: 'windowStateChange',
                    time: new Date().toISOString(),
                    details: {
                        previousState: previousState,
                        currentState: windowState
                    }
                }, activeTabId ?? -1);
            } else if (isWindowMaximized(updatedWindow) && windowState !== 'maximized') {
                windowState = 'maximized';
                addEventToLog({
                    type: 'windowMaximize',
                    time: new Date().toISOString(),
                    details: { state: 'maximized-by-size' }
                }, activeTabId ?? -1);
            }
        });
    }
});

// Downloads logging
chrome.downloads.onCreated.addListener((downloadItem) => {
    if (isRecording) {
        const tabId = typeof activeTabId === 'number' ? activeTabId : -1;
        addEventToLog({
            type: 'download',
            time: new Date().toISOString(),
            details: {
                filename: downloadItem.filename,
                url: downloadItem.url
            }
        }, tabId);
    }
});
