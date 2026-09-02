import { getSettings } from './settings.js';
import { getContext } from '../../../../st-context.js';
import { eventSource, event_types } from '../../../../events.js';
import { loadStateFromMetadata, applyUpdate, parseMessageForUpdates, registerActiveCharacter, removeActiveCharacter, undoLastChange, getHistoryEntries, resolveMaxValue } from './status-logic.js';
import { escapeRegExp, escapeHtml, extractJSON, safeJsonParse, computeStatBar, applyStatFormat } from './utils.js';
import { findTemplateLabels, applyLabelFixes } from './template-labels.js';
import { LOG_PREFIX, debugLog, BUILT_IN_DEFAULT_AVATAR } from './constants.js';
import { stripAndPersist } from './status-history.js';
import { renderReviewPanel } from './ui-change-review.js';
import { stateAtMessage } from './status-snapshots.js';
import { findCardForName } from './status-logic.js';
import { getTrackerView } from './tracker-view.js';
import { openCastPanel } from './ui-cast-panel.js';

const processingMessages = new Set();

/**
 * Live MutationObservers, keyed by message id.
 *
 * These used to be created per message and guarded only by a DOM attribute, with
 * nothing ever disconnecting them -- so they accumulated for the lifetime of the tab
 * and kept observing detached nodes after a chat switch. Tracking them here lets
 * disconnectStatusObservers() tear them all down on CHAT_CHANGED.
 *
 * @type {Map<string, MutationObserver>}
 */
const statusObservers = new Map();

/**
 * Disconnects and forgets every per-message observer. Called on chat change.
 */
function disconnectStatusObservers() {
    for (const observer of statusObservers.values()) {
        observer.disconnect();
    }
    statusObservers.clear();
    processingMessages.clear();
}

// A chat switch replaces every message node, so the observers watching the old
// ones are pure garbage. Handled here rather than in status-logic.js to avoid an
// import cycle between the two modules.
eventSource.on(event_types.CHAT_CHANGED, disconnectStatusObservers);

/**
 * Whether a mutated node sits inside the extension's own status box.
 *
 * Text nodes have no closest(), so the check climbs to the parent first rather than
 * testing nodeType against a constant the test environment does not define.
 *
 * @param {Node} node
 * @returns {boolean}
 */
export function insideTracker(node) {
    const el = node && typeof node.closest === 'function' ? node : node?.parentElement;
    return !!el?.closest?.('.sillynpc-status-tracker-container');
}

/**
 * Whether somebody is part-way through typing into the status box on this message.
 *
 * Redrawing then replaces the element under the cursor, so the caret is lost and the
 * half-typed value with it. Every redraw path is subject to this, not only the observer -
 * a status update arriving mid-edit would do the same. The edit is applied on blur, which
 * redraws, so nothing is missed by waiting.
 *
 * @param {Element} mesEl
 * @returns {boolean}
 */
export function isEditingInside(mesEl) {
    const active = document.activeElement;
    return !!active
        && typeof active.closest === 'function'
        && !!active.closest('.sillynpc-status-editable')
        && mesEl.contains(active);
}

/**
 * Hides the "Reasoning:" prefix line that may appear before the status update element.
 * Walks backward from the given DOM node to find and truncate/hide it.
 * @param {Node} refNode  The status_update element or the first hidden text node.
 */
function hideReasoningPrefixBefore(refNode) {
    let node = refNode.previousSibling;
    while (node) {
        if (node.nodeType === Node.TEXT_NODE) {
            const t = node.nodeValue;
            // Find a "Reasoning:" that starts a line near the end of this text node
            const m = t.match(/((?:\n|^)\s*Reasoning\s*:[\s\S]*)$/i);
            if (m) {
                node.nodeValue = t.substring(0, t.length - m[0].length).replace(/\s+$/, '');
            }
            break;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (/reasoning\s*:/i.test(node.textContent)) {
                node.style.display = 'none';
                node.setAttribute('data-sillynpc-hidden', 'true');
            }
            break;
        }
        node = node.previousSibling;
    }
}

/**
 * Processes a message for status updates and hides the raw data.
 * Called BEFORE character image injection to ensure DOM stability.
 * @param {Element} mesEl 
 */
