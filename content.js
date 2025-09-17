let isRecording = false;

// Check recording state from background on load
chrome.runtime.sendMessage({ action: 'checkRecordingState' }, (response) => {
    if (response && response.isRecording !== undefined) {
        isRecording = response.isRecording;
        console.log("[Content] Initial recording state:", isRecording);
        
        if (isRecording) {
            // If already recording, log page load event
            logEvent('pageload', {
                url: window.location.href,
                title: document.title
            });
        }
    }
    // Detect page refresh
    if (performance.getEntriesByType("navigation")[0]?.type === "reload") {
        logEvent('refresh', {
            url: window.location.href,
            title: document.title
        });
}

});

// Listen for recording state updates from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[Content] Received message:", message);

    if (message.action === 'updateRecordingState') {
        const previousState = isRecording;
        isRecording = message.isRecording;
        console.log(`[Content] Recording state updated: ${isRecording}`);
        
        // If recording just started, log navigation event
        if (!previousState && isRecording) {
            logEvent('navigation', {
                url: window.location.href,
                title: document.title
            });
        }

        if (!isRecording) {
            inputLastValueMap.clear();
        }
        
        // Send acknowledgment back
        if (sendResponse) {
            sendResponse({ success: true });
        }
    }
});

// Utility: Send event to background
function logEvent(type, details = {}) {
    if (!isRecording) return;
    try {
        chrome.runtime.sendMessage({ 
            action: 'logEvent', 
            type, 
            details
        });
    } catch (err) {
        console.error('[Content] logEvent error:', err);
    }
}

// Utility: Get element locator (unchanged)
function getElementLocator(el) {
    if (!el || !el.tagName) return null;
    if (el.id) return { type: 'id', expression: el.id };
    if (el.name && el.tagName !== 'BUTTON') return { type: 'name', expression: el.name };

    const css = el.tagName.toLowerCase() + (el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '');
    if (css !== el.tagName.toLowerCase()) return { type: 'css', expression: css };

    function getXPath(element) {
        if (element === document.body) return '/html/body';
        let ix = 1;
        let sib = element.previousElementSibling;
        while (sib) {
            if (sib.tagName === element.tagName) ix++;
            sib = sib.previousElementSibling;
        }
        return getXPath(element.parentNode) + '/' + element.tagName.toLowerCase() + `[${ix}]`;
    }

    return { type: 'xpath', expression: getXPath(el) };
}

// Track input value changes
const inputLastValueMap = new WeakMap();

/**
 * Attaches event listeners to input elements within a given node (document or shadowRoot).
 * This function is designed to be called recursively for shadow DOMs.
 * @param {Node} node - The node (document or shadowRoot) to search within.
 */
function attachListenersToNode(node) {
    node.querySelectorAll('input, textarea').forEach(el => {
        if (el.dataset.listenerAttached) return;
        // console.log('[Content] Attaching listeners to:', el, 'in node:', node); // For deep debugging
        el.dataset.listenerAttached = 'true';
        inputLastValueMap.set(el, el.value);

        // We'll only track inputs in the WeakMap while typing,
        // but won't log every single keystroke
        el.addEventListener('input', e => {
            if (!isRecording) return;
            // Just update the stored value without logging an event
            inputLastValueMap.set(e.target, e.target.value);
        });

        // Log the complete input value when field loses focus
        el.addEventListener('blur', e => {
            if (!isRecording) return;
            const { value, type } = e.target;
            const prevValue = inputLastValueMap.get(e.target) || '';
            
            // Only log if there's an actual change from initial state
            if (value !== '' && value !== prevValue) {
                const locator = getElementLocator(e.target);
                logEvent('input', {
                    value: type === 'password' ? '********' : value,
                    type,
                    locatorType: locator?.type,
                    locatorExpression: locator?.expression
                });
                // Reset the stored value
                inputLastValueMap.set(e.target, '');
            }
        });

        // Handle Enter key specially (common form submission)
        el.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                // When Enter is pressed, log the entire value immediately
                const { value, type } = e.target;
                if (value !== '') {
                    const locator = getElementLocator(e.target);
                    
                    logEvent('input', {
                        value: type === 'password' ? '********' : value,
                        type,
                        locatorType: locator?.type,
                        locatorExpression: locator?.expression,
                        enterKey: true
                    });
                    
                    // Update the stored value to prevent duplicate logging on blur
                    inputLastValueMap.set(e.target, value);
                }
            }
        });
    });

    node.querySelectorAll('select').forEach(el => {
        if (el.dataset.listenerAttached) return;
        el.dataset.listenerAttached = 'true';

        el.addEventListener('change', e => {
            if (!isRecording) return;
            const locator = getElementLocator(e.target);
            logEvent('input', {
                value: e.target.value,
                type: 'select',
                locatorType: locator?.type,
                locatorExpression: locator?.expression
            });
        });
    });

