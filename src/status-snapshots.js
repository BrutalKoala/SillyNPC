import { getContext } from '../../../../st-context.js';
import { getSettings } from './settings.js';
import { debugLog } from './constants.js';
import {
    loadStateFromMetadata, parseMessageForUpdates,
    saveStateToMetadata, syncPlayerToMaster, getSwipeBase,
} from './status-logic.js';
import { eventSource } from '../../../../events.js';
import { getPreservedStatusRaw } from './status-history.js';
import { splitValue } from './utils.js';
import { addThread, closeThread } from './threads.js';

/**
 * What the tracker looked like when a given message was written.
 *
 * The status box has always drawn the *current* state, so turning it on under every
 * message repeated today's numbers all the way down the chat - a message from two
 * hundred turns ago claiming the HP the character has now. There was nothing else it
 * could do: no record of the past was ever kept.
 *
 * Rather than store a full state per message, this records what each message *changed* -
 * the same rows the review gate already computes - and reconstructs the past by walking
 * backwards from the present, undoing one message at a time. A delta is a few hundred
 * bytes where a state clone is tens of kilobytes.
 *
 * It lives on message.extra, which SillyTavern does not put in the prompt: only
 * extra.reasoning and extra.bias are ever read back. So this is a save, not context - it
 * costs nothing per message and the model never sees it.
 */

/** Where a message's applied changes are recorded. */
export const APPLIED_KEY = 'sillynpc_applied';
/** What a message opened or settled among the threads. See recordThreadChanges. */
export const THREADS_KEY = 'sillynpc_threads';

function messageAt(messageId) {
    return getContext()?.chat?.[Number(messageId)] ?? null;
}

/**
 * Saving the chat is not cheap - the whole file is serialised and posted, and a long
 * chat is well over a megabyte. Writing it once per record, on top of the write the
 * review already asks for and SillyTavern's own, meant several full writes per message.
 *
 * These records are a convenience, so a short delay costs nothing if the page goes away
 * first; the flush on unload means it usually does not.
 */
const SAVE_DELAY_MS = 1500;
let saveTimer = null;

export function saveChatSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        getContext()?.saveChat?.();
    }, SAVE_DELAY_MS);
}

/** Writes immediately if a save is pending. */
function flushPendingSave() {
    if (!saveTimer) return false;
    clearTimeout(saveTimer);
    saveTimer = null;
    getContext()?.saveChat?.();
    return true;
}

// A pending record must not be lost to a reload or a chat switch.
if (typeof window?.addEventListener === 'function') {
    window.addEventListener('beforeunload', flushPendingSave);
}

/**
 * Keeps only what an undo needs. The full row also carries a reason string and, for
 * stat rows, a copy of the item, which are useful in the review panel and dead weight
 * in every message forever.
 */
function trimRow(row) {
    const out = {
        scope: row.scope, kind: row.kind, label: row.label,
        before: row.before, after: row.after,
    };
    if (row.actor) out.actor = row.actor;
    if (row.collectionId) out.collectionId = row.collectionId;
    if (row.field) out.field = row.field;
    // An item row has to carry the item itself, or putting it back is impossible.
    if (row.item && (row.kind === 'item-add' || row.kind === 'item-remove')) out.item = row.item;
    return out;
}

/**
 * Records what a message actually changed.
 *
 * Always writes, even when nothing changed: an absent property means the message
 * predates this feature and the chain cannot be walked through it, while an empty array
 * means the message genuinely changed nothing. Without that distinction a quiet message
 * is indistinguishable from a gap in the record.
 *
 * @param {string|number} messageId
 * @param {Array<object>} changes Rows that were applied, from computeStateDiff.
 */
export function recordAppliedChanges(messageId, changes) {
    if (getSettings().statusTracker?.recordMessageHistory === false) return false;

    const message = messageAt(messageId);
    if (!message) return false;
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};

    const rows = (changes || []).map(trimRow);
    const existing = message.extra[APPLIED_KEY];
    // A reviewed change lands after the automatic part of the same message, so append
    // rather than replace, or the earlier half is forgotten.
    message.extra[APPLIED_KEY] = Array.isArray(existing) ? existing.concat(rows) : rows;

    invalidateTimeline();
    saveChatSoon();
    return true;
}