export function processStatusUpdate(mesEl) {
    const mesId = mesEl.getAttribute('mesid');
    if (!mesId || mesEl.closest('#welcome-message')) return;
    if (processingMessages.has(mesId)) return;

    const settings = getSettings().statusTracker;
    if (!settings.enabled) return;

    const textContainer = mesEl.querySelector('.mes_text');
    if (!textContainer) return;

    const isUser = mesEl.classList.contains('user_mes');
    if (isUser) return;

    // Setup MutationObserver to watch for content changes (e.g., during streaming or post-generation DOM updates)
    if (!statusObservers.has(mesId)) {
        textContainer.setAttribute('data-sillynpc-observed', 'true');
        const observer = new MutationObserver((records) => {
            // The tracker box is drawn inside .mes_text, so it is inside what this
            // watches. A change originating in it is never new message content: it is
            // either this function's own redraw, or somebody typing into an editable
            // cell - and rebuilding on that destroys the element being typed into, which
            // is why a field took one character per click and the whole box was rebuilt
            // on every keystroke.
            if (records.every(record => insideTracker(record.target))) return;

            observer.disconnect();
            try {
                processStatusUpdate(mesEl);
                renderStatusTrackerBox(mesEl);
            } finally {
                observer.observe(textContainer, { childList: true, subtree: true, characterData: true });
            }
        });
        observer.observe(textContainer, { childList: true, subtree: true, characterData: true });
        statusObservers.set(mesId, observer);
    }

    // Not while somebody is typing in the box on this message.
    //
    // The first line of the block below takes the box out, and renderStatusTrackerBox -
    // which is what puts it back - declines to run during an edit, so the two disagreed:
    // any redraw landing mid-edit removed the box and then left it removed. That is worse
    // than the rebuild the edit guard was added to prevent, and it is why editing a world
    // stat broke again.
    //
    // Returning rather than guarding only the removal, because the surgery further down
    // measures offsets into textContent and the box's own text would be inside them. The
    // observer above is already registered by this point, and a message being typed into
    // has been processed before or there would be no box to type into.
    if (isEditingInside(mesEl)) return;

    processingMessages.add(mesId);
    try {
        // Remove existing status tracker UI before reading textContent
        mesEl.querySelectorAll('.sillynpc-status-tracker-container').forEach(el => el.remove());

        // ── STRATEGY 1: Regex match on raw textContent (covers plain-text <status_update> tags) ──
        const text = textContainer.textContent;
        const { update: textUpdate, matchLength: textMatchLength } = parseMessageForUpdates(text);

        if (textMatchLength > 0) {
            const isWriting = mesEl.classList.contains('writing');
            if (!textUpdate && isWriting) {
                return;
            }

            const hasNewContent = !mesEl.hasAttribute('data-sillynpc-last-update-text') || mesEl.getAttribute('data-sillynpc-last-update-text') !== text;
            if (textUpdate && (!mesEl.hasAttribute('data-sillynpc-status-applied') || hasNewContent)) {
                applyUpdate(textUpdate);
                mesEl.setAttribute('data-sillynpc-status-applied', 'true');
                mesEl.setAttribute('data-sillynpc-last-update-text', text);
            }
            hideStatusDataSurgically(textContainer, textMatchLength);
            mesEl.setAttribute('data-sillynpc-status-hidden', 'true');
            // Take it out of the stored message too, not just the DOM: otherwise it is
            // saved to the chat and re-sent on every later turn.
            stripAndPersist(mesId);
            return;
        }

        // ── STRATEGY 2: Browser parsed <status_update> as a DOM element ──
        // When the markdown engine treats it as an unknown HTML tag, the literal
        // "<status_update>" string is absent from textContent, so the regex above fails.
        // We find the element directly and hide it in-place.
        const statusTagEl = textContainer.querySelector('status_update');
        if (statusTagEl) {
            debugLog('Found status_update as DOM element — hiding directly');
            const jsonStr = extractJSON(statusTagEl.textContent);
            const parsedUpdate = safeJsonParse(jsonStr);

            const isWriting = mesEl.classList.contains('writing');
            if (!parsedUpdate && isWriting) {
                return;
            }

            if (parsedUpdate && (parsedUpdate.global !== undefined || parsedUpdate.player !== undefined || parsedUpdate.characters !== undefined)) {
                const hasNewContent = !mesEl.hasAttribute('data-sillynpc-last-update-text') || mesEl.getAttribute('data-sillynpc-last-update-text') !== statusTagEl.textContent;
                if (!mesEl.hasAttribute('data-sillynpc-status-applied') || hasNewContent) {
                    applyUpdate(parsedUpdate);
                    mesEl.setAttribute('data-sillynpc-status-applied', 'true');
                    mesEl.setAttribute('data-sillynpc-last-update-text', statusTagEl.textContent);
                }
            }

            // Always hide the element directly — no offset math needed
            statusTagEl.style.display = 'none';
            statusTagEl.setAttribute('data-sillynpc-hidden', 'true');

            // Hide any "Reasoning:" prefix that precedes the element
            hideReasoningPrefixBefore(statusTagEl);

            mesEl.setAttribute('data-sillynpc-status-hidden', 'true');
            return;
        }

        // ── STRATEGY 3: Robust JSON root scan (fallback for untagged AI output) ──
        // The previous fallback used lastIndexOf('{', keyPos) which finds a *nested* '{',
        // not the root '{'. We now scan backward through all candidate '{' positions
        // until we find one that produces a valid root-level update object.
        const rootKeys = ['"global"', "'global'", '"player"', "'player'", '"characters"', "'characters'"];
        let earliestKeyIdx = Infinity;
        for (const key of rootKeys) {
            // Use indexOf (first occurrence) to find the outermost JSON key
            const idx = text.indexOf(key);
            if (idx !== -1 && idx < earliestKeyIdx) {
                earliestKeyIdx = idx;
            }
        }

        if (earliestKeyIdx !== Infinity) {
            // Scan backward from the earliest root key to find the true root '{'
            let searchPos = earliestKeyIdx;
            let foundUpdate = false;
            while (searchPos >= 0) {
                const bracePos = text.lastIndexOf('{', searchPos);
                if (bracePos === -1) break;

                const candidate = text.substring(bracePos);
                const extractedJson = extractJSON(candidate);
                const parsedCandidate = safeJsonParse(extractedJson);

                if (parsedCandidate && (parsedCandidate.global !== undefined || parsedCandidate.player !== undefined || parsedCandidate.characters !== undefined)) {
                    // Found a valid root-level update
                    foundUpdate = true;
                    const hasNewContent = !mesEl.hasAttribute('data-sillynpc-last-update-text') || mesEl.getAttribute('data-sillynpc-last-update-text') !== extractedJson;
                    if (!mesEl.hasAttribute('data-sillynpc-status-applied') || hasNewContent) {
                        applyUpdate(parsedCandidate);
                        mesEl.setAttribute('data-sillynpc-status-applied', 'true');
                        mesEl.setAttribute('data-sillynpc-last-update-text', extractedJson);
                    }
                    // Compute matchLength from bracePos, accounting for Reasoning: prefix
                    let startHideIndex = bracePos;
                    const prefix = text.substring(0, bracePos);
                    const reasoningRegex = /(?:\n|^)\s*Reasoning\s*:[\s\S]*$/gi;
                    const rm = prefix.match(reasoningRegex);
                    if (rm) {
                        const lastRmIdx = prefix.lastIndexOf(rm[rm.length - 1]);
                        const dist = prefix.length - lastRmIdx;
                        if (dist < 1000 && (dist + (text.length - bracePos)) < text.length * 0.8) {
                            startHideIndex = lastRmIdx;
                        }
                    }
                    hideStatusDataSurgically(textContainer, text.length - startHideIndex);
                    mesEl.setAttribute('data-sillynpc-status-hidden', 'true');
                    stripAndPersist(mesId);
                    return;
                }

                // Move search start back to before this brace
                searchPos = bracePos - 1;
            }

            // If we are still writing and haven't successfully parsed/applied an update yet,
            // return without hiding or setting hidden. Let it continue streaming!
            if (!foundUpdate && mesEl.classList.contains('writing')) {
                return;
            }
        }

    } finally {
        processingMessages.delete(mesId);
    }
}