// Modify the attachAllInputListeners function to include our specialized file handler
function attachAllInputListeners() {
    console.log('[Content] Running attachAllInputListeners for document.');
    attachListenersToNode(document); // Standard listeners
    attachFileInputListeners(document); // Specialized file upload listeners
    
    // Handle any shadow DOMs
    document.querySelectorAll('*').forEach(element => {
        if (element.shadowRoot) {
            attachListenersToNode(element.shadowRoot);
            attachFileInputListeners(element.shadowRoot);
        }
    });
}

// Standalone enhanced file upload handling function (moved from being nested)
function attachFileInputListeners(node) {
    // Target file inputs specifically
    node.querySelectorAll('input[type="file"]').forEach(el => {
        if (el.dataset.fileListenerAttached) return;
        el.dataset.fileListenerAttached = 'true';

        console.log("[Content] Attaching file upload listener to:", el);

        // Use both change and input events for better capture reliability
        ['change', 'input'].forEach(eventType => {
            el.addEventListener(eventType, e => {
                if (!isRecording) return;
            
                const locator = getElementLocator(e.target);
                const fileNames = Array.from(e.target.files || []).map(f => f.name);
            
                console.log("[Content] File upload detected:", fileNames);
                // console.log("[Content] Files object:", e.target.files); // Optional: for deeper debugging
            
                const details = {
                    fileCount: e.target.files ? e.target.files.length : 0,
                    fileNames,
                    inputType: 'file',
                    locatorType: locator?.type || '',
                    locatorExpression: locator?.expression || '',
                    eventType: eventType,
                    timestamp: Date.now() // ADDED THIS LINE
                };
            
                logEvent('Fileupload', details, 'high'); // Use the enhanced logEvent
            }, { capture: true }); // Use capture phase for earliest possible detection
        });
    });
}

// Create a specialized MutationObserver just for file inputs
const fileInputObserver = new MutationObserver((mutations) => {
    if (!isRecording) return;

    let fileInputsFound = false;

    mutations.forEach(mutation => {
        if (mutation.addedNodes && mutation.addedNodes.length) {
            for (let i = 0; i < mutation.addedNodes.length; i++) {
                const node = mutation.addedNodes[i];
                if (node.nodeType === 1) { // Element node
                    if (node.tagName === 'INPUT' && node.type === 'file') {
                        fileInputsFound = true;
                    } else if (node.querySelector && node.querySelector('input[type="file"]')) {
                        fileInputsFound = true;
                    }
                }
            }
        }
    });

    if (fileInputsFound) {
        console.log('[Content] File inputs detected in DOM changes');
        // Call the main attachment function to ensure all listeners, including those in shadow DOMs, are updated.
        // attachAllInputListeners();
        // Or, more targeted:
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(addedNode => {
                if (addedNode.nodeType === 1) attachFileInputListeners(addedNode); // Attach to the new node
            });
        });
    }
});