/** The rows recorded for a message, or null when it has no record at all. */
export function getAppliedChanges(messageId) {
    const applied = messageAt(messageId)?.extra?.[APPLIED_KEY];
    return Array.isArray(applied) ? applied : null;
}

/**
 * What a message did to the threads, filed on the message itself.
 *
 * Everything else a message changes is already recorded here as rows, and rebaseToSwipe
 * rebuilds a swipe from the base plus those rows. Threads were not recorded anywhere per
 * message - they lived only in state.threads - so the rebuild's structuredClone dropped
 * them, and the extraction guard, keyed on message and swipe together, then refused to
 * read that swipe again. Swipe away and back and the promise was gone for good: the one
 * path where the numbers were safe and the threads were not.
 *
 * Both halves, not only the openings. A swipe that settled something has to settle it
 * again on the way back, or returning to it quietly reopens what it closed.
 *
 * @param {string|number} messageId
 * @param {{ opened?: object[], closed?: string[] }} changes
 */
export function recordThreadChanges(messageId, { opened = [], closed = [] } = {}) {
    if (!opened.length && !closed.length) return false;
    if (getSettings().statusTracker?.recordMessageHistory === false) return false;

    const message = messageAt(messageId);
    if (!message) return false;
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};

    const existing = message.extra[THREADS_KEY];
    // Appended for the same reason the rows are: one message can write threads more than
    // once, and replacing would forget the earlier half.
    message.extra[THREADS_KEY] = {
        opened: (existing?.opened || []).concat(opened),
        closed: (existing?.closed || []).concat(closed),
    };

    saveChatSoon();
    return true;
}

/** What a message did to the threads, or null when it did nothing. */
export function getThreadChanges(messageId) {
    const record = messageAt(messageId)?.extra?.[THREADS_KEY];
    if (!record || typeof record !== 'object') return null;
    return {
        opened: Array.isArray(record.opened) ? record.opened : [],
        closed: Array.isArray(record.closed) ? record.closed : [],
    };
}

const INVERSE_KIND = {
    'item-add': 'item-remove',
    'item-remove': 'item-add',
};

/** The row that undoes this one. */
function invert(row) {
    return {
        ...row,
        kind: INVERSE_KIND[row.kind] || row.kind,
        before: row.after,
        after: row.before,
    };
}

function actorFor(state, row) {
    if (row.scope === 'player') return state.player;
    if (row.scope === 'character') {
        return (state.characters || []).find(
            c => String(c.name).toLowerCase() === String(row.actor).toLowerCase());
    }
    return null;
}

function primaryOf(collectionId) {
    const colDef = (getSettings().statusTracker.collections || []).find(c => c.id === collectionId);
    return colDef?.fields?.find(f => f.isPrimary)?.name || 'name';
}

/** Rejoins a half onto the value already in place, so undoing a max keeps the current. */
function joinValue(live, row) {
    const { current, max } = splitValue(live);

    if (row.kind === 'stat') return max ? `${row.after}/${max}` : String(row.after);
    if (!row.after || row.after === '(none)') return current;
    return `${current}/${row.after}`;
}

/**
 * Applies rows to a state object in place.
 *
 * Pure with respect to storage - nothing is saved, synced or emitted - because this only
 * ever builds a view of the past.
 */
function applyRows(state, rows) {
    for (const row of rows) {
        if (row.kind === 'stat' || row.kind === 'stat-max') {
            if (row.scope === 'global') {
                state.global ||= {};
                state.global[row.label] = joinValue(state.global[row.label], row);
                continue;
            }
            const statActor = actorFor(state, row);
            if (!statActor) continue;
            statActor.stats ||= {};
            statActor.stats[row.label] = joinValue(statActor.stats[row.label], row);
            continue;
        }

        const actor = actorFor(state, row);
        if (!actor || !row.collectionId) continue;
        actor.collections ||= {};
        const items = actor.collections[row.collectionId] ||= [];
        const primary = primaryOf(row.collectionId);
        const keyOf = (item) => String(item?.[primary] ?? item?.name ?? '').toLowerCase();
        const wanted = row.item ? keyOf(row.item) : String(row.label).toLowerCase();
        const index = items.findIndex(i => keyOf(i) === wanted);

        if (row.kind === 'item-add' && index === -1 && row.item) items.push({ ...row.item });
        else if (row.kind === 'item-remove' && index !== -1) items.splice(index, 1);
        else if (row.kind === 'item-change' && index !== -1) items[index][row.field] = row.after;
    }
    return state;
}