/**
 * Hides status data by finding the tags/JSON in the text and removing it.
 * Uses a robust approach that maps textContent offsets to DOM nodes.
 * @param {Element} container The container to hide text from.
 * @param {number} lengthToHide The number of characters to hide from the end.
 */
function hideStatusDataSurgically(container, lengthToHide) {
    if (!lengthToHide || lengthToHide <= 0) return;

    const fullText = container.textContent;
    const totalLength = fullText.length;
    const startOffset = totalLength - lengthToHide;
    
    let currentOffset = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null, false);
    let node;
    const nodesToHide = [];
    let splitNode = null;
    let splitPoint = 0;
    let foundStart = false;

    while (node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE) {
            const len = node.nodeValue.length;
            
            if (!foundStart) {
                if (currentOffset + len > startOffset) {
                    splitNode = node;
                    splitPoint = startOffset - currentOffset;
                    foundStart = true;
                }
            } else {
                nodesToHide.push(node);
            }
            
            currentOffset += len;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();
            
            // If it's a known marker tag or we've passed the offset
            if (tagName === 'status_update' || foundStart || currentOffset >= startOffset) {
                // If it's a block element and we are at the start, we might want to hide the whole block
                // but only if it's not the container itself.
                if (node !== container) {
                    nodesToHide.push(node);
                    foundStart = true;
                }
            }
        }
    }

    if (splitNode) {
        splitNode.nodeValue = splitNode.nodeValue.substring(0, splitPoint);
    }

    for (const n of nodesToHide) {
        if (n.nodeType === Node.TEXT_NODE) {
            n.nodeValue = '';
        } else if (n.nodeType === Node.ELEMENT_NODE) {
            n.style.display = 'none';
            n.setAttribute('data-sillynpc-hidden', 'true');
        }
    }
    
    // Recursively hide siblings of hidden elements to be sure
    // and cleanup trailing artifacts.
    let current = container.lastChild;
    while (current) {
        const next = current.previousSibling;
        if (current.nodeType === Node.TEXT_NODE) {
            if (!current.nodeValue.trim()) {
                current.nodeValue = ''; 
                current = next;
                continue;
            }
            break;
        } else if (current.nodeType === Node.ELEMENT_NODE) {
            const tag = current.tagName;
            const isHidden = current.style.display === 'none' || current.getAttribute('data-sillynpc-hidden') === 'true';
            const isEmpty = current.textContent.trim() === '';
            
            // Only hide trailing BRs, empty elements, or elements already marked as hidden.
            // Do NOT hide non-empty P tags unless they were already hidden by the TreeWalker.
            if (tag === 'BR' || isHidden || isEmpty) {
                current.style.display = 'none';
                current.setAttribute('data-sillynpc-hidden', 'true');
                current = next;
                continue;
            }
            break;
        } else {
            break;
        }
    }
}

/**
 * Whether a rendered box has anything in it worth drawing.
 *
 * `.trim()` was the old test, and it answers the wrong question: a box stripped of its
 * header and its characters is still `<div class="sillynpc-status-box"></div>`, which is
 * not blank but has nothing in it. That combination is reachable - World Stats off, and
 * the eye on globals - and drew an empty bordered rectangle holding only its own buttons.
 *
 * @param {string} html
 * @returns {boolean}
 */
export function hasVisibleContent(html) {
    const text = String(html ?? '')
        // An <img> or a meter is content even though it contributes no text.
        .replace(/<(img|hr|input)\b[^>]*>/gi, 'x')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/gi, ' ');
    return text.trim().length > 0;
}

/**
 * Draws the tracker box again on every message, and nothing else.
 *
 * For a change to what is *shown* - the eye - rather than to what is tracked.
 * reprocessAllMessages() is the other option and does far more: it re-runs the speaker
 * decoration and the avatar injection over the whole chat, which a view toggle has no
 * business paying for.
 */
export function redrawStatusBoxes() {
    document.querySelectorAll('#chat .mes').forEach(mesEl => {
        try {
            renderStatusTrackerBox(mesEl);
        } catch (err) {
            console.error(LOG_PREFIX, 'redrawStatusBoxes failed for a message', err);
        }
    });
}

/**
 * Renders the status tracker UI box for a message.
 * Called AFTER character image injection.
 * @param {Element} mesEl 
 */