// Start the file input observer
fileInputObserver.observe(document.body, { childList: true, subtree: true });

// Enhanced logEvent function with priority support
function logEvent(type, details = {}, priority = 'normal') {
    if (!isRecording) return;
    try {
        const message = {
            action: 'logEvent',
            type,
            details,
            priority
        };

        // Special debug logging for file uploads
        if (type === 'Fileupload') {
            console.log('[Content] Sending file upload event to background:', message);
            chrome.runtime.sendMessage(message, response => { // SendMessage with callback for file uploads
                if (chrome.runtime.lastError) {
                    console.error('[Content] File upload sendMessage error:', chrome.runtime.lastError.message);
                } else {
                    console.log('[Content] File upload event response:', response);
                }
            });
        } else {
            chrome.runtime.sendMessage(message); // SendMessage without callback for other events
        }
    } catch (err) {
        console.error('[Content] logEvent error:', err);
    }
}

function attachAllInputListeners() {
    console.log('[Content] Running attachAllInputListeners for document.');
    attachListenersToNode(document); // Standard listeners
    attachFileInputListeners(document); // Specialized file upload listeners

    // Handle any shadow DOMs
    document.querySelectorAll('*').forEach(element => {
        if (element.shadowRoot) {
            attachListenersToNode(element.shadowRoot);
            attachFileInputListeners(element.shadowRoot);
        }
    });
}

function attachListenersToNode(node) {
    // ... other input types ...

    // Recursively search for and attach listeners within any shadow roots in this node
    node.querySelectorAll('*').forEach(element => {
        if (element.shadowRoot) {
            // console.log('[Content] Found shadowRoot, descending into:', element); // For deep debugging
            attachListenersToNode(element.shadowRoot);
        }
    });
}
}

// Attach listeners on DOM ready
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    attachAllInputListeners();
} else {
    document.addEventListener('DOMContentLoaded', attachAllInputListeners);
}

// MutationObserver for dynamic DOM changes
const observer = new MutationObserver(() => {
    if (isRecording) attachAllInputListeners(); // Re-scan the entire document including shadow DOMs
});
observer.observe(document.body, { childList: true, subtree: true });

// --- Click Events ---
document.addEventListener('click', e => {
    if (!isRecording) return;
    const locator = getElementLocator(e.target);
    logEvent('click', {
        target: {
            tagName: e.target.tagName,
            className: e.target.className,
            id: e.target.id,
            textContent: e.target.textContent?.trim().substring(0, 50)
        },
        offsetX: e.offsetX,
        offsetY: e.offsetY,
        pageX: e.pageX,
        pageY: e.pageY,
        locatorType: locator?.type,
        locatorExpression: locator?.expression
    });
});

// --- Right Click ---
document.addEventListener('contextmenu', e => {
    if (!isRecording) return;
    const locator = getElementLocator(e.target);
    logEvent('rightclick', {
        locatorType: locator?.type,
        locatorExpression: locator?.expression,
        tagName: e.target.tagName
    });
});

// --- Drag and Drop Functionality ---
let draggedElement = null;
let dragStartLocation = null;

// Drag start event
document.addEventListener('dragstart', e => {
    if (!isRecording) return;
    draggedElement = e.target;
    dragStartLocation = getElementLocator(e.target);
    
    logEvent('dragstart', {
        locatorType: dragStartLocation?.type,
        locatorExpression: dragStartLocation?.expression,
        tagName: e.target.tagName,
        id: e.target.id,
        className: e.target.className,
        pageX: e.pageX,
        pageY: e.pageY
    });
});

// Drag over event (don't log every move, just prevent default to allow drop)
document.addEventListener('dragover', e => {
    if (!isRecording || !draggedElement) return;
    e.preventDefault(); // Necessary to allow drop
});