/**
 * Reads a status block that was stripped out of a message back when the tracker wrote
 * one into the reply itself. Those blocks are still on disk in extra.sillynpc_status_raw,
 * and unlike a delta they are a real snapshot of that moment.
 */
function historicalStateFromBlock(message, fallback) {
    const raw = getPreservedStatusRaw(message);
    if (!raw) return null;
    try {
        const { updates } = parseMessageForUpdates(raw);
        if (!updates) return null;
        const state = structuredClone(fallback);
        // A block states values outright rather than as changes, so merge it over a copy.
        if (updates.global) Object.assign(state.global, updates.global);
        if (updates.player?.stats) Object.assign(state.player.stats, updates.player.stats);
        return state;
    } catch (err) {
        debugLog('Could not read a preserved status block', err);
        return null;
    }
}

/**
 * Every message's state, from one walk backwards through the chat.
 *
 * Asking per message and walking to it each time is O(n squared): with the box shown
 * under all messages, a 321-message chat spent 538ms rebuilding the same history over
 * and over, on every re-render, and the tracker re-renders on every status update. One
 * pass produces all of them.
 *
 * @type {{ key: string, states: Map<number, {state: object, exact: boolean, reason: string}> } | null}
 */
let timeline = null;

/** Changes whenever a rebuild is needed: a different chat, a new message, a new state. */
function timelineKey(chat, current) {
    const context = getContext();
    const chatId = context?.getCurrentChatId?.() ?? context?.chatId ?? '';
    return `${chatId}|${chat.length}|${current?.timestamp ?? 0}`;
}

/** Throws the cached timeline away. */
export function invalidateTimeline() {
    timeline = null;
}

function buildTimeline(chat, current) {
    const states = new Map();
    const last = chat.length - 1;

    let running = structuredClone(current);
    let exact = true;
    let reason = 'reconstructed';

    for (let i = last; i >= 0; i--) {
        // Only worth consulting a preserved block once the delta chain has broken: while
        // it is intact it is authoritative, and parsing 157 blocks of old status output
        // to confirm what we already know is the expensive way to learn nothing.
        if (!exact) {
            const preserved = historicalStateFromBlock(chat[i], current);
            if (preserved) {
                running = preserved;
                exact = true;
                reason = 'preserved-block';
            }
        }

        states.set(i, {
            state: structuredClone(running),
            exact,
            reason: i === last ? 'latest' : reason,
        });

        const rows = getAppliedChanges(i);
        if (rows === null) {
            // Older than the record. Everything before this is an approximation, and is
            // reported as one rather than presented as fact.
            exact = false;
            reason = 'no record before this point';
            continue;
        }
        applyRows(running, rows.map(invert));
    }

    return states;
}

/**
 * What the player looked like after each message, newest first.
 *
 * For choosing a point to go back to. Only messages where the player's stats actually
 * differ from the message after them are listed, since a hundred entries reading the same
 * is not a choice.
 *
 * @param {number} [limit] How many distinct points to return.
 * @returns {{ messageId: number, exact: boolean, stats: object, itemCount: number }[]}
 */
export function playerHistory(limit = 40) {
    const chat = getContext()?.chat || [];
    const points = [];
    let lastSeen = null;

    for (let i = chat.length - 1; i >= 0 && points.length < limit; i--) {
        const past = stateAtMessage(i);
        const player = past?.state?.player;
        if (!player) continue;

        const signature = JSON.stringify([player.stats, player.collections]);
        if (signature === lastSeen) continue;
        lastSeen = signature;

        points.push({
            messageId: i,
            exact: past.exact,
            stats: structuredClone(player.stats || {}),
            itemCount: Object.values(player.collections || {})
                .reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0),
        });
    }
    return points;
}

