import { getContext } from '../../../../st-context.js';
import { getSettings } from './settings.js';
import { debugLog } from './constants.js';
import { eventSource } from '../../../../events.js';
import { loadStateFromMetadata, applyUpdate, saveStateToMetadata } from './status-logic.js';
import { buildUpdateFromChanges } from './status-diff.js';
import { recordAppliedChanges, saveChatSoon } from './status-snapshots.js';

/**
 * Changes waiting for a decision.
 *
 * Stored on the message that proposed them rather than in module state, for two reasons:
 * a review must survive a reload or a chat switch, and the provenance matters - you should
 * be able to see which message wanted to delete an item.
 *
 * `message.extra` is not part of prompt construction (only extra.reasoning and extra.bias
 * are read), so this costs nothing in tokens - the same property the removed status blocks
 * rely on.
 */

export const PENDING_KEY = 'sillynpc_pending';

/** Emitted whenever a pending set is created, resolved or changed. */
export const REVIEW_EVENT = 'sillynpc-review-changed';

function messageAt(messageId) {
    return getContext()?.chat?.[Number(messageId)] ?? null;
}

/**
 * @param {string|number} messageId
 * @returns {Array<object>} Rows still awaiting a decision.
 */
export function getPendingChanges(messageId) {
    const pending = messageAt(messageId)?.extra?.[PENDING_KEY];
    return Array.isArray(pending) ? pending : [];
}

/** Where reasons that matched no row are kept, so the panel can still show them. */
const LOOSE_NOTES_KEY = 'sillynpc_review_notes';

/**
 * Reasons the reader gave that belong to no row on this message.
 *
 * Usually a key it spelled differently from the stat. Kept and shown rather than dropped:
 * a reason whose key was wrong is exactly the one worth reading, because it is evidence
 * about a reader that is not tracking what it is doing.
 *
 * @param {string|number} messageId
 * @returns {string[]}
 */
export function getLooseNotes(messageId) {
    const notes = messageAt(messageId)?.extra?.[LOOSE_NOTES_KEY];
    return Array.isArray(notes) ? notes : [];
}

/**
 * Records rows for review and persists them with the chat.
 *
 * @param {string|number} messageId
 * @param {Array<object>} changes
 * @param {string[]} [looseNotes] Reasons that matched no row.
 */
export function setPendingChanges(messageId, changes, looseNotes = []) {
    const message = messageAt(messageId);
    if (!message) return false;
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};

    if (!changes || changes.length === 0) delete message.extra[PENDING_KEY];
    else message.extra[PENDING_KEY] = changes;

    // Tied to the rows: with nothing to review there is no panel to show them in, and
    // leaving them behind would put a stale note above the next set of changes.
    if (!changes?.length || !looseNotes?.length) delete message.extra[LOOSE_NOTES_KEY];
    else message.extra[LOOSE_NOTES_KEY] = looseNotes;

    // Coalesced with the history record written for the same message: a full chat file
    // is well over a megabyte on a long story, and there is no reason to write it twice.
    saveChatSoon();
    eventSource.emit(REVIEW_EVENT, { messageId });
    return true;
}

function clearPendingChanges(messageId) {
    return setPendingChanges(messageId, null);
}

/**
 * Standing decisions about individual items, in two lists with opposite meanings.
 *
 * `dismissed` answers a row offering to *add* something: never propose this again.
 * `protected` answers a row offering to *remove* something: never propose losing this.
 *
 * One list used to serve both, which made ticking the box on a removal record the
 * opposite of what it read as - "this is gone for good" where the reader meant "stop
 * asking me to delete it". Items people still owned ended up unproposable.
 *
 * The existing tombstones (state.recently_deleted) decrement on every update and are
 * gone within a few messages. That is right for stopping the narrator re-adding
 * something you just dropped, and useless against a scan that reads three hundred
 * messages and finds the pickup again. These lists do not expire.
 */
export const DISMISSED_KEY = 'dismissed';
export const PROTECTED_KEY = 'protected';

/** The actor slot the player's own belongings live in. */
export const PLAYER_ACTOR = '__player__';

/** Both lists are keyed actor -> collection -> names. */
function actorSlot(scope, actor) {
    if (scope === 'player') return PLAYER_ACTOR;
    const name = String(actor ?? '').trim().toLowerCase();
    return name || null;
}

/** The list a row's decision belongs in, or null if the row carries no such decision. */
function keyForKind(kind) {
    if (kind === 'item-add') return DISMISSED_KEY;
    if (kind === 'item-remove') return PROTECTED_KEY;
    return null;
}

/** The name a row is about, however the row spells it. */
function rowItemName(change) {
    return String(change?.item?.name ?? change?.label ?? '').trim().toLowerCase();
}

/**
 * One list, with the pre-scoping shape discarded.
 *
 * Before these lists were scoped per character, `dismissed` was
 * `{ [collectionId]: [names] }` - values are arrays where they are now objects, which
 * is how the old shape is recognised. It is dropped rather than migrated: every entry
 * was written through a single checkbox that recorded "never add this" whichever way
 * the row read, so there is no telling which were meant that way and which meant "never
 * remove this", and in practice most named things the character still owned.
 */