export function renderStatusTrackerBox(mesEl) {
    if (!mesEl.hasAttribute('mesid') || mesEl.closest('#welcome-message')) return;

    // Before the removal below, or the guard would take the box away and then decline to
    // put it back. Whatever wanted this redraw can have it when the edit is committed.
    if (isEditingInside(mesEl)) return;

    mesEl.querySelectorAll('.sillynpc-status-tracker-container').forEach(el => el.remove());

    const settings = getSettings().statusTracker;
    if (!settings.enabled) return;

    // The eye, in its third state. Before the review panel below on purpose: a change
    // waiting for a decision is not part of the tracker box and stays reachable either
    // way, which is the same reason that panel sits outside the early returns.
    const view = getTrackerView();

    const messageId = mesEl.getAttribute('mesid');

    // Before any of the early returns below. The status box is often hidden on this
    // message - "show only at the bottom" is the common case - but a change waiting for
    // a decision has to stay reachable under the message that proposed it, or it can
    // only be resolved by scrolling back to a panel that is no longer drawn.
    renderReviewPanel(mesEl, messageId);

    if (view === 'hidden') return;

    const context = getContext();
    const chat = (context && Array.isArray(context.chat)) ? context.chat : [];

    if (settings.showOnlyAtBottom) {
        const isLastMessage = chat.length > 0 ? Number(messageId) >= chat.length - 1 : true;
        if (!isLastMessage) return;
    }

    const textContainer = mesEl.querySelector('.mes_text');
    if (!textContainer) return;

    injectCustomCSS(settings.customCSS);

    // Under an older message, show what the tracker held *then*. Drawing the current
    // state under every message is what made "show under all messages" useless: a
    // message from two hundred turns ago claimed the HP the character has today.
    const past = settings.showOnlyAtBottom
        ? { state: loadStateFromMetadata(), exact: true, reason: 'latest' }
        : stateAtMessage(messageId);
    const state = past.state;
    // Only mark it when it genuinely differs from live; an exact reconstruction of the
    // latest message is just the current state.
    const reconstructed = past.reason !== 'latest';
    const htmlToRender = buildStatusHtml(state,
        view === 'globals' ? { ...settings, showCharacters: false } : settings);

    if (!hasVisibleContent(htmlToRender)) return;

    const theme = getSettings().menuStyle || 'default';
    const container = document.createElement('div');
    container.className = `sillynpc-status-tracker-container`;
    container.classList.add(`sillynpc-theme-${theme}`);
    
    const box = document.createElement('div');
    box.className = `sillynpc-status-box sillynpc-theme-${theme}`;
    
    // Add header buttons inside the box
    const headerBtns = document.createElement('div');
    headerBtns.className = 'sillynpc-status-buttons-container';

    // Undo is only offered when there is something to undo, so the button does not
    // sit there inert on a fresh chat.
    const historyDepth = getHistoryEntries().length;
    if (historyDepth > 0) {
        const undoBtn = document.createElement('div');
        undoBtn.className = 'sillynpc-status-undo-btn fa-solid fa-arrow-left';
        const nextLabel = getHistoryEntries().at(-1)?.label || 'change';
        undoBtn.title = `Undo last change (${nextLabel}) - ${historyDepth} step${historyDepth === 1 ? '' : 's'} available`;
        undoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const entry = undoLastChange();
            if (entry) {
                toastr.info(`Reverted: ${entry.label}`, 'SillyNPC');
            } else {
                toastr.warning('Nothing left to undo.', 'SillyNPC');
            }
        });
        headerBtns.appendChild(undoBtn);
    }

    // Beside the control that adds somebody, because it answers the opposite question.
    const castBtn = document.createElement('div');
    castBtn.className = 'sillynpc-status-cast-btn fa-solid fa-user-check';
    castBtn.title = 'Say who is not a character - the narrator\'s asides, or you';
    castBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openCastPanel(() => renderStatusTrackerBox(mesEl));
    });
    headerBtns.appendChild(castBtn);

    const addCharBtn = document.createElement('div');
    addCharBtn.className = 'sillynpc-status-add-btn fa-solid fa-plus';
    addCharBtn.title = 'Add Character to Scene';
    addCharBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showAddCharacterDropdown(addCharBtn, mesEl);
    });

    const settingsBtn = document.createElement('div');
    settingsBtn.className = 'sillynpc-status-settings-btn fa-solid fa-gear';
    settingsBtn.title = 'Open Status Tracker Settings';
    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        eventSource.emit('sillynpc-open-manage', { tab: 'status' });
    });

    headerBtns.appendChild(addCharBtn);
    headerBtns.appendChild(settingsBtn);
    box.appendChild(headerBtns);
    
    // Parse the HTML to nodes to safely append without destroying the button
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlToRender;
    while(tempDiv.firstChild) {
        box.appendChild(tempDiv.firstChild);
    }
    
    if (reconstructed) {
        container.classList.add('sillynpc-status-historical');
        container.title = past.exact
            ? 'The tracker as it stood at this message.'
            : 'Approximate: no record exists for the messages after this one.';
        if (!past.exact) container.classList.add('sillynpc-status-approximate');
    }

    container.appendChild(box);
    
    if (settings.renderPosition === 'top') {
        textContainer.prepend(container);
    } else {
        textContainer.appendChild(container);
    }

    attachInlineEditListeners(container);
}

function showAddCharacterDropdown(btn, mesEl) {
    if (!btn) return;
    const existing = document.querySelector('.sillynpc-add-char-dropdown');
    if (existing) {
        existing.remove();
        return;
    }

    const state = loadStateFromMetadata();
    const activeNames = new Set(state.characters.map(c => c.name.toLowerCase()));
    const allChars = getActiveCharacters();
    const available = allChars.filter(c => !activeNames.has(c.name.toLowerCase()));

    if (available.length === 0) return;

    const dropdown = document.createElement('div');
    dropdown.className = 'sillynpc-add-char-dropdown list-group';
    dropdown.style.cssText = 'position: absolute; background: var(--sillynpc-bg-primary); border: 1px solid var(--sillynpc-border); border-radius: 5px; padding: 5px; z-index: 1000; max-height: 200px; overflow-y: auto; box-shadow: 0 4px 6px rgba(0,0,0,0.3); font-size: 14px; min-width: 150px;';

    available.forEach(char => {
        const item = document.createElement('div');
        item.className = 'list-group-item';
        item.style.cssText = 'cursor: pointer; padding: 5px 10px; border-bottom: 1px solid var(--sillynpc-border);';
        item.textContent = char.name;
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            if (registerActiveCharacter(char.name)) {
                renderStatusTrackerBox(mesEl);
            }
            dropdown.remove();
        });
        dropdown.appendChild(item);
    });

    const closeDropdown = (e) => {
        if (!dropdown.contains(e.target) && e.target !== btn) {
            dropdown.remove();
            document.removeEventListener('click', closeDropdown);
        }
    };
    setTimeout(() => document.addEventListener('click', closeDropdown), 0);

    const rect = btn.getBoundingClientRect();
    if (rect) {
        dropdown.style.top = `${rect.bottom + window.scrollY + 5}px`;
        dropdown.style.left = `${rect.left + window.scrollX - 100}px`;
    }

    document.body.appendChild(dropdown);
}