/**
 * Puts the player's stats and collections back to what they were after a message.
 *
 * The recovery that already existed and had no way in. When a story's HP and Energy were
 * overwritten, the per-message records were the only surviving copy and reading them was
 * a manual dig through the chat file; the ten-slot persona ring that was supposed to be
 * the safety net held nothing, because it only recorded when an item count dropped.
 *
 * The player half only. The NPCs and the world have carried on since, and were not what
 * was lost - rolling those back would trade one kind of damage for another. It lands as
 * an ordinary undo step, so getting the wrong message is itself reversible.
 *
 * @param {string|number} messageId
 * @returns {{ exact: boolean, reason: string }|null} Null when there is nothing to restore.
 */
export function restorePlayerFromMessage(messageId) {
    const past = stateAtMessage(messageId);
    if (!past?.state?.player) return null;

    const current = loadStateFromMetadata();
    if (!current?.player) return null;

    // Built as a copy rather than edited in place. The undo step records whatever is in
    // metadata at save time, and the live state *is* that object - changing it first would
    // file the new values as the thing to go back to, quietly making this the one action
    // that cannot be undone.
    const state = structuredClone(current);
    state.player.stats = structuredClone(past.state.player.stats || {});
    state.player.collections = structuredClone(past.state.player.collections || {});

    saveStateToMetadata(state, { label: `Player restored from message ${messageId}` });
    // Authoritative: this is a decision, so the seed for future chats follows it rather
    // than merging what was just deliberately rolled back.
    syncPlayerToMaster(state, { authoritative: true });
    eventSource.emit('sillynpc-status-updated', state);

    debugLog(`Player state restored from message ${messageId}`, past);
    return { exact: past.exact, reason: past.reason };
}

/**
 * The state as it stood after the given message.
 *
 * @param {string|number} messageId
 * @returns {{ state: object, exact: boolean, reason: string }}
 */
export function stateAtMessage(messageId) {
    const current = loadStateFromMetadata();
    const index = Number(messageId);
    const chat = getContext()?.chat || [];

    if (!Number.isInteger(index) || index >= chat.length - 1 || chat.length === 0) {
        return { state: current, exact: true, reason: 'latest' };
    }

    const key = timelineKey(chat, current);
    if (!timeline || timeline.key !== key) {
        timeline = { key, states: buildTimeline(chat, current) };
    }

    return timeline.states.get(index) ?? { state: current, exact: false, reason: 'not in this chat' };
}

/**
 * Puts the tracker back in step with the swipe now on screen.
 *
 * Swiping replaces the newest reply. The changes already applied describe the reply that
 * was there before, so the state is rebuilt from what it was before that message and the
 * chosen swipe's own record is applied to it. Nothing is inverted: by the time
 * MESSAGE_SWIPED fires SillyTavern has already swapped `extra` to the incoming swipe, so
 * the outgoing swipe's rows are no longer readable - and rebuilding from a known base is
 * both simpler and exact.
 *
 * A swipe with no record of its own leaves the state at the base. That is the right answer
 * for a swipe about to be generated: the extraction that follows applies to the base
 * rather than stacking on the swipe you left.
 *
 * @param {string|number} messageId
 * @returns {{ rebased: boolean, reason: string }}
 */
export function rebaseToSwipe(messageId) {
    const base = getSwipeBase(messageId);
    if (!base) {
        // Missing after a reload, or for a message written before this existed. Applying
        // the chosen swipe's changes on top of the state as it stands would double-count
        // the swipe already in it, which is the fault this exists to prevent.
        return { rebased: false, reason: 'no base' };
    }

    const rows = getAppliedChanges(messageId) || [];
    const state = structuredClone(base);
    applyRows(state, rows);

    // The threads this swipe opened and settled, put back the same way. Safe to replay:
    // addThread refuses a quote it has already seen, and closeThread returns false on
    // something already closed - so returning to a swipe twice changes nothing the second
    // time.
    const threadChanges = getThreadChanges(messageId);
    if (threadChanges) {
        for (const thread of threadChanges.opened) addThread(state, thread);
        for (const id of threadChanges.closed) closeThread(state, id);
    }

    saveStateToMetadata(state, { recordHistory: false });
    invalidateTimeline();
    debugLog(`Rebased onto swipe of message ${messageId}: ${rows.length} change(s)`);
    return { rebased: true, reason: rows.length ? 'restored' : 'back to the base' };
}
