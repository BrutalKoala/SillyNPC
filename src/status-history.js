import { getContext } from '../../../../st-context.js';
import { getSettings } from './settings.js';
import { debugLog } from './constants.js';
import { parseMessageForUpdates } from './status-logic.js';

/**
 * Keeping tracker data out of the transcript.
 *
 * The extension used to hide its status blocks in the DOM only - nothing ever wrote back
 * to message.mes - so every block was saved to the chat file and re-sent to the model on
 * every later turn. On a real 317-message chat that came to ~179,000 tokens, 71% of the
 * whole transcript.
 *
 * It also taught the model to keep producing them: with 157 previous messages ending in a
 * status block, the pattern is overwhelming in-context evidence, which is why blocks kept
 * appearing even after the instructions were removed from the prompt.
 *
 * The removed text is kept on message.extra, which SillyTavern does not put in the prompt
 * (only extra.reasoning and extra.bias are read), so nothing is lost and nothing is spent.
 */

/** Where the removed block is preserved on a message. */
export const RAW_STATUS_KEY = 'sillynpc_status_raw';

/** Rough token estimate. Good enough for reporting a saving, not for budgeting. */
export function estimateTokens(chars) {
    return Math.round(chars / 4);
}

/**
 * Removes a trailing status block from one message, preserving it on `extra`.
 *
 * Cleans the swipe that mirrors the message too: SillyTavern keeps
 * `swipes[swipe_id]` in step with `mes`, so leaving it alone would let a swipe back
 * restore the block.
 *
 * @param {object} message A SillyTavern chat message.
 * @returns {{ changed: boolean, removedChars: number }}
 */
export function stripStatusBlockFromMessage(message) {
    if (!message || typeof message.mes !== 'string' || !message.mes) {
        return { changed: false, removedChars: 0 };
    }

    const original = message.mes;
    const { cleanedText, matchLength } = parseMessageForUpdates(original);
    if (!matchLength || matchLength <= 0 || cleanedText === original) {
        return { changed: false, removedChars: 0 };
    }

    const removed = original.slice(cleanedText.length);

    message.mes = cleanedText;
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    // Always the most recent block. An already-clean message returns early above, so
    // this is only reached when a genuinely new block appeared - after a regenerate or
    // an edit - and that one is the relevant payload for a later re-sync.
    message.extra[RAW_STATUS_KEY] = removed;

    if (Array.isArray(message.swipes)) {
        const index = Number(message.swipe_id);
        if (Number.isInteger(index) && typeof message.swipes[index] === 'string'
            && message.swipes[index] === original) {
            message.swipes[index] = cleanedText;
        }
    }

    return { changed: true, removedChars: removed.length };
}

/**
 * The raw block previously removed from a message, if any.
 * Lets "re-sync from this message" keep working once the text has been cleaned.
 */
export function getPreservedStatusRaw(message) {
    return message?.extra?.[RAW_STATUS_KEY] || '';
}

/**
 * Strips a message in place and persists the chat, honouring the user's setting.
 * Safe to call on every rendered message: a message with no block is left untouched
 * and nothing is written.
 *
 * @param {string|number} messageId
 * @returns {boolean} True when the message was changed.
 */
export function stripAndPersist(messageId) {
    if (getSettings().statusTracker?.stripStatusFromHistory === false) return false;

    const context = getContext();
    const message = context?.chat?.[Number(messageId)];
    if (!message) return false;

    const { changed, removedChars } = stripStatusBlockFromMessage(message);
    if (!changed) return false;

    debugLog(`Removed ${removedChars} chars of tracker data from message ${messageId}`);
    context.saveChat?.();
    return true;
}

/**
 * Measures how much of the current chat is tracker data.
 * @returns {{ messages: number, totalChars: number, blockChars: number, blockMessages: number }}
 */
export function measureChatOverhead() {
    const chat = getContext()?.chat || [];
    let totalChars = 0;
    let blockChars = 0;
    let blockMessages = 0;

    for (const message of chat) {
        if (typeof message?.mes !== 'string') continue;
        totalChars += message.mes.length;
        const { cleanedText, matchLength } = parseMessageForUpdates(message.mes);
        if (matchLength > 0 && cleanedText !== message.mes) {
            blockChars += matchLength;
            blockMessages++;
        }
    }

    return { messages: chat.length, totalChars, blockChars, blockMessages };
}

/**
 * Strips tracker data from every message in the current chat.
 *
 * Idempotent - a second run finds nothing to do. Saves once at the end rather than per
 * message, so a long chat is a single write.
 *
 * @returns {{ cleaned: number, removedChars: number }}
 */
export function cleanChatHistory() {
    const context = getContext();
    const chat = context?.chat || [];

    let cleaned = 0;
    let removedChars = 0;
    for (const message of chat) {
        const { changed, removedChars: n } = stripStatusBlockFromMessage(message);
        if (changed) { cleaned++; removedChars += n; }
    }

    if (cleaned > 0) context.saveChat?.();
    return { cleaned, removedChars };
}