// Drop event
document.addEventListener('drop', e => {
    if (!isRecording || !draggedElement) return;
    e.preventDefault();
    
    const dropTarget = e.target;
    const dropLocation = getElementLocator(dropTarget);
    
    logEvent('drop', {
        dragLocatorType: dragStartLocation?.type,
        dragLocatorExpression: dragStartLocation?.expression,
        dropLocatorType: dropLocation?.type,
        dropLocatorExpression: dropLocation?.expression,
        draggedTagName: draggedElement.tagName,
        draggedId: draggedElement.id,
        draggedClassName: draggedElement.className,
        dropTargetTagName: dropTarget.tagName,
        dropTargetId: dropTarget.id,
        dropTargetClassName: dropTarget.className,
        pageX: e.pageX,
        pageY: e.pageY
    });
    
    // Reset drag state
    draggedElement = null;
    dragStartLocation = null;
});

// Drag end event (in case drop happens outside valid drop targets)
document.addEventListener('dragend', e => {
    if (!isRecording) return;
    
    // Only log if we still have a reference to the dragged element
    // but no drop was logged (drop outside valid target)
    if (draggedElement) {
        logEvent('dragend', {
            locatorType: dragStartLocation?.type,
            locatorExpression: dragStartLocation?.expression,
            tagName: draggedElement.tagName,
            id: draggedElement.id,
            className: draggedElement.className,
            pageX: e.pageX,
            pageY: e.pageY,
            cancelled: true
        });
        
        // Reset drag state
        draggedElement = null;
        dragStartLocation = null;
    }
});

// --- Manual drag detection for non-draggable elements ---
let isDragging = false;
let dragStartElement = null;
let dragStartPos = { x: 0, y: 0 };
let dragThreshold = 10; // pixels to move before considering it a drag

document.addEventListener('mousedown', e => {
    if (!isRecording) return;
    // Store initial position and target element
    isDragging = false;
    dragStartElement = e.target;
    dragStartPos = { x: e.pageX, y: e.pageY };
});

document.addEventListener('mousemove', e => {
    if (!isRecording || !dragStartElement) return;
    
    // Check if we've moved past the threshold
    const deltaX = Math.abs(e.pageX - dragStartPos.x);
    const deltaY = Math.abs(e.pageY - dragStartPos.y);
    
    // If we've moved past threshold and not already dragging
    if (!isDragging && (deltaX > dragThreshold || deltaY > dragThreshold)) {
        isDragging = true;
        dragStartLocation = getElementLocator(dragStartElement);
        
        logEvent('manualDragStart', {
            locatorType: dragStartLocation?.type,
            locatorExpression: dragStartLocation?.expression,
            tagName: dragStartElement.tagName,
            id: dragStartElement.id,
            className: dragStartElement.className,
            startX: dragStartPos.x,
            startY: dragStartPos.y
        });
    }
});

document.addEventListener('mouseup', e => {
    if (!isRecording || !dragStartElement) return;
    
    // If we were dragging, log the drop
    if (isDragging) {
        const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
        const dropLocation = getElementLocator(dropTarget);
        
        logEvent('manualDrop', {
            dragLocatorType: dragStartLocation?.type,
            dragLocatorExpression: dragStartLocation?.expression,
            dropLocatorType: dropLocation?.type,
            dropLocatorExpression: dropLocation?.expression,
            draggedTagName: dragStartElement.tagName,
            draggedId: dragStartElement.id,
            draggedClassName: dragStartElement.className,
            dropTargetTagName: dropTarget.tagName,
            dropTargetId: dropTarget.id,
            dropTargetClassName: dropTarget.className,
            startX: dragStartPos.x,
            startY: dragStartPos.y,
            endX: e.pageX,
            endY: e.pageY,
            distance: Math.sqrt(Math.pow(e.pageX - dragStartPos.x, 2) + Math.pow(e.pageY - dragStartPos.y, 2))
        });
    }
    
    // Reset drag state
    isDragging = false;
    dragStartElement = null;
});