function injectCustomCSS(css) {
    if (!css) return;
    let styleEl = document.getElementById('sillynpc-status-custom-css');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'sillynpc-status-custom-css';
        document.head.appendChild(styleEl);
    }
    if (styleEl.textContent !== css) {
        styleEl.textContent = css;
    }
}

/**
 * Compactly summarizes a collection for the UI.
 */
function summarizeCollectionUI(collectionId, items, settings) {
    if (!items?.length) return null;
    
    const colDef = settings.collections.find(c => c.id === collectionId);
    if (!colDef || colDef.visible === false) return null;

    const colName = colDef.name || collectionId;
    const threshold = settings.summaryThreshold || 5;
    const displayItems = items.slice(0, threshold);
    const remainingCount = items.length - displayItems.length;

    const itemStrings = displayItems.map(item => {
        const primaryField = colDef.fields.find(f => f.isPrimary) || { name: 'name' };
        let str = item[primaryField.name] || item.name || 'Unknown Item';
        const qtyField = colDef.fields.find(f => f.type === 'number' && ['quantity', 'qty', 'count'].includes(f.name));
        const qty = qtyField ? item[qtyField.name] : item.quantity;
        return (qty > 1) ? `${str} (x${qty})` : str;
    });

    let output = `<b>${escapeHtml(colName)}:</b> ${escapeHtml(itemStrings.join(', '))}`;
    if (remainingCount > 0) output += `, +${remainingCount} more...`;
    return output;
}

/**
 * Enhanced template engine for status box.
 */

/**
 * Portrait markup for a tracker row. Falls back to the built-in silhouette so a
 * character with no card still lines up with the others.
 */
function buildPortraitHtml(name) {
    const card = findCardForName(name);
    const src = card?.imageUrl || BUILT_IN_DEFAULT_AVATAR;
    return `<img class="sillynpc-status-portrait" src="${escapeHtml(src)}" alt="" `
        + `title="${escapeHtml(name)}" loading="lazy">`;
}

/**
 * Takes a field out of a template: the reference, and the layout written around it.
 *
 * A field renders from the field list now, in the order the builder shows it, so a
 * reference in a template is not where it goes - it is a leftover from when templates
 * placed fields by hand. Left alone it would print `HP []`, so the caption beside it
 * and any separator left dangling go with it.
 *
 * These four steps were already here, duplicated for global and character fields, and
 * used only when a field was hidden. Hiding a field and no longer placing one want
 * exactly the same surgery.
 *
 * @param {string} text A template, or one character row of it.
 * @param {string} name The field name.
 * @returns {string}
 */
function stripFieldReference(text, name) {
    if (!name) return text;
    const escaped = escapeRegExp(name);
    const at = (pattern) => new RegExp(pattern, 'gi');
    let out = text;

    // A conditional block goes whole, or removing its innards mangles what is left.
    out = out.replace(at(`{{#${escaped}}}[\\s\\S]*?{{\\/${escaped}}}`), '');
    // A caption written beside it. findTemplateLabels knows the bracket form -
    // `HP [{{Health}}]` - which the steps below never did: they were written when only
    // `Label:` existed, which is why an empty `HP []` was left behind.
    out = applyLabelFixes(out, findTemplateLabels(out, [name]));
    // And the colon form written across markup, which findTemplateLabels leaves alone
    // because it refuses to reach past a tag.
    out = out.replace(at(`(?:<[^>]+>)*[\\w\\s]+:(?:<\\/[^>]+>)?\\s*{{${escaped}}}\\s*(?:\\|\\s*)?`), '');
    // A separator with nothing left on one side of it.
    out = out.replace(at(`\\|\\s*{{${escaped}}}`), '');
    out = out.replace(at(`{{${escaped}}}\\s*\\|`), '');
    // And the reference itself.
    out = out.replace(at(`{{${escaped}}}`), '');

    return out;
}

/**
 * What to put between a row's own text and the fields appended after it.
 *
 * A row that already ends with a connector - `👤 Goblin —` - has said how it joins to
 * what follows, and adding a pipe after it reads as punctuation nobody wrote.
 */
function joinTo(text) {
    const trimmed = String(text ?? '').replace(/<[^>]*>\s*$/, '');
    return /[—–\-|:,]\s*$/.test(trimmed) ? ' ' : ' | ';
}

/**
 * Clears up what a stripped-out field leaves behind.
 *
 * A template written when references were placements wrapped them in markup and
 * separators: `<span class="sillynpc-stat-hp">HP [{{Health}}]</span> |`. Take the field
 * out and an empty shell and a stray pipe remain. This makes such a template readable;
 * Reset layout is how it becomes tidy.
 *
 * @param {string} text
 * @returns {string}
 */