function ruleMap(state, key) {
    const root = state?.[key];
    if (!root || typeof root !== 'object') return {};
    for (const value of Object.values(root)) {
        if (Array.isArray(value)) return {};
    }
    return root;
}

/** The whole map for one list, for the item library and the scan prompt. */
export function getItemRules(key = DISMISSED_KEY) {
    try { return ruleMap(loadStateFromMetadata(), key); } catch { return {}; }
}

/** The names recorded under one list for one actor's collection. */
export function getItemRuleNames(key, scope, actor, collectionId) {
    const slot = actorSlot(scope, actor);
    if (!slot || !collectionId) return [];
    const list = getItemRules(key)[slot]?.[collectionId];
    return Array.isArray(list) ? list : [];
}

/**
 * Whether a standing decision already covers this row.
 *
 * The single guard both the per-message pass and the history scan use, so the two
 * cannot drift apart on what counts as settled.
 *
 * @param {object} change A change row.
 * @returns {boolean}
 */
export function isItemDecided(change) {
    const key = keyForKind(change?.kind);
    if (!key) return false;
    const name = rowItemName(change);
    if (!name) return false;
    return getItemRuleNames(key, change.scope, change.actor, change.collectionId)
        .includes(name);
}

/** Records the standing decision a ticked row carries. */
function rememberItemRule(state, change) {
    const key = keyForKind(change?.kind);
    const slot = actorSlot(change?.scope, change?.actor);
    const name = rowItemName(change);
    if (!key || !slot || !name || !change.collectionId) return false;

    if (!state[key] || typeof state[key] !== 'object') state[key] = {};
    // A pre-scoping map is replaced rather than written into; see ruleMap.
    if (Object.values(state[key]).some(Array.isArray)) state[key] = {};
    const perActor = state[key][slot] ||= {};
    const list = perActor[change.collectionId] ||= [];
    if (list.includes(name)) return false;
    list.push(name);
    return true;
}

/** Lets an item be proposed again. */
export function clearItemRule(key, actorSlotName, collectionId, itemName) {
    const state = loadStateFromMetadata();
    const list = ruleMap(state, key)[actorSlotName]?.[collectionId];
    if (!Array.isArray(list)) return false;
    const index = list.indexOf(String(itemName ?? '').trim().toLowerCase());
    if (index === -1) return false;
    list.splice(index, 1);
    saveStateToMetadata(state, { label: 'Standing decision cleared' });
    return true;
}

/**
 * Applies the accepted rows and clears the review.
 *
 * Accepted rows may carry an edited `after` - the point of editing rather than merely
 * rejecting is that "it says 5 but it should be 4" has a right answer, and refusing the
 * change outright would leave the state wrong in a different way.
 *
 * The rebuilt update goes through applyUpdate like any other, so nothing bypasses
 * validation, and the whole thing lands as one undo step.
 *
 * @param {string|number} messageId
 * @param {Array<object>} accepted Rows to apply; those omitted are discarded.
 * @param {Array<object>} [dismissed] Rows explicitly marked "never again". Each lands
 *   in the list matching what it offered: an addition becomes "never propose adding
 *   this", a removal becomes "never propose removing this". Deliberately separate from
 *   merely declining a row: declining is a decision about this message, and a standing
 *   rule is not.
 */
export function resolvePendingChanges(messageId, accepted, dismissed = []) {
    const pending = getPendingChanges(messageId);
    if (!pending.length) return { applied: 0, discarded: 0 };

    const rows = Array.isArray(accepted) ? accepted : [];
    if (rows.length > 0) {
        const trackerSettings = getSettings().statusTracker;
        // Cards too: an accepted row may name a character who is off stage, whose
        // belongings live on their card rather than in the scene.
        const update = buildUpdateFromChanges(
            rows, loadStateFromMetadata(), trackerSettings, getSettings().characters || []);
        // These rows have been looked at and accepted, so a character named in one is
        // wanted whether or not they are on stage - a scan proposes mostly about people
        // who are not. Without this, approving an NPC's spells silently did nothing.
        applyUpdate(update, { label: 'Reviewed change', admitCharacters: true });
        // Appended to whatever the automatic half of this message already recorded, so
        // the history knows the full effect of the message, however late it was decided.
        recordAppliedChanges(messageId, rows);
        debugLog(`Applied ${rows.length} reviewed change(s) from message ${messageId}`);
    }

    // Only what was explicitly marked. Inferring this from an ordinary decision was a
    // mistake: turning down a row once, or discarding a panel there was no time to read,
    // permanently blacklisted the item - which is how four real spells became
    // unproposable and stayed that way through every later scan.
    if (dismissed?.length) {
        const state = loadStateFromMetadata();
        let noted = false;
        for (const row of dismissed) {
            noted = rememberItemRule(state, row) || noted;
        }
        if (noted) saveStateToMetadata(state, { label: 'Standing item decisions' });
    }

    clearPendingChanges(messageId);
    return { applied: rows.length, discarded: pending.length - rows.length };
}