// --- Scroll Detection ---
let lastScrollY = 0;
let lastScrollTime = 0;
document.addEventListener('scroll', () => {
    if (!isRecording) return;
    const now = Date.now();
    if (now - lastScrollTime < 100) return;
    lastScrollTime = now;

    const direction = window.scrollY > lastScrollY ? 'down' : 'up';
    lastScrollY = window.scrollY;

    logEvent('scroll', {
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        direction
    });
}, { passive: true });

// --- Scroll Drag Detection ---
let scrollDragInProgress = false;
let scrollDragStartY = 0, scrollDragStartTime = 0;

document.addEventListener('mousedown', e => {
    if (!isRecording || e.button !== 0) return;
    scrollDragInProgress = true;
    scrollDragStartY = e.clientY;
    scrollDragStartTime = Date.now();
});

document.addEventListener('mousemove', e => {
    if (!isRecording || !scrollDragInProgress) return;
    const deltaY = e.clientY - scrollDragStartY;
    const deltaTime = Date.now() - scrollDragStartTime;
    if (Math.abs(deltaY) > 50 && deltaTime > 200) {
        logEvent('scrollDrag', {
            direction: deltaY > 0 ? 'down' : 'up',
            deltaY,
            deltaTime,
            endY: e.clientY
        });
        scrollDragInProgress = false;
    }
});

['mouseup', 'mouseleave'].forEach(event => {
    document.addEventListener(event, () => {
        if (isRecording) scrollDragInProgress = false;
    });
});

// --- Window Events ---
// We listen for window resize events to detect possible maximize/minimize
let lastWindowWidth = window.innerWidth;
let lastWindowHeight = window.innerHeight;

window.addEventListener('resize', () => {
    if (!isRecording) return;
    
    // Detect if this is likely a maximize or minimize event
    const isMaximize = window.innerWidth > lastWindowWidth && window.innerHeight > lastWindowHeight;
    const isMinimize = window.innerWidth < lastWindowWidth && window.innerHeight < lastWindowHeight;
    
    // Log the appropriate event
    if (isMaximize) {
        logEvent('windowMaximize', {
            oldWidth: lastWindowWidth,
            oldHeight: lastWindowHeight,
            newWidth: window.innerWidth,
            newHeight: window.innerHeight
        });
    } else if (isMinimize) {
        logEvent('windowMinimize', {
            oldWidth: lastWindowWidth,
            oldHeight: lastWindowHeight,
            newWidth: window.innerWidth,
            newHeight: window.innerHeight
        });
    }
    
    // Update the last known window size
    lastWindowWidth = window.innerWidth;
    lastWindowHeight = window.innerHeight;
});

// --- Iframe Interaction ---
window.addEventListener('load', () => {
    document.querySelectorAll('iframe').forEach(iframe => {
        iframe.addEventListener('load', () => {
            if (!isRecording) return;
            logEvent('iframe', { src: iframe.src });

            try {
                const doc = iframe.contentDocument;
                if (doc) {
                    doc.addEventListener('click', e => {
                        logEvent('iframeClick', {
                            iframeSrc: iframe.src,
                            tagName: e.target.tagName,
                            className: e.target.className,
                            id: e.target.id,
                            offsetX: e.offsetX,
                            offsetY: e.offsetY
                        });
                    });
                }
            } catch (err) {
                console.warn('Cross-origin iframe access denied:', err);
            }
        });
    });
});

// Log page navigation when recording is active
window.addEventListener('load', () => {
    if (isRecording) {
        logEvent('navigation', {
            url: window.location.href,
            title: document.title
        });
    }

// --- Back and Forward Navigation Detection ---
window.addEventListener('popstate', () => {
    if (!isRecording) return;

    logEvent('historyNavigation', {
        direction: history.state ? 'forward' : 'back', // heuristic; might always say "forward"
        url: window.location.href,
        title: document.title
    });
});

});