function tidyLeftovers(text) {
    let out = text;
    // An inline element with nothing left in it.
    out = out.replace(/<(span|b|i|em|strong)\b[^>]*>\s*<\/\1>/gi, '');
    // Separators that now sit against each other, or against the end of a row.
    out = out.replace(/\|(\s*\|)+/g, '|');
    out = out.replace(/(^|>)(\s*)\|\s*/g, '$1$2');
    out = out.replace(/\s*\|\s*(<\/div>|$)/g, '$1');
    return out;
}
export function buildStatusHtml(state, settings) {
    try {
        let html = settings.template;

        // Stat replacement helper
        const replaceStatTag = (template, statDef, rawValue, type, index = null) => {
            const key = statDef.name;
            const dataIndex = index !== null ? ` data-index="${index}"` : '';
            const editable = `<span class="sillynpc-status-editable" data-type="${type}"${dataIndex} data-key="${escapeHtml(key)}" contenteditable="true">${escapeHtml(rawValue)}</span>`;

            // A 'bar' stat keeps its editable value but gains a gauge behind it. The
            // width is inline because it is per-value; everything else is themed CSS.
            let valueSpan = editable;
            if (statDef.type === 'bar') {
                const { percent, numeric } = computeStatBar({
                    rawValue,
                    min: statDef.min,
                    max: resolveMaxValue(statDef),
                });
                if (numeric) {
                    const slug = escapeHtml(String(key).toLowerCase().replace(/\s+/g, '-'));
                    valueSpan = `<span class="sillynpc-status-meter" data-stat="${slug}">`
                        + `<span class="sillynpc-status-meter-fill" style="width:${percent.toFixed(1)}%"></span>`
                        + `<span class="sillynpc-status-meter-text">${editable}</span>`
                        + `</span>`;
                }
            }
            
            const rendered = applyStatFormat(statDef.format, {
                value: valueSpan,
                name: escapeHtml(key),
                max: escapeHtml(resolveMaxValue(statDef) || ''),
            });
            
            const regex = new RegExp(`{{${escapeRegExp(key)}}}`, 'g');
            return template.replace(regex, rendered);
        };

        /**
         * Every visible field, in the order the builder lists them.
         *
         * One separator between entries and none in front, so a row that begins with
         * the set does not open with a stray pipe.
         */
        const renderFieldSet = (stats, valueFor, type, index = null) => stats
            .map(stat => replaceStatTag(`{{${stat.name}}}`, stat, valueFor(stat), type, index))
            .join(' | ');
        
        // Handle Global Stats Toggling
        if (!settings.showGlobalStats) {
            // Remove the entire header if it exists
            html = html.replace(/<div[^>]*class="[^"]*sillynpc-status-header[^"]*"[^>]*>[\s\S]*?<\/div>/s, '');
            // Also remove the divider if it follows
            html = html.replace(/<div[^>]*class="[^"]*sillynpc-status-divider[^"]*"[^>]*><\/div>/s, '');
        }

        // The eye's middle state: the world line without the character rows. Absent means
        // shown, so nothing already saved renders differently for having no opinion.
        if (settings.showCharacters === false) {
            // The mustache block first. It contains the per-character <div>, so once it is
            // gone the wrapper holds no nested div and can be matched to its own closing
            // tag - which is also how any heading somebody put inside it goes with it.
            html = html.replace(/{{#characters}}[\s\S]*?{{\/characters}}/g, '');
            html = html.replace(/<div[^>]*class="[^"]*sillynpc-status-characters[^"]*"[^>]*>[\s\S]*?<\/div>/s, '');
            // And the divider, which now rules off nothing - the same reason the header
            // above takes it when it goes.
            html = html.replace(/<div[^>]*class="[^"]*sillynpc-status-divider[^"]*"[^>]*><\/div>/s, '');
        }
        
        const renderedGlobalKeys = new Set();
        const renderedGlobalCollections = new Set();
        const hiddenGlobalKeys = new Set();
        
        const visibleGlobalStats = [];
        const globalStatsMap = new Map();
        settings.globalStats.forEach(stat => {
            if (!settings.showGlobalStats || stat.visible === false) {
                if (stat.name) {
                    hiddenGlobalKeys.add(stat.name.toLowerCase());
                    html = stripFieldReference(html, stat.name);
                }
            } else {
                visibleGlobalStats.push(stat);
                globalStatsMap.set(stat.name.toLowerCase(), stat);
            }
        });
        
        // A reference is no longer a placement. Every field renders from the list, in
        // the order the builder shows it, so a name typed into a template is a leftover
        // that would otherwise print its caption around nothing.
        visibleGlobalStats.forEach(stat => {
            html = stripFieldReference(html, stat.name);
        });
        html = tidyLeftovers(html);

        // Evaluate conditional blocks for global stats: {{#StatName}}...{{/StatName}}
        html = html.replace(/{{#([\s\S]*?)}}([\s\S]*?){{\/\1}}/g, (match, key, content) => {
            // Only process global keys here (character keys will be in the char template)
            if (key === 'characters') return match; // skip {{#characters}}
            const lowerKey = key.toLowerCase();
            if (hiddenGlobalKeys.has(lowerKey)) return '';
            
            const rawValue = state.global[key] || (globalStatsMap.get(lowerKey)?.defaultValue) || '';
            return rawValue ? content : '';
        });

        if (visibleGlobalStats.length > 0) {
            const globalSet = renderFieldSet(
                visibleGlobalStats,
                (stat) => state.global[stat.name] || stat.defaultValue || '',
                'global');

            if (html.includes('{{globals}}')) {
                // The template says where the set goes.
                html = html.replace(/{{globals}}/g, globalSet);
            } else if (html.includes('sillynpc-status-header')) {
                // No placeholder, so it goes at the end of the header - which is what
                // every template written before this one will do.
                html = html.replace(/(<div[^>]*class="[^"]*sillynpc-status-header[^"]*"[^>]*>)(.*?)(<\/div>)/s,
                    (match, open, content, close) => {
                        const existing = content.trim();
                        const insert = existing ? ' | ' + globalSet : globalSet;
                        return `${open}${content}${insert}${close}`;
                    });
            } else if (html.includes('sillynpc-status-box')) {
                const headerHtml = `<div class="sillynpc-status-header">${globalSet}</div>\n    <div class="sillynpc-status-divider"></div>`;
                html = html.replace(/(<div[^>]*class="[^"]*sillynpc-status-box[^"]*"[^>]*>)/s, `$1\n    ${headerHtml}`);
            } else {
                html = `<div class="sillynpc-status-header">${globalSet}</div>\n<div class="sillynpc-status-divider"></div>\n` + html;
            }

            visibleGlobalStats.forEach(s => renderedGlobalKeys.add(s.name.toLowerCase()));
        }

        // Handle Player Collections in Template
        if (state.player && state.player.collections) {
            for (const [colId, items] of Object.entries(state.player.collections)) {
                const colDef = settings.collections.find(c => c.id === colId);
                if (colDef && colDef.visible === false) continue;

                const colRegex = new RegExp(`{{${escapeRegExp(colId)}}}`, 'g');
                if (html.includes(`{{${colId}}}`)) {
                    const summary = summarizeCollectionUI(colId, items, settings);
                    html = html.replace(colRegex, summary || '');
                    renderedGlobalCollections.add(colId.toLowerCase());
                }
            }
        }

        // Handle missing defined player collections (appended to top or wherever player data is)
        const missingDefinedPlayerCollections = settings.collections.filter(col => 
            (col.target === 'player' || col.target === 'all') && 
            col.visible !== false && 
            !renderedGlobalCollections.has(col.id.toLowerCase())
        );

        if (missingDefinedPlayerCollections.length > 0) {
            const extraPlayerColHtml = missingDefinedPlayerCollections.map(col => {
                const items = (state.player && state.player.collections && state.player.collections[col.id]) || [];
                const summary = summarizeCollectionUI(col.id, items, settings);
                return summary ? ` | ${summary}` : '';
            }).join('');
            
            // Heuristic: Append player collections after player stats if we can find a place,
            // or just to the header/box.
            if (html.includes('sillynpc-status-box')) {
                 // Append before characters section
                 html = html.replace(/({{#characters}})/, (match) => {
                     return extraPlayerColHtml + "\n    " + match;
                 });
            }
        }
        
        // Also add any unknown AI global keys that are in state but not in settings
        const unknownGlobalKeys = state.global ? Object.keys(state.global).filter(k => {
            const lower = k.toLowerCase();
            return !renderedGlobalKeys.has(lower) && !hiddenGlobalKeys.has(lower);
        }) : [];
        
        if (unknownGlobalKeys.length > 0 && settings.showGlobalStats) {
            const unknownGlobalHtml = unknownGlobalKeys.map(k => {
                const val = state.global[k] || '';
                return ` | <i>${escapeHtml(k)}</i> [<span class="sillynpc-status-editable" data-type="global" data-key="${escapeHtml(k)}" contenteditable="true">${escapeHtml(val)}</span>]`;
            }).join('');
            
            if (html.includes('sillynpc-status-header')) {
                html = html.replace(/(<div[^>]*class="[^"]*sillynpc-status-header[^"]*"[^>]*>)(.*?)(<\/div>)/s, (match, open, content, close) => {
                    const cleanContent = content.trim();
                    const insert = cleanContent ? unknownGlobalHtml : unknownGlobalHtml.substring(3);
                    return `${open}${content}${insert}${close}`;
                });
            } else if (html.includes('sillynpc-status-box')) {
                const headerHtml = `<div class="sillynpc-status-header">${unknownGlobalHtml.substring(3)}</div>\n    <div class="sillynpc-status-divider"></div>`;
                html = html.replace(/(<div[^>]*class="[^"]*sillynpc-status-box[^"]*"[^>]*>)/s, `$1\n    ${headerHtml}`);
            } else {
                html = `<div class="sillynpc-status-header">${unknownGlobalHtml.substring(3)}</div>\n<div class="sillynpc-status-divider"></div>\n` + html;
            }
        }

        const charMatch = html.match(/{{#characters}}([\s\S]*?){{\/characters}}/);
        if (charMatch) {
            let charTemplate = charMatch[1].trim() || '';
            let charsHtml = '';
            
            const hiddenCharKeys = new Set();
            const visibleCharStats = [];
            
            settings.npcStats.forEach(stat => {
                if (stat.visible === false) {
                    if (stat.name) {
                        hiddenCharKeys.add(stat.name.toLowerCase());
                        charTemplate = stripFieldReference(charTemplate, stat.name);
                    }
                } else {
                    visibleCharStats.push(stat);
                }
            });

            // On the template, before anything is put into it.
            //
            // Neither step looks at the character - they only take field references out of
            // the layout - and running them per row meant tidyLeftovers saw the remove
            // button and the portrait. Its "drop an inline element with nothing in it"
            // rule then deleted the button, because a Font Awesome icon is exactly that:
            // an empty <i>. Doing it here also does it once instead of once per character.
            visibleCharStats.forEach(stat => {
                charTemplate = stripFieldReference(charTemplate, stat.name);
            });
            charTemplate = tidyLeftovers(charTemplate);

            state.characters.forEach((char, index) => {
                try {
                    let charRow = charTemplate;
                    const removeBtnHtml = `<i class="sillynpc-char-remove fa-solid fa-minus" data-name="${escapeHtml(char.name)}" title="Remove ${escapeHtml(char.name)} from scene" style="cursor: pointer; opacity: 0.5; margin-right: 4px; font-size: 0.8em; z-index: 2; position: relative;"></i>`;
                    
                    if (/(<[^>]+>)/.test(charRow)) {
                        charRow = charRow.replace(/(<[^>]+>)/, `$1${removeBtnHtml}`);
                    } else {
                        charRow = removeBtnHtml + charRow;
                    }
                    
                    // Portraits are resolved before {{name}} is substituted, so the
                    // implicit placement below can still find the token.
                    if (charTemplate.includes('{{portrait}}')) {
                        charRow = charRow.replace(/{{portrait}}/g, buildPortraitHtml(char.name));
                    } else if (settings.showNpcPortraits) {
                        // Templates written before portraits existed get one in front of
                        // the name, so the feature works without editing the template.
                        charRow = charRow.replace(/{{name}}/, buildPortraitHtml(char.name) + '{{name}}');
                    }

                    // Always ensure name is replaced
                    charRow = charRow.replace(/{{name}}/g, escapeHtml(char.name));
                    
                    const renderedCharKeys = new Set();
                    const renderedCharCollections = new Set();

                    if (visibleCharStats.length > 0) {
                        const fieldSet = renderFieldSet(
                            visibleCharStats,
                            (stat) => (char.stats && char.stats[stat.name]) || stat.defaultValue || '',
                            'character', index);

                        if (charRow.includes('{{fields}}')) {
                            // The template says where the set goes.
                            charRow = charRow.replace(/{{fields}}/g, fieldSet);
                        } else if (/(<\/div>\s*)$/.test(charRow)) {
                            // Before the trailing whitespace and </div>, or SillyTavern
                            // adds a <br> where the row used to end.
                            charRow = charRow.replace(/(\s*)(<\/div>\s*)$/, (match, space, div) => {
                                const upTo = charRow.slice(0, charRow.length - match.length);
                                return joinTo(upTo) + fieldSet + space + div;
                            });
                        } else {
                            charRow = charRow.trim() + joinTo(charRow) + fieldSet;
                        }

                        visibleCharStats.forEach(s => renderedCharKeys.add(s.name.toLowerCase()));
                    }

                    const unknownAIKeys = char.stats ? Object.keys(char.stats).filter(k => {
                        const lower = k.toLowerCase();
                        return !renderedCharKeys.has(lower) && !hiddenCharKeys.has(lower);
                    }) : [];
                    
                    if (unknownAIKeys.length > 0) {
                        const unknownCharHtml = unknownAIKeys.map(k => {
                            const val = char.stats[k] || '';
                            return ` | <i>${escapeHtml(k)}</i> [<span class="sillynpc-status-editable" data-type="character" data-index="${index}" data-key="${escapeHtml(k)}" contenteditable="true">${escapeHtml(val)}</span>]`;
                        }).join('');
                        if (/(<\/div>\s*)$/.test(charRow)) {
                            // Inject BEFORE the trailing whitespace and </div> to prevent ST from adding a <br>
                            charRow = charRow.replace(/(\s*)(<\/div>\s*)$/, (match, space, div) => {
                                return unknownCharHtml + space + div;
                            });
                        } else {
                            charRow = charRow.trim() + unknownCharHtml;
                        }
                        unknownAIKeys.forEach(k => renderedCharKeys.add(k.toLowerCase()));
                    }

                    // Handle Character Collections in Template
                    if (char.collections) {
                        for (const [colId, items] of Object.entries(char.collections)) {
                            const colDef = settings.collections.find(c => c.id === colId);
                            if (colDef && colDef.visible === false) continue;

                            const colRegex = new RegExp(`{{${escapeRegExp(colId)}}}`, 'g');
                            if (charTemplate.includes(`{{${colId}}}`)) {
                                const summary = summarizeCollectionUI(colId, items, settings);
                                charRow = charRow.replace(colRegex, summary || '');
                                renderedCharCollections.add(colId.toLowerCase());
                            }
                        }
                    }

                    // Handle missing defined collections
                    const missingDefinedCharCollections = settings.collections.filter(col => 
                        (col.target === 'npc' || col.target === 'all') && 
                        col.visible !== false && 
                        !renderedCharCollections.has(col.id.toLowerCase())
                    );

                    if (missingDefinedCharCollections.length > 0) {
                        const extraColHtml = missingDefinedCharCollections.map(col => {
                            const items = (char.collections && char.collections[col.id]) || [];
                            const summary = summarizeCollectionUI(col.id, items, settings);
                            return summary ? ` | ${summary}` : '';
                        }).join('');

                        if (/(<\/div>\s*)$/.test(charRow)) {
                            charRow = charRow.replace(/(\s*)(<\/div>\s*)$/, (match, space, div) => {
                                return extraColHtml + space + div;
                            });
                        } else {
                            charRow = charRow.trim() + extraColHtml;
                        }
                    }

                    charRow = charRow.replace(/{{#([\s\S]*?)}}([\s\S]*?){{\/\1}}/g, (match, key, content) => {
                        if (hiddenCharKeys.has(key.toLowerCase())) return '';
                        return (char.stats && char.stats[key] || '') ? content : '';
                    });
                    
                    charsHtml += charRow;
                } catch (charErr) {
                    console.error(LOG_PREFIX, 'Error building status HTML for char', char, charErr);
                }
            });
            
            html = html.replace(charMatch[0], charsHtml);
        }

        // Cleanup any dangling pipes left by stripped tags
        html = html.replace(/\|\s*\|/g, '|');
        html = html.replace(/\|\s*(<\/div>)/g, '$1');
        html = html.replace(/(<div[^>]*>)\s*\|/g, '$1');

        return html;
    } catch (err) {
        console.error(LOG_PREFIX, 'Error in buildStatusHtml', err);
        return '';
    }
}

function attachInlineEditListeners(container) {
    container.querySelectorAll('.sillynpc-status-editable').forEach(el => {
        el.addEventListener('blur', () => {
            const type = el.dataset.type;
            const key = el.dataset.key;
            const newValue = el.innerText.trim();
            const updateObj = {};
            if (type === 'global') {
                updateObj.global = { [key]: newValue };
            } else if (type === 'character') {
                const index = parseInt(el.dataset.index);
                const state = loadStateFromMetadata();
                if (state.characters[index]) {
                    updateObj.characters = [{
                        name: state.characters[index].name,
                        stats: { [key]: newValue }
                    }];
                }
            }
            applyUpdate(updateObj);
        });
        el.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault();
                el.blur();
            }
        });
        el.addEventListener('keypress', (e) => {
            e.stopPropagation();
        });
        el.addEventListener('keyup', (e) => {
            e.stopPropagation();
        });
        el.addEventListener('input', (e) => {
            e.stopPropagation();
        });
    });

    container.querySelectorAll('.sillynpc-char-remove').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const name = el.dataset.name;
            if (removeActiveCharacter(name)) {
                const mesEl = container.closest('.mes');
                if (mesEl) renderStatusTrackerBox(mesEl);
            }
        });
    });
}


