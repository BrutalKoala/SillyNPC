import { 
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    getThumbnailUrl,
    user_avatar,
    getRequestHeaders
} from '../../../../../script.js';
import { 
    eventSource, 
    event_types, 
} from '../../../../events.js';
import { getContext } from '../../../../st-context.js';
import { power_user } from '../../../../power-user.js';
import { setUserAvatar, getUserAvatar } from '../../../../personas.js';
import { getSettings, saveSettings, defaultSettings } from './settings.js';
import { LOG_PREFIX, debugLog, PROFILE_FIELDS } from './constants.js';
import { extractJSON, safeJsonParse, splitValue, escapeRegExp, currentMessageIndex } from './utils.js';
import { getIgnoredSpeakerLabels, normaliseSpeakerLabel } from './speaker-labels.js';
import { describeThreads } from './threads.js';

/**
 * Merges old and new stat values. If the old value had a max format (e.g. "50/100") 
 * and the new value is a single number, it preserves the max format ("new/100").
 */
export function mergeStatValue(oldVal, newVal, maxVal) {
    if (newVal === undefined || newVal === null) return newVal;
    const strOld = oldVal !== undefined && oldVal !== null ? String(oldVal) : '';
    const strNew = String(newVal);
    
    // No configured maximum does not mean no maximum. A value arriving as "280/350"
    // carries a ceiling this actor has and the stat definition does not, and throwing the
    // denominator away here is how a character's own cap disappeared mid-story.
    if (!maxVal) {
        return clampToCeiling(strNew.trim());
    }
    
    // If the old value has a max format, preserve it
    if (strOld.includes('/') && !strNew.includes('/')) {
        const parts = strOld.split('/');
        if (parts.length === 2) {
            return clampToCeiling(`${strNew.trim()}/${parts[1].trim()}`);
        }
    }

    // Otherwise, if a maxVal is provided and the new value is a plain number, append /maxVal
    if (maxVal && !strNew.includes('/')) {
        return clampToCeiling(`${strNew.trim()}/${String(maxVal).trim()}`);
    }

    return clampToCeiling(newVal);
}

/**
 * Formats a default value with its defined maximum value if it doesn't already have one.
 */
/**
 * A stat's effective maximum.
 *
 * An empty maxStatValue used to mean "this stat has no ceiling", which made
 * mergeStatValue strip the "/max" off any value. Combined with a default of "10/10"
 * that is incoherent: the stat starts at 10/10 and collapses to 8 on the first
 * update, losing the ceiling from the display AND from the prompt's STAT LIMITS
 * block. Defaults written as "cur/max" now supply the max when none is set
 * explicitly, which fixes existing configurations without a migration.
 *
 * @param {{maxStatValue?: string, defaultValue?: string}} statDef
 * @returns {string} The max, or '' when the stat genuinely has none.
 */
export function resolveMaxValue(statDef) {
    if (!statDef) return '';
    const explicit = statDef.maxStatValue;
    if (explicit !== undefined && String(explicit).trim() !== '') return String(explicit).trim();
    const fallback = statDef.defaultValue;
    if (typeof fallback === 'string' && fallback.includes('/')) {
        const denominator = fallback.split('/')[1]?.trim();
        if (denominator) return denominator;
    }
    return '';
}

/**
 * Holds a value at its own ceiling.
 *
 * A value written as "cur/max" carries its ceiling with it, and that ceiling belongs to
 * the actor rather than to the stat definition: one character's Energy caps at 350 while
 * another's caps at 40, with nothing configured globally.
 *
 * This replaces a rule that did the opposite. When a stat had no configured maximum, the
 * "/max" was deleted from every value on load - so a character given a ceiling of 350 lost
 * it silently a few messages later, and with nothing left to cap them their Energy
 * climbed past 350 unopposed. Only characters who had been on stage were affected, which
 * is why some cards kept "150/150" while others had been flattened to a bare number.
 *
 * Non-numeric values are left alone: "???" and "Healthy" have no arithmetic to do.
 *
 * @param {string|number} value
 * @returns {string|number} The value, with its current half held at its maximum.
 */
export function clampToCeiling(value) {
    if (value === undefined || value === null) return value;
    const text = String(value);
    if (!text.includes('/')) return value;

    const { current, max } = splitValue(text);
    const currentNum = Number(current);
    const maxNum = Number(max);
    if (!Number.isFinite(currentNum) || !Number.isFinite(maxNum)) return value;
    if (currentNum <= maxNum) return value;
    return `${max}/${max}`;
}

export function getInitialStatValue(defaultValue, maxStatValue) {
    let value = defaultValue || '';
    if (maxStatValue && value && !String(value).includes('/')) {
        value = `${value}/${maxStatValue}`;
    }
    return value;
}

/**
 * Gets the name of the currently selected user persona.
 */
function getCurrentPersonaName() {
    return resolvePersonaAvatarAndName().name;
}

/**
 * How a persona is identified in storage: the avatar file.
 *
 * The display name used to be the key, which meant two personas called the same thing
 * shared one record and renaming a persona orphaned theirs. SillyTavern identifies a
 * persona by its avatar filename and so does the chat's own persona record, so this
 * matches what the rest of the application already believes.
 */
export function getCurrentPersonaKey() {
    return resolvePersonaAvatarAndName().avatar;
}

/**
 * Finds a persona's record, accepting the display-name key written before this.
 *
 * Moves what it finds rather than copying it, so the old key stops existing and the
 * migration happens once, on the first read, without a pass over anybody's settings.
 *
 * Two personas sharing a display name means one arbitrary record to inherit and whoever
 * loads first takes it. That ambiguity is what the avatar key removes going forward; it
 * cannot be undone for data already written under it.
 *
 * @param {object} store personaData, or a chat's players map.
 * @param {string} key The avatar filename.
 * @param {string} name The display name, as the record may still be filed under it.
 */
function takePersonaRecord(store, key, name) {
    if (!store || !key) return undefined;
    if (store[key]) return store[key];
    if (name && name !== key && store[name]) {
        store[key] = store[name];
        delete store[name];
        debugLog(`Persona record re-keyed from "${name}" to "${key}"`);
        return store[key];
    }
    return undefined;
}

/**
 * Single source of truth for "which persona is active, and what is it called".
 * @returns {{ avatar: string, name: string }}
 */
function resolvePersonaAvatarAndName() {
    const context = getContext();
    // context has no user_avatar key; the module-level export from script.js is the
    // authoritative value. Keep the context read first in case a future ST adds it.
    const avatar = context?.user_avatar || user_avatar || 'default_user.png';
    const powerUser = power_user || {};
    const name = powerUser.personas?.[avatar] || context?.name1 || 'Player';
    return { avatar, name };
}

/**
 * Initializes persona data in master storage with default values.
 */
function initPersonaData(key, name = key) {
    const settings = getSettings();
    const trackerSettings = settings.statusTracker;
    
    if (!settings.personaData) settings.personaData = {};
    
    const personaData = {
        stats: {},
        collections: {},
        lastUpdated: Date.now()
    };
    
    (trackerSettings.playerStats || []).forEach(stat => {
        if (stat && stat.name) {
            personaData.stats[stat.name] = getInitialStatValue(stat.defaultValue, stat.maxStatValue);
        }
    });
    
    (trackerSettings.collections || []).forEach(col => {
        if (col && col.id && (col.target === 'player' || col.target === 'all')) {
            personaData.collections[col.id] = [];
        }
    });
    
    personaData.name = name;
    settings.personaData[key] = personaData;
    saveSettings();
    return personaData;
}

/** What SillyTavern was told about a persona, however that field is shaped. */
function personaDescription(avatarFilename) {
    const raw = (power_user || {}).persona_descriptions?.[avatarFilename];
    return (typeof raw === 'object' ? raw?.description : raw) || '';
}

/**
 * The player's own character card: their portrait, their description, their lore entry.
 *
 * The fields carry the names a character card uses, so everything built for a character -
 * the portrait block, the lorebook section, the image generator - works on the player
 * without being told who they are. isPlayer is the one thing that has to be said out
 * loud, because the player's facts live at state.player rather than in the scene cast.
 *
 * Kept in the same record as their stats, which means it follows the persona rather than
 * the chat and travels with the world when a system is switched. syncPlayerToMaster
 * rewrites that record on every message, so it carries these across explicitly - a
 * portrait that lasted until the next reply is the failure this has to avoid.
 *
 * @returns {object} The stored record, live: mutate it and call saveSettings().
 */
export function getPlayerCard() {
    const { avatar: key, name } = resolvePersonaAvatarAndName();
    const settings = getSettings();
    if (!settings.personaData) settings.personaData = {};

    const record = takePersonaRecord(settings.personaData, key, name) || initPersonaData(key, name);

    record.isPlayer = true;
    record.name = name;
    // No description: the sheet had a box for one and it only ever restated the persona
    // prompt, which the model is already given. The lore entry is where the player is
    // described, exactly as a character is.
    //
    // The portrait is deliberately not seeded from the persona picture either. Separating
    // the two is the point, and a copy would leave them looking joined.
    if (typeof record.imageUrl !== 'string') record.imageUrl = '';
    if (!Array.isArray(record.images)) record.images = [];
    if (record.lorebook === undefined) record.lorebook = null;
    // The same four a character has, so the sheet and the character page can share the
    // blocks that draw them. Field by field, so a record written before a field existed
    // gains it rather than being replaced by a blank set.
    if (!record.profile || typeof record.profile !== 'object') record.profile = {};
    for (const field of PROFILE_FIELDS) {
        if (typeof record.profile[field.id] !== 'string') record.profile[field.id] = '';
    }

    return record;
}

/** The picture to show the player with, or '' when they have not made one. */
export function getPlayerImageUrl() {
    try {
        return getPlayerCard().imageUrl || '';
    } catch {
        return '';
    }
}

/** The field that identifies an item within a collection. */
function primaryFieldNameFor(colId) {
    const colDef = (getSettings().statusTracker.collections || []).find(c => c.id === colId);
    return colDef?.fields?.find(f => f.isPrimary)?.name || 'name';
}

/**
 * Merges two maps of collections by primary key, additively.
 *
 * Wholesale replacement is what emptied a persona's inventory, spells and skills across
 * every chat at once. Master and chat used to overwrite each other on load and on save,
 * so a single empty copy anywhere propagated everywhere: open a fresh chat, let one
 * update land, and the items were gone from every chat that persona had ever played.
 *
 * Merging means a copy that has merely forgotten an item cannot delete it. Only an
 * explicit removal - reviewed, or stated outright in an update - can, and that path goes
 * through syncPlayerToMaster with authoritative set.
 *
 * @param {Record<string, object[]>} base Kept in full.
 * @param {Record<string, object[]>} newer Merged over it; wins on individual fields.
 * @returns {Record<string, object[]>}
 */
function mergeCollectionMaps(base, newer) {
    const result = {};
    const ids = new Set([...Object.keys(base || {}), ...Object.keys(newer || {})]);

    for (const colId of ids) {
        const primary = primaryFieldNameFor(colId);
        const keyOf = (item) => String(item?.[primary] ?? item?.name ?? '').trim().toLowerCase();

        const merged = [];
        const seen = new Map();
        for (const source of [base?.[colId] || [], newer?.[colId] || []]) {
            for (const item of source) {
                const key = keyOf(item);
                // A blank primary field is a placeholder row, not an item. One of these
                // was all that survived of a real spell list.
                if (!key) continue;
                if (seen.has(key)) {
                    // A quantity or description that moved on is not reverted by the
                    // older copy, but the item itself is never dropped.
                    Object.assign(seen.get(key), item);
                    continue;
                }
                const copy = structuredClone(item);
                seen.set(key, copy);
                merged.push(copy);
            }
        }
        result[colId] = merged;
    }
    return result;
}

/**
 * Strips rows whose primary field is blank.
 *
 * Adding an item in the library creates an empty row to type into, which is reasonable
 * while editing and meaningless as a stored record.
 */
function dropPlaceholderItems(collections) {
    const result = {};
    for (const [colId, items] of Object.entries(collections || {})) {
        const primary = primaryFieldNameFor(colId);
        result[colId] = (items || []).filter(
            item => String(item?.[primary] ?? item?.name ?? '').trim() !== '');
    }
    return result;
}

/**
 * A persona's starting point in a chat that has never seen them.
 *
 * Master storage is a seed, and only a seed. It used to be copied into the live state
 * every time the persona was reloaded, the sheet was opened, or a chat was switched -
 * replacing that chat's stats wholesale with whichever chat wrote to master last. Two
 * stories with the same character therefore could not hold different states, and the
 * mechanism enforcing that was a silent in-place overwrite: part 2 lost its HP and
 * Energy to part 1 exactly this way.
 *
 * It is read here and nowhere else, so a chat that already knows a persona can never be
 * written over by one that played them elsewhere.
 *
 * @param {string} key The avatar filename identifying the persona.
 * @param {string} [name] Display name, for a record still filed under it.
 * @returns {{ stats: object, collections: object }} A fresh copy, safe to own.
 */
export function seedPlayerFromMaster(key, name = key) {
    const settings = getSettings();
    if (!settings.personaData) settings.personaData = {};

    const masterData = takePersonaRecord(settings.personaData, key, name)
        || initPersonaData(key, name);
    debugLog(`Seeding "${name}" into this chat from master storage`);
    return {
        stats: structuredClone(masterData.stats || {}),
        collections: structuredClone(masterData.collections || {}),
    };
}

/**
 * Points state.player at the persona now active, keeping whoever was there.
 *
 * The only function allowed to repoint state.player, so there is one place where a
 * persona change can touch player data and one place to get it right.
 *
 * A chat keeps a record per persona rather than a single slot. Switching to somebody else
 * for a scene and back used to hand the second character the first one's belongings -
 * that is where an officer's watch, a signet ring and a set of journals once changed
 * owner - and there was nowhere for the first character's progress to wait.
 *
 * @param {object} state
 * @param {string} key The avatar filename of the persona now active.
 * @param {string} [name] Their display name; defaults to the key for callers with only one.
 * @returns {boolean} Whether the active persona actually changed.
 */
export function activatePersona(state, key, name = key) {
    if (!state || !key) return false;

    // Identity is the avatar; the name is only what it is called. A persona renamed
    // mid-story is still the same character and keeps everything.
    const previousKey = String(state.player?.personaKey ?? state.player?.name ?? '').trim();
    if (previousKey && previousKey === key) {
        state.player.personaKey = key;
        state.player.name = name;
        return false;
    }

    if (!state.players || typeof state.players !== 'object') state.players = {};

    // Whoever was playing keeps what they earned, in this chat, for their return.
    if (previousKey && state.player) {
        state.players[previousKey] = {
            name: state.player.name,
            stats: structuredClone(state.player.stats || {}),
            collections: structuredClone(state.player.collections || {}),
        };
    }

    const known = takePersonaRecord(state.players, key, name);
    const incoming = known
        ? { stats: structuredClone(known.stats || {}), collections: structuredClone(known.collections || {}) }
        : seedPlayerFromMaster(key, name);

    state.player = { name, personaKey: key, stats: incoming.stats, collections: incoming.collections };
    debugLog(`Active persona in this chat: ${name}${known ? ' (restored)' : ' (seeded)'}`);
    return true;
}

/**
 * Synchronizes the player state from the current chat state to master storage.
 */
export function syncPlayerToMaster(state, options = {}) {
    if (!state.player) return;

    // Only a state that actually stated its collections may shrink them. A stats-only
    // update, or a plain save after a load, must not be able to empty master - that is
    // the direction the loss travelled in: one chat with nothing in it, and the persona
    // was stripped in every other chat too.
    const { authoritative = false } = options;

    const name = getCurrentPersonaName();
    const key = getCurrentPersonaKey();
    const settings = getSettings();

    if (!settings.personaData) settings.personaData = {};

    const existing = takePersonaRecord(settings.personaData, key, name);
    const incoming = structuredClone(state.player.collections || {});
    const collections = authoritative
        ? dropPlaceholderItems(incoming)
        : mergeCollectionMaps(existing?.collections || {}, incoming);

    // There was a ten-slot rollback ring here, taking a snapshot whenever the item count
    // dropped. It never fired for the loss it was meant to catch: stats going wrong is not
    // an item count changing, so when a story's HP and Energy were overwritten the ring
    // held nothing at all. Recovery came from the per-message records instead, and those
    // now have a way in - see restorePlayerFromMessage. A blind buffer nobody can inspect
    // earns nothing beside a list of points you can read and choose between.

    debugLog(`Syncing player data UP for persona "${name}"`, { authoritative });
    settings.personaData[key] = {
        // Whatever else the record held comes first. This write replaces it outright, so
        // without carrying them the player's portrait, description and lore link would
        // last exactly until their next message.
        ...(existing || {}),
        name,
        stats: structuredClone(state.player.stats),
        collections,
        lastUpdated: Date.now()
    };
    saveSettings();
}

/**
 * @typedef {Object} CollectionItem
 * @property {string} [id] - Optional unique identifier
 * @property {Record<string, any>} fields - Field values defined in settings
 */

/**
 * @typedef {Object} ActorState
 * @property {string} name
 * @property {Record<string, string>} stats
 * @property {Record<string, CollectionItem[]>} collections
 * @property {string} [boundTo] - For scene binding
 */

/**
 * @typedef {Object} StatusState
 * @property {Record<string, string>} global
 * @property {ActorState[]} characters
 * @property {ActorState} player
 * @property {number} timestamp
 */

const STATE_KEY = 'sillynpc_status_state';
const HISTORY_KEY = 'sillynpc_status_history';
const SWIPE_BASE_KEY = 'sillynpc_swipe_base';

/** @type {StatusState | null} */
let committedState = null;

/**
 * The chat committedState was read from.
 *
 * The cache is only ever valid for one chat, and CHAT_CHANGED is too late to be the thing
 * that says so: SillyTavern swaps chat_metadata inside getChat() and only fires the event
 * after printMessages() has already rendered the whole conversation. For that entire pass
 * the new chat's metadata is live while this still holds the previous chat's state - so
 * every status box, and the HUD, read the chat you just left. Worse, a state repaired
 * during that window was saved back, writing the old chat's values into the new chat.
 *
 * Keyed on the chat instead, the cache invalidates itself the moment the chat does.
 *
 * @type {string | undefined}
 */
let committedChatId;

/** @returns {string|undefined} Undefined between chats, which is a value like any other. */
function currentChatId() {
    return getContext()?.getCurrentChatId?.();
}

/**
 * Which chat each live state object was read from.
 *
 * Invalidating the read cache stops a stale state being handed out, but it cannot stop
 * one already handed out from being saved after the chat has moved on - and that is the
 * write that does real damage, because it puts one chat's values into another chat's
 * file. It is how a story lost its HP and Energy to the story opened before it.
 *
 * A WeakMap rather than a field on the state: this must not be serialised into the chat
 * file, survive a structuredClone, or be something an update object could carry.
 *
 * @type {WeakMap<object, string|undefined>}
 */
const stateOrigin = new WeakMap();

// Common RPG stat synonyms to handle different AI output styles
const STAT_SYNONYMS = {
    // NOTE: deliberately no *_max / *_current entries here. Those address one half of
    // a "cur/max" value and are handled by splitStatKeyPart(); listing them as synonyms
    // made hp_max and hp_current both write the whole HP stat, so whichever the model
    // emitted last silently destroyed the other.
    'hp': ['health', 'hitpoints', 'life'],
    'energy': ['mana', 'mp', 'essence', 'power', 'stamina'],
    'condition': ['status', 'state', 'conditions', 'status_effects', 'effect']
};

/**
 * Robustly gets persona avatar and description from ST context.
 * Uses official ST persona management structures and utility functions.
 */
export function getPersonaData() {
    const { avatar: avatarFilename, name: officialName } = resolvePersonaAvatarAndName();

    const officialDescription = personaDescription(avatarFilename);
    
    // 3. Native Asset Loading
    //
    // Two URLs, because the two consumers want different things. SillyTavern renders
    // persona thumbnails at 96x144 (config.yaml), which is right for the 60px HUD circle
    // and visibly soft anywhere larger - a 768x1408 avatar arrives at an eighth of its
    // resolution. Anything bigger than a favicon should ask for the file itself.
    const FALLBACK_AVATAR = '../../../../../img/twemoji/1f464.png'; // Default silhouette
    let avatarUrl = FALLBACK_AVATAR;
    let avatarThumbUrl = FALLBACK_AVATAR;

    if (avatarFilename && avatarFilename !== 'default_user.png') {
        avatarThumbUrl = getThumbnailUrl('persona', avatarFilename);
        avatarUrl = `/User Avatars/${encodeURIComponent(avatarFilename)}`;
    }

    const result = {
        name: officialName,
        avatar: avatarFilename,
        avatarUrl: avatarUrl,
        avatarThumbUrl: avatarThumbUrl,
        description: officialDescription,
        method: 'official-st-lookup'
    };

    return result;
}

/**
 * Returns the chat metadata object that SillyTavern persists alongside the chat.
 *
 * The context key is `chatMetadata` — there is no `window.chat_metadata`, and no
 * `context.chat_metadata`. Reading either of those returned a throwaway object
 * literal, so every state write went to garbage and nothing survived a reload.
 */
function getMetadata() {
    return getContext()?.chatMetadata ?? null;
}

/**
 * The tracker state as it stood before the newest message was read.
 *
 * Swiping replaces the newest reply with another one, and the changes already applied
 * describe the reply you swiped away from. Rebuilding from the state before that message
 * is what lets a different swipe be applied cleanly instead of stacking on top.
 *
 * One slot, overwritten when the next message is read. Only the newest message can be
 * swiped in SillyTavern - the handlers are bound to `.last_mes` - so a second entry could
 * never be consulted, and a snapshot per message would put megabytes in a long chat file.
 *
 * @param {string|number} messageId
 * @param {StatusState} state The state before this message's changes are applied.
 */
export function rememberSwipeBase(messageId, state) {
    const metadata = getMetadata();
    if (!metadata || !state) return false;

    const key = String(messageId);
    // Only the first read of a message sets it. A later swipe of the same message must
    // rebuild from the same starting point, not from what the previous swipe produced.
    if (metadata[SWIPE_BASE_KEY]?.messageId === key) return false;

    metadata[SWIPE_BASE_KEY] = { messageId: key, state: structuredClone(state) };
    debugLog(`Remembered the state before message ${key}, for swipes`);
    return true;
}

/**
 * The remembered state for a message, or null when there is none.
 *
 * Missing after a reload, or for a message written before this existed. The caller has to
 * say so rather than guess: applying a swipe's changes on top of numbers that already
 * include a different swipe is the double-counting this exists to prevent.
 *
 * @param {string|number} messageId
 * @returns {StatusState | null}
 */
export function getSwipeBase(messageId) {
    const stored = getMetadata()?.[SWIPE_BASE_KEY];
    if (!stored || stored.messageId !== String(messageId)) return null;
    return structuredClone(stored.state);
}


/**
 * Initialize status tracker logic
 */
export function initStatusLogic() {
    debugLog('Initializing Status Tracker Logic');
    // Before anything reads configuration, so the world in use belongs to a system.
    migrateToActiveSystem();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.PERSONA_CHANGED, onPersonaChanged);
    eventSource.on(event_types.CHARACTER_EDITED, onCharacterEdited);
}

/** Where a chat records which persona was last used in it. */
export const PERSONA_KEY = 'sillynpc_persona';

/**
 * Whether a chat is actually open. SillyTavern returns undefined between chats, which is
 * the only reliable signal - the chat array is left populated after one closes.
 */
export function hasOpenChat() {
    return getContext()?.getCurrentChatId?.() !== undefined;
}

/** The persona this chat was last used with, or null if it has never recorded one. */
export function getChatPersona() {
    const avatar = getMetadata()?.[PERSONA_KEY];
    return (typeof avatar === 'string' && avatar) ? avatar : null;
}

/**
 * Records the persona in use against the open chat.
 *
 * Called whenever you switch persona, which is what makes a change mid-chat stick: the
 * chat remembers whoever you last played it as, not whoever was active when the
 * application last closed.
 *
 * @returns {boolean} False when there was nothing to record.
 */
export function rememberChatPersona() {
    const metadata = getMetadata();
    if (!metadata || !hasOpenChat()) return false;

    const { avatar } = resolvePersonaAvatarAndName();
    // A restore also lands here, via the PERSONA_CHANGED it emits - and needs no special
    // case, because it can only ever be writing back the value it just read.
    if (!avatar || metadata[PERSONA_KEY] === avatar) return false;

    metadata[PERSONA_KEY] = avatar;
    getContext()?.saveMetadataDebounced?.();
    debugLog(`Chat persona recorded: ${avatar}`);
    return true;
}

/**
 * Puts a chat back to the persona it was last played with.
 *
 * A chat that has never recorded one adopts whoever is active now, so nothing is guessed
 * about chats that predate this and the first open of an old chat simply claims it.
 *
 * One sharp edge worth knowing: setUserAvatar re-triggers the greeting on an *empty*
 * chat. A chat with no record returns before that point, so it only applies to an empty
 * chat that recorded a different persona earlier - rare, and still the right outcome.
 *
 * @returns {Promise<boolean>} Whether a switch actually happened.
 */
export async function restoreChatPersona() {
    if (!hasOpenChat()) return false;

    const recorded = getChatPersona();
    if (!recorded) {
        rememberChatPersona();
        return false;
    }

    const { avatar } = resolvePersonaAvatarAndName();
    if (recorded === avatar) return false;

    try {
        await setUserAvatar(recorded, { toastPersonaNameChange: false });
        debugLog(`Chat persona restored: ${recorded}`);
        return true;
    } catch (err) {
        // A persona deleted since the chat was last opened is the ordinary failure. The
        // chat stays on whoever is active rather than refusing to open.
        console.warn(LOG_PREFIX, 'Could not restore this chat\'s persona', err);
        return false;
    }
}

/** Where a chat records which system it belongs to. */
export const SYSTEM_KEY = 'sillynpc_system';

/** The system this chat belongs to, or null if it has never recorded one. */
export function getChatSystem() {
    const name = getMetadata()?.[SYSTEM_KEY];
    return (typeof name === 'string' && name) ? name : null;
}

/** Ties the open chat to the system in use. */
function rememberChatSystem() {
    const metadata = getMetadata();
    if (!metadata || !hasOpenChat()) return false;

    const active = getActiveSystem();
    if (!active || metadata[SYSTEM_KEY] === active) return false;

    metadata[SYSTEM_KEY] = active;
    getContext()?.saveMetadataDebounced?.();
    return true;
}

/**
 * Puts the extension into the system a chat belongs to.
 *
 * This is what makes changing ruleset stop being something you do. Opening a Pathfinder
 * chat brings its stats, its cast and its item library with it; a chat that has never
 * recorded a system adopts the one in use, so nothing is guessed about older chats.
 *
 * @returns {boolean} Whether a switch actually happened.
 */
export function restoreChatSystem() {
    if (!hasOpenChat()) return false;

    const recorded = getChatSystem();
    if (!recorded) {
        rememberChatSystem();
        return false;
    }
    if (recorded === getActiveSystem()) return false;

    if (!getSettings().statusTracker.presets?.[recorded]) {
        // Deleted since the chat was last opened. Staying put is the safe reading: the
        // alternative is loading a world at random and writing this chat's state into it.
        console.warn(LOG_PREFIX,
            `This chat belongs to a system that no longer exists: "${recorded}"`);
        return false;
    }
    return setActiveSystem(recorded);
}

async function onChatChanged() {
    committedState = null;
    // System first. It carries the persona records that the restore below reads from, so
    // the other order would match a persona against the outgoing system's storage.
    restoreChatSystem();
    await restoreChatPersona();
}

function onCharacterEdited(data) {
    // A redraw, nothing more. This used to pull master over the chat's player data, so
    // editing a persona's description or picture rewrote their HP - which is not a thing
    // anyone editing a description is asking for.
    const personaName = getCurrentPersonaName();
    if (data && (data.name === personaName || data.name === getContext()?.name1)) {
        debugLog('Current persona edited, redrawing');
        eventSource.emit('sillynpc-status-updated', loadStateFromMetadata());
    }
}

function onPersonaChanged() {
    const state = loadStateFromMetadata();
    // Only writes when the active persona actually changed, so an event fired for a
    // persona that was already active costs nothing and touches nothing.
    if (activatePersona(state, getCurrentPersonaKey(), getCurrentPersonaName())) {
        saveStateToMetadata(state, { label: 'Persona changed' });
        eventSource.emit('sillynpc-status-updated', state);
    }
    rememberChatPersona();
    // index.js will handle the HUD update via its own event listener
}

/**
 * Loads the current status from chat metadata
 */
export function loadStateFromMetadata() {
    // Belongs to a chat that is no longer open, whatever the event order was.
    if (committedState && committedChatId !== currentChatId()) committedState = null;

    let stateToReturn = committedState;

    if (!stateToReturn) {
        const metadata = getMetadata();
        if (metadata && metadata[STATE_KEY]) {
            stateToReturn = metadata[STATE_KEY];
            
            // Ensure legacy states have expected structure
            if (!stateToReturn.global) stateToReturn.global = {};
            if (!stateToReturn.characters) stateToReturn.characters = [];
            
            // The chat owns what is here. A different persona is a switch, handled in one
            // place; the same persona means this chat's record is already theirs and
            // nothing outside the chat gets a say in it.
            if (stateToReturn.player) {
                activatePersona(stateToReturn, getCurrentPersonaKey(), getCurrentPersonaName());
            } else {
                // Written before there was a player object at all.
                const name = getCurrentPersonaName();
                const key = getCurrentPersonaKey();
                stateToReturn.player = { name, personaKey: key, ...seedPlayerFromMaster(key, name) };
            }
        } else {
            const name = getCurrentPersonaName();
            const key = getCurrentPersonaKey();
            stateToReturn = createInitialState();
            stateToReturn.player = { name, personaKey: key, ...seedPlayerFromMaster(key, name) };
        }
        committedState = stateToReturn;
        committedChatId = currentChatId();
        stateOrigin.set(stateToReturn, committedChatId);
    }

    // Always validate keys against current settings in case they were deleted from settings
    const settings = getSettings().statusTracker;

    let stateChanged = false;

    // Ensure missing global stats from settings are added
    (settings.globalStats || []).forEach(stat => {
        if (stat && stat.name) {
            const existingKey = Object.keys(stateToReturn.global).find(k => k.toLowerCase() === stat.name.toLowerCase());
            if (!existingKey) {
                stateToReturn.global[stat.name] = getInitialStatValue(stat.defaultValue, stat.maxStatValue);
                stateChanged = true;
            } else {
                if (existingKey !== stat.name) {
                    // Non-destructive rename
                    stateToReturn.global[stat.name] = stateToReturn.global[existingKey];
                    delete stateToReturn.global[existingKey];
                    stateChanged = true;
                }
                const clamped = clampToCeiling(stateToReturn.global[stat.name]);
                if (clamped !== stateToReturn.global[stat.name]) {
                    stateToReturn.global[stat.name] = clamped;
                    stateChanged = true;
                }
            }
        }
    });

    // Validate Player stats
    if (stateToReturn.player && stateToReturn.player.stats) {
        // Ensure missing player stats from settings are added
        (settings.playerStats || []).forEach(stat => {
            if (stat && stat.name) {
                const existingKey = Object.keys(stateToReturn.player.stats).find(k => k.toLowerCase() === stat.name.toLowerCase());
                if (!existingKey) {
                    stateToReturn.player.stats[stat.name] = getInitialStatValue(stat.defaultValue, stat.maxStatValue);
                    stateChanged = true;
                } else {
                    if (existingKey !== stat.name) {
                        // Non-destructive rename
                        stateToReturn.player.stats[stat.name] = stateToReturn.player.stats[existingKey];
                        delete stateToReturn.player.stats[existingKey];
                        stateChanged = true;
                    }
                    const clamped = clampToCeiling(stateToReturn.player.stats[stat.name]);
                    if (clamped !== stateToReturn.player.stats[stat.name]) {
                        stateToReturn.player.stats[stat.name] = clamped;
                        stateChanged = true;
                    }
                }
            }
        });
    }

    // Ensure recently_deleted exists
    if (!stateToReturn.recently_deleted) {
        stateToReturn.recently_deleted = {};
        stateChanged = true;
    }

    // The standing-decision lists from before they were scoped per character: collection
    // -> [names], where they are now actor -> collection -> [names]. Ignored on read ever
    // since, so they have been inert - but a chat file carrying a shape nothing
    // understands is a puzzle for whoever opens it next, including us.
    for (const key of ['dismissed', 'protected']) {
        const map = stateToReturn[key];
        if (map && typeof map === 'object' && Object.values(map).some(Array.isArray)) {
            delete stateToReturn[key];
            stateChanged = true;
        }
    }

    stateToReturn.characters.forEach(char => {
        if (!char.stats) {
            char.stats = {};
            stateChanged = true;
        }

        // Optimization: Use a map for existing stats lookup
        const charStatsLower = new Map(Object.keys(char.stats).map(k => [k.toLowerCase(), k]));

        // Ensure missing NPC stats from settings are added
        (settings.npcStats || []).forEach(stat => {
            if (stat && stat.name) {
                const lowerName = stat.name.toLowerCase();
                const existingKey = charStatsLower.get(lowerName);
                if (!existingKey) {
                    char.stats[stat.name] = getInitialStatValue(stat.defaultValue, stat.maxStatValue);
                    charStatsLower.set(lowerName, stat.name);
                    stateChanged = true;
                } else {
                    if (existingKey !== stat.name) {
                        // Non-destructive rename
                        char.stats[stat.name] = char.stats[existingKey];
                        delete char.stats[existingKey];
                        charStatsLower.delete(existingKey.toLowerCase());
                        charStatsLower.set(lowerName, stat.name);
                        stateChanged = true;
                    }
                    const clamped = clampToCeiling(char.stats[stat.name]);
                    if (clamped !== char.stats[stat.name]) {
                        char.stats[stat.name] = clamped;
                        stateChanged = true;
                    }
                }
            }
        });
    });

    // Cleanup hardcoded items from current state
    if (stateToReturn.player && stateToReturn.player.collections) {
        for (const colId in stateToReturn.player.collections) {
            const items = stateToReturn.player.collections[colId];
            if (Array.isArray(items)) {
                const settings = getSettings().statusTracker;
                const colDef = settings.collections.find(c => c.id === colId);
                const primaryField = colDef ? colDef.fields.find(f => f.isPrimary) : { name: 'name' };
                const primaryFieldName = primaryField ? primaryField.name : 'name';
                
                stateToReturn.player.collections[colId] = items.filter(item => {
                    const name = item[primaryFieldName];
                    if (typeof name === 'string' && /^new item \d+$/i.test(name)) {
                        debugLog('Removing hardcoded item from player collection:', name);
                        return false;
                    }
                    return true;
                });
            }
        }
    }

    if (stateChanged) {
        debugLog('State repaired during load, saving back to metadata and master.');
        saveStateToMetadata(stateToReturn, { recordHistory: false });
        syncPlayerToMaster(stateToReturn);
        eventSource.emit('sillynpc-status-updated', stateToReturn);
    }

    return stateToReturn;
}

/**
 * Saves the current status to chat metadata
 */
/**
 * Commits a state to chat metadata, recording the state it replaces so it can be undone.
 *
 * History used to store the state that had just been written, which is the wrong
 * direction: restoring it would be a no-op. It now stores the *outgoing* state, so
 * popping an entry moves you back one step.
 *
 * @param {StatusState} state
 * @param {{ recordHistory?: boolean, label?: string }} [options]
 *   Pass recordHistory:false for writes that should not become undo points - schema
 *   repairs during load, and the undo operation itself (which would otherwise
 *   immediately re-record what it just reverted).
 */
export function saveStateToMetadata(state, options = {}) {
    const { recordHistory = true, label = 'Change' } = options;
    const metadata = getMetadata();
    if (!metadata) return;

    // Between chats, SillyTavern leaves the last chat's metadata object in place - a read
    // there hands back whichever story was open before, and a write lands in an object
    // that belongs to nothing and is about to be replaced. Neither is anything anyone
    // asked for, so the write is refused where it can still be said out loud.
    if (!hasOpenChat()) {
        console.warn(LOG_PREFIX, 'Refused to write tracker state with no chat open.');
        return;
    }

    // A state read from one chat must never be written into another. SillyTavern swaps
    // chat_metadata inside getChat() and only fires CHAT_CHANGED after the conversation
    // has been re-rendered, so anything holding a state across that gap is pointing at
    // the wrong file - and this is the write that loses work rather than merely showing
    // the wrong number. A state built fresh is unmarked and always allowed.
    const here = currentChatId();
    const origin = stateOrigin.get(state);
    if (origin !== undefined && origin !== here) {
        console.error(LOG_PREFIX,
            `Refused to write state from chat "${origin}" into "${here}".`);
        return;
    }
    stateOrigin.set(state, here);

    // The very first change in a chat has no committed predecessor in metadata yet -
    // the initial state exists only in the in-memory cache. Fall back to it so that
    // first change is undoable too.
    const previous = metadata[STATE_KEY] ?? committedState;
    if (recordHistory && previous) {
        if (!Array.isArray(metadata[HISTORY_KEY])) metadata[HISTORY_KEY] = [];
        const history = metadata[HISTORY_KEY];
        history.push({
            state: structuredClone(previous),
            timestamp: Date.now(),
            label,
        });
        const depth = Math.max(1, Number(getSettings().statusTracker?.historyDepth) || 10);
        while (history.length > depth) history.shift();
    }

    metadata[STATE_KEY] = state;
    committedState = state;
    committedChatId = currentChatId();

    getContext()?.saveMetadataDebounced?.();
}

/**
 * Undo history for the current chat, oldest first.
 * @returns {{ state: StatusState, timestamp: number, label: string }[]}
 */
export function getHistoryEntries() {
    const history = getMetadata()?.[HISTORY_KEY];
    return Array.isArray(history) ? history : [];
}

/**
 * Steps back one change.
 * @returns {{ state: StatusState, timestamp: number, label: string } | null}
 *   The entry restored, or null when there is nothing to undo.
 */
export function undoLastChange() {
    const metadata = getMetadata();
    const history = metadata?.[HISTORY_KEY];
    if (!Array.isArray(history) || history.length === 0) return null;

    const entry = history.pop();
    saveStateToMetadata(entry.state, { recordHistory: false });
    // Going back is a decision. Merging here would keep whatever master learned after
    // the point being restored, so stepping past a collection change did nothing.
    syncPlayerToMaster(entry.state, { authoritative: true });
    eventSource.emit('sillynpc-status-updated', entry.state);
    return entry;
}

/**
 * Jumps back to a specific point, discarding everything recorded after it.
 * @param {number} index Index into getHistoryEntries().
 */
export function restoreHistoryEntry(index) {
    const metadata = getMetadata();
    const history = metadata?.[HISTORY_KEY];
    if (!Array.isArray(history) || index < 0 || index >= history.length) return null;

    const entry = history[index];
    history.length = index;
    saveStateToMetadata(entry.state, { recordHistory: false });
    // Going back is a decision. Merging here would keep whatever master learned after
    // the point being restored, so stepping past a collection change did nothing.
    syncPlayerToMaster(entry.state, { authoritative: true });
    eventSource.emit('sillynpc-status-updated', entry.state);
    return entry;
}

function createInitialState() {
    const settings = getSettings().statusTracker;
    const state = {
        global: {},
        characters: [],
        player: {
            name: 'Player',
            stats: {},
            collections: {}
        },
        recently_deleted: {},
        timestamp: Date.now()
    };
    
    (settings.globalStats || []).forEach(stat => {
        if (stat && stat.name) {
            state.global[stat.name] = getInitialStatValue(stat.defaultValue, stat.maxStatValue);
        }
    });

    (settings.playerStats || []).forEach(stat => {
        if (stat && stat.name) {
            state.player.stats[stat.name] = getInitialStatValue(stat.defaultValue, stat.maxStatValue);
        }
    });
    
    return state;
}

/**
 * Summarizes a collection into a compact string for token efficiency.
 * If includeFull is true, it ignores the threshold and returns all items.
 */
function summarizeCollection(collectionId, items, includeFull = false) {
    const settings = getSettings().statusTracker;
    const colDef = settings.collections.find(c => c.id === collectionId);
    const colName = colDef ? colDef.name : collectionId;

    if (!items || items.length === 0) {
        if (includeFull) return `${colName}: (empty)`;
        return null;
    }
    
    // Everything, always. This function only ever builds a prompt - the tracker box has
    // its own summariser in status-ui.js - and it used to cut the list at
    // summaryThreshold, a setting labelled "Items Shown Per Collection" whose help says
    // "the AI always sees the full list either way". It did not: in extraction mode, which
    // is the default, a character with more spells than the threshold had the rest replaced
    // with "+N more...", so the model was told something existed but not what it was.
    const itemStrings = items.map(item => {
        const primaryField = colDef?.fields?.find(f => f.isPrimary) || { name: 'name' };
        const nameVal = item[primaryField.name] || item.name || 'Unknown Item';
        
        if (includeFull && colDef?.fields) {
            const fieldsStrList = [];
            colDef.fields.forEach(field => {
                if (field.isPrimary) return;
                const val = item[field.name];
                if (val !== undefined && val !== null && val !== '') {
                    fieldsStrList.push(`${field.name}: ${val}`);
                }
            });
            if (fieldsStrList.length > 0) {
                return `${nameVal} (${fieldsStrList.join(', ')})`;
            }
        }

        let str = nameVal;
        // Try to find a numeric quantity field to display
        const qtyField = colDef?.fields?.find(f => f.type === 'number' && (f.name === 'quantity' || f.name === 'qty' || f.name === 'count'));
        const qty = qtyField ? item[qtyField.name] : item.quantity;
        
        if (qty !== undefined && parseInt(qty) > 1) {
            str += ` (x${qty})`;
        }
        return str;
    });

    let output = `${colName}: ${itemStrings.join(', ')}`;
    return output;
}

/**
 * Formats the state into a compact text block for prompt injection.
 * For prompt injection, we now include the FULL collection list to support Full State Sync.
 */
export function formatCompactStatus(state, forPrompt = false) {
    let output = "[Current Scene Status]\n";
    
    const globalParts = [];
    if (state.global) {
        for (const [key, val] of Object.entries(state.global)) {
            if (val !== undefined && val !== null && val !== '') {
                globalParts.push(`${key}=${val}`);
            }
        }
    }
    if (globalParts.length > 0) {
        output += `Global: ${globalParts.join(', ')}\n`;
    }

    const settings = getSettings().statusTracker;

    if (state.player) {
        const playerParts = [];
        if (state.player.stats) {
            for (const [key, val] of Object.entries(state.player.stats)) {
                if (val !== undefined && val !== null && val !== '') {
                    playerParts.push(`${key}=${val}`);
                }
            }
        }
        
        let playerLine = `Player (${state.player.name || 'You'}): ${playerParts.join(', ')}`;
        
        const colSummaries = [];
        // When forPrompt is true, we show all relevant collections even if empty
        if (forPrompt) {
            const relevantCollections = (settings.collections || []).filter(c => c.target === 'all' || c.target === 'player');
            relevantCollections.forEach(col => {
                const items = state.player.collections?.[col.id] || [];
                const summary = summarizeCollection(col.id, items, forPrompt);
                if (summary) colSummaries.push(summary);
            });
        } else if (state.player.collections) {
            for (const [colId, items] of Object.entries(state.player.collections)) {
                const summary = summarizeCollection(colId, items, forPrompt);
                if (summary) colSummaries.push(summary);
            }
        }
        
        if (colSummaries.length > 0) {
            playerLine += ` | ${colSummaries.join(' | ')}`;
        }
        output += playerLine + "\n";
    }
    
    if (state.characters && Array.isArray(state.characters)) {
        for (const char of state.characters) {
            const charParts = [];
            if (char.stats) {
                for (const [key, val] of Object.entries(char.stats)) {
                    if (val !== undefined && val !== null && val !== '') {
                        charParts.push(`${key}=${val}`);
                    }
                }
            }
            
            let charLine = `${char.name}: ${charParts.join(', ')}`;
            if (charParts.length === 0) charLine = `${char.name}: Present`;

            const colSummaries = [];
            if (forPrompt) {
                const relevantCollections = (settings.collections || []).filter(c => c.target === 'all' || c.target === 'npc');
                relevantCollections.forEach(col => {
                    const items = char.collections?.[col.id] || [];
                    const summary = summarizeCollection(col.id, items, forPrompt);
                    if (summary) colSummaries.push(summary);
                });
            } else if (char.collections) {
                for (const [colId, items] of Object.entries(char.collections)) {
                    const summary = summarizeCollection(colId, items, forPrompt);
                    if (summary) colSummaries.push(summary);
                }
            }
            
            if (colSummaries.length > 0) {
                charLine += ` | ${colSummaries.join(' | ')}`;
            }
            output += charLine + "\n";
        }
    }
    

    // Who these people actually are, for everyone the lines above just listed.
    const who = describeCastProfiles(state);
    if (who) output += `${who}\n`;

    // What is still outstanding, riding the block that is already being sent. Nothing
    // is retrieved to put it here - a thread was caught when it opened, which is the
    // whole difference between this and searching a summary for it later.
    const threads = describeThreads(state, currentMessageIndex());
    if (threads) output += `${threads}\n`;

    return output.trim();
}

/**
 * Age, appearance, personality and speech, for the people in the scene.
 *
 * These four were collected, filled, displayed and exported, and never once shown to the
 * narrator. Worse than merely unused: the lore writer is told not to describe them because
 * "those are fields on the character", which assumed they arrived some other way - so
 * filling a profile in actually removed that material from the one thing the model does
 * read, and put it where nothing looked. A character with a filled profile gave the
 * narrator less to work with than one without.
 *
 * Here rather than on the lore entry because this is how somebody is played, and it has to
 * be in front of the model every time they speak. An entry only fires when its keyword
 * matches, which is not the same as being on stage.
 *
 * Only the cast the block already lists, so this costs nothing for characters who are not
 * in the scene, and only characters with something written.
 */
function describeCastProfiles(state) {
    const said = (card) => PROFILE_FIELDS
        .map(field => {
            const value = String(card?.profile?.[field.id] ?? '').trim();
            return value ? `${field.label}: ${value}` : null;
        })
        .filter(Boolean)
        .join(' | ');

    const lines = [];

    if (state.player?.name) {
        // The player's profile lives on their persona record, not in the scene cast.
        const line = said(getPlayerCard());
        if (line) lines.push(`${state.player.name} - ${line}`);
    }

    for (const actor of state.characters || []) {
        const line = said(findCardForName(actor?.name));
        if (line) lines.push(`${actor.name} - ${line}`);
    }

    return lines.length ? `Who they are:\n${lines.join('\n')}` : '';
}

/**
 * Builds the system instruction for the AI
 */
function getStatusInstructions() {
    const settings = getSettings().statusTracker;
    const currentState = committedState || loadStateFromMetadata();
    
    let prompt = `\n### STATUS TRACKER ACTIVE\n`;
    prompt += `Update the following status realistically based on the latest events in the story.\n`;
    prompt += `Current Status:\n${formatCompactStatus(currentState, true)}\n\n`;
    
    prompt += `IMPORTANT: The "Current Status" block is the authoritative source of truth. If an item or character is missing from it, they are no longer present or in possession. Do NOT re-add items that were recently removed unless the current message explicitly describes acquiring them again.\n\n`;

    prompt += `Rules: ${settings.systemRules}\n`;
    
    prompt += `\n### CRITICAL RULE: AVOID DOUBLE-DEDUCTING COSTS\n`;
    prompt += `- Action/Spell Costs: If a resource, attribute, or item cost (e.g., Energy, Mana, HP, Ammo, Gold) was already deducted or used in a previous turn (for example, in the message prompting a roll or when the action was initiated), do NOT deduct it again when describing the outcome or resolution of that action.\n`;
    prompt += `- The "Current Status" already reflects the prior deduction. Only apply NEW changes, damage, or costs that occur in the latest turn (e.g., backlash damage, new item usage).\n`;

    prompt += `\n### UPDATE PROCESS\n`;
    prompt += `1. Reasoning: Briefly explain the changes in 1-2 sentences (e.g., "The player took damage and used a potion."). Focus on stat changes, collection updates, and environment changes.\n`;
    prompt += `2. JSON Update: Provide the updated status block wrapped in <status_update> tags.\n`;

    // Add Stat Maximums information
    const describeMaxes = list => (list || [])
        .map(stat => ({ stat, max: resolveMaxValue(stat) }))
        .filter(entry => entry.max)
        .map(entry => `${entry.stat.name}: ${entry.max}`)
        .join(', ');
    const playerMaxes = describeMaxes(settings.playerStats);
    const npcMaxes = describeMaxes(settings.npcStats);

    if (playerMaxes || npcMaxes) {
        prompt += `\n### STAT LIMITS (Maximums)\n`;
        if (playerMaxes) prompt += `- Player Max Stats: ${playerMaxes}\n`;
        if (npcMaxes) prompt += `- NPC Max Stats: ${npcMaxes}\n`;
        prompt += `Maintain values within these limits. If a stat format includes a max (e.g. "50/100"), ensure you update only the current value unless the maximum itself should change.\n`;
    }
    
    prompt += `\n### COLLECTION SYNC RULES\n`;
    prompt += `Collections (e.g., inventory, spells, skills) MUST be updated via **Full State Sync** (replacement):\n`;
    prompt += `- Both the 'player' and any object in the 'characters' array can have a 'collections' object.\n`;
    prompt += `- Provide an ARRAY of ALL items that should be in the collection after the update.\n`;
    prompt += `- CRITICAL: You MUST ALWAYS preserve and carry over ALL existing spells, skills, items, and accessories verbatim unless they are explicitly lost, destroyed, consumed, or discarded in the story context. NEVER omit existing items or spells from an active character's collections array, as omission equals complete deletion.\n`;
    prompt += `- You can transfer items between actors by removing them from one collection and adding them to another in the same update.\n`;
    prompt += `- Example: "inventory": [ { "name": "Sword", "quantity": 1 }, { "name": "Potion", "quantity": 2 } ]\n`;
    
    prompt += `\n### LEGACY DELTA RULES (Fallback)\n`;
    prompt += `If you only need to make a small change, you may optionally use delta objects:\n`;
    prompt += `- "add": [ { "name": "Item", "quantity": 1, ... } ] - Adds or increments quantity if it exists.\n`;
    prompt += `- "remove": [ "Item Name" ] - Removes the item.\n`;
    prompt += `- "update": [ { "name": "Item", "quantity": 5 } ] - Modifies specific fields of an existing item.\n`;
    prompt += `- "clear": true - Resets the collection.\n`;

    // Add field definitions for collections to guide the AI
    if (settings.collections && settings.collections.length > 0) {
        // Filter collections to only those relevant to current actors
        const hasPlayer = !!currentState.player;
        const hasNPCs = currentState.characters && currentState.characters.length > 0;
        
        const relevantCollections = settings.collections.filter(col => {
            if (col.target === 'all') return true;
            if (col.target === 'player' && hasPlayer) return true;
            if (col.target === 'npc' && hasNPCs) return true;
            return false;
        });

        if (relevantCollections.length > 0) {
            prompt += `\n### COLLECTION SCHEMAS\n`;
            relevantCollections.forEach(col => {
                const fieldInfo = col.fields.map(f => `${f.name} (${f.type}${f.isMultiline ? ', multiline' : ''})`).join(', ');
                prompt += `- ${col.id} (${col.name}): ${fieldInfo}\n`;
            });
        }
    }

    prompt += `\nIMPORTANT: Always include the FULL list of characters currently present in the scene in the "characters" array. If a character is no longer present, remove them from the list.\n`;
    if (settings.sceneBindingStat) {
        prompt += `IMPORTANT: If the scene or location changes, ONLY include characters in the 'characters' array who moved to the new scene. Omit any characters left behind.\n`;
    }
    prompt += `Format: At the absolute end of your response, you MUST provide the reasoning and the <status_update> tags. Do not use markdown code blocks inside the tags.\n`;
    
    return prompt;
}

/**
 * Builds a fake assistant response to prime the AI with the correct format
 */
function getStatusExample() {
    const settings = getSettings().statusTracker;
    const inventoryCol = settings.collections.find(c => c.id === 'inventory');
    const primaryFieldName = inventoryCol?.fields?.find(f => f.isPrimary)?.name || 'name';
    
    const example = {
        player: { 
            stats: { "HP": "18/20" },
            collections: { 
                "inventory": [
                    { [primaryFieldName]: "Iron Sword", "quantity": 1, "description": "Slightly rusted" },
                    { [primaryFieldName]: "Apple", "quantity": 3, "description": "Red and juicy" },
                    { [primaryFieldName]: "Rusty Dagger", "quantity": 1, "description": "Taken from the Goblin" }
                ] 
            }
        },
        characters: [
            { 
                "name": "Goblin", 
                "stats": { "HP": "0", "Condition": "Dead" },
                "collections": {
                    "inventory": []
                }
            }
        ]
    };
    return `The player ate a Health Potion but was still hit by the Goblin. The Goblin was subsequently defeated, and the player took their Rusty Dagger. Updated the inventory for both actors to show the transfer.\n<status_update>${JSON.stringify(example)}</status_update>`;
}

function onGenerationStarted(type, data, dryRun) {
    if (dryRun) return;
    const settings = getSettings().statusTracker;

    const clear = (key) => setExtensionPrompt(key, '', extension_prompt_types.IN_CHAT, 0, false);

    if (!settings.enabled) {
        clear('sillynpc-status-instructions');
        clear('sillynpc-status-example');
        clear('sillynpc-status-scene');
        return;
    }

    if (settings.extractionMode === 'extract') {
        // A separate pass does the bookkeeping, so the narrative prompt must not demand
        // a status block - that demand is what conflicts with character cards forbidding
        // numbers or status output in their prose.
        clear('sillynpc-status-instructions');
        clear('sillynpc-status-example');

        // It does still need to KNOW the state, or it invents HP and inventory. This is
        // plain fact, with no instruction to emit anything: a few hundred tokens against
        // the ~6,800 the instruction block used to cost.
        const scene = buildSceneContext();
        setExtensionPrompt(
            'sillynpc-status-scene',
            scene,
            extension_prompt_types.IN_CHAT,
            Number(settings.sceneInjectionDepth ?? 1),
            false,
            extension_prompt_roles.SYSTEM,
        );
        return;
    }

    clear('sillynpc-status-scene');

    setExtensionPrompt(
        'sillynpc-status-instructions',
        getStatusInstructions(),
        extension_prompt_types.IN_CHAT,
        0,
        false,
        extension_prompt_roles.USER,
    );

    setExtensionPrompt(
        'sillynpc-status-example',
        getStatusExample(),
        extension_prompt_types.IN_CHAT,
        1,
        false,
        extension_prompt_roles.ASSISTANT,
    );
}

/**
 * The read-only scene block injected while extraction mode is on.
 *
 * Deliberately contains no schema, no example and no imperative - the narrative model is
 * being told what is true, not asked to maintain it.
 */
function buildSceneContext() {
    try {
        const state = committedState || loadStateFromMetadata();
        if (!state) return '';
        const body = formatCompactStatus(state, false);
        return body ? body.trim() : '';
    } catch (err) {
        debugLog('Could not build the scene context', err);
        return '';
    }
}

/**
 * Parses a message for status updates.
 */
export function parseMessageForUpdates(text) {
    if (!text) return { cleanedText: text, update: null, matchLength: 0 };

    // More lenient tag matching
    const tagMatch = text.match(/<\s*status_update\s*>([\s\S]*?)(?:<\s*\/\s*status_update\s*>|<\s*\/\s*status_update|<\s*\/\s*status_|$)/i);
    
    let jsonPart = '';
    let matchStr = '';

    if (tagMatch) {
        jsonPart = tagMatch[1];
        matchStr = tagMatch[0];
    } else {
        // Fallback for a block with no usable tag - a truncated reply, or a model that
        // emitted bare JSON.
        //
        // The nearest '{' before a root key is a NESTED one: for
        // {"global":{"Location":...}} it finds the brace after "global":, whose object
        // has no global/player/characters key, so applyUpdate silently did nothing and
        // only part of the block was ever removed. Walk left through the candidate
        // braces and keep the OUTERMOST one that actually parses as an update.
        const keys = ['"global"', "'global'", '"player"', "'player'", '"characters"', "'characters'"];
        let earliestKey = Infinity;
        for (const key of keys) {
            const idx = text.indexOf(key);
            if (idx !== -1 && idx < earliestKey) earliestKey = idx;
        }

        if (earliestKey !== Infinity) {
            let root = -1;
            let searchFrom = earliestKey;
            while (searchFrom >= 0) {
                const brace = text.lastIndexOf('{', searchFrom);
                if (brace === -1) break;
                const candidate = safeJsonParse(extractJSON(text.slice(brace)));
                if (candidate && (candidate.global !== undefined
                    || candidate.player !== undefined
                    || candidate.characters !== undefined)) {
                    root = brace;
                }
                searchFrom = brace - 1;
            }
            if (root !== -1) {
                jsonPart = text.substring(root);
                matchStr = jsonPart;
            }
        }
    }

    if (!jsonPart) return { cleanedText: text, update: null, matchLength: 0 };

    const jsonStr = extractJSON(jsonPart);
    const update = safeJsonParse(jsonStr);

    if (update) {
        debugLog('Found update in message, parsing reasoning...');
        // Use the actually parsed JSON string for matching to be precise
        const idx = text.lastIndexOf(jsonStr);
        if (idx === -1) {
            debugLog('Could not find JSON string in text for surgical removal');
            // Fallback to matchStr if jsonStr is somehow not found (shouldn't happen)
            const fallbackIdx = text.lastIndexOf(matchStr);
            if (fallbackIdx === -1) return { cleanedText: text, update: null, matchLength: 0 };
            const cleanedText = text.substring(0, fallbackIdx).replace(/\s+$/, '');
            const trueLength = text.length - cleanedText.length;
            return { cleanedText, update, matchLength: trueLength };
        }
        
        // Check if there was a tag wrapping it
        let finalIdx = idx;
        if (tagMatch && text.substring(0, idx).includes('<status_update>')) {
            const tagIdx = text.lastIndexOf('<status_update>', idx);
            if (tagIdx !== -1) finalIdx = tagIdx;
        }

        // Phase 5: Also hide "Reasoning:" block if it immediately precedes the update
        // Look for "Reasoning:" or "Reasoning: ..." at the start of a line
        const prefix = text.substring(0, finalIdx);
        
        // Find "Reasoning:" case-insensitively
        // We look for the LAST occurrence of "Reasoning:" that is followed by the status update
        const reasoningRegex = /(?:\n|^)\s*Reasoning\s*:\s*/gi;
        let lastReasoningIdx = -1;
        let m;
        while ((m = reasoningRegex.exec(prefix)) !== null) {
            lastReasoningIdx = m.index;
        }
        
        if (lastReasoningIdx !== -1) {
            // Check if there's an actual newline or start of string at the match index
            // to ensure we aren't matching "The Reasoning: " mid-sentence.
            const isAtLineStart = lastReasoningIdx === 0 || text[lastReasoningIdx - 1] === '\n' || text[lastReasoningIdx] === '\n';
            
            // Heuristic: The reasoning block should be relatively close to the update
            const distance = prefix.length - lastReasoningIdx;
            const isCloseEnough = distance < 1000;
            
            // We should only hide it if it's clearly at the end of the message
            // or if it's taking up a reasonable portion of the text.
            const isNotTooMuch = (distance + (text.length - finalIdx)) < (text.length * 0.8) || text.length < 500;

            if (isCloseEnough && isNotTooMuch && isAtLineStart) {
                finalIdx = lastReasoningIdx;
            }
        }

        const cleanedText = text.substring(0, finalIdx).replace(/\s+$/, '');
        const trueLength = text.length - cleanedText.length;
        debugLog(`Surgical removal length: ${trueLength}`);
        
        return { cleanedText, update, matchLength: trueLength };
    }

    // Fallback: If we matched a status_update block or JSON tag but parsing failed, 
    // surgically remove/hide the unparseable content anyway so raw markup/broken JSON is never shown.
    const fallbackIdx = text.lastIndexOf(matchStr);
    if (fallbackIdx !== -1) {
        let finalIdx = fallbackIdx;
        if (tagMatch && text.substring(0, fallbackIdx).includes('<status_update>')) {
            const tagIdx = text.lastIndexOf('<status_update>', fallbackIdx);
            if (tagIdx !== -1) finalIdx = tagIdx;
        }
        
        // Also hide any preceding "Reasoning:" prefix
        const prefix = text.substring(0, finalIdx);
        const reasoningRegex = /(?:\n|^)\s*Reasoning\s*:\s*/gi;
        let lastReasoningIdx = -1;
        let m;
        while ((m = reasoningRegex.exec(prefix)) !== null) {
            lastReasoningIdx = m.index;
        }
        if (lastReasoningIdx !== -1) {
            const isAtLineStart = lastReasoningIdx === 0 || text[lastReasoningIdx - 1] === '\n' || text[lastReasoningIdx] === '\n';
            const distance = prefix.length - lastReasoningIdx;
            if (distance < 1000 && isAtLineStart) {
                finalIdx = lastReasoningIdx;
            }
        }

        const cleanedText = text.substring(0, finalIdx).replace(/\s+$/, '');
        const trueLength = text.length - cleanedText.length;
        debugLog(`Surgical removal of unparseable block length: ${trueLength}`);
        return { cleanedText, update: null, matchLength: trueLength };
    }

    return { cleanedText: text, update: null, matchLength: 0 };
}

/**
 * Suffixes models use to address one half of a "cur/max" stat.
 * Order matters only in that longer suffixes must not be shadowed by shorter ones.
 */
const STAT_PART_SUFFIXES = {
    current: ['_current', '_cur', '_now', '_value', '_val'],
    max: ['_maximum', '_max', '_total', '_cap'],
};

/**
 * Splits "energy_current" into { base: 'energy', part: 'current' }.
 * A key with no recognised suffix comes back as { base: key, part: null }.
 *
 * @param {string} key
 * @returns {{ base: string, part: 'current'|'max'|null }}
 */
export function splitStatKeyPart(key) {
    const lower = String(key).toLowerCase();
    for (const [part, suffixes] of Object.entries(STAT_PART_SUFFIXES)) {
        for (const suffix of suffixes) {
            if (lower.length > suffix.length && lower.endsWith(suffix)) {
                return { base: String(key).slice(0, -suffix.length), part: /** @type {'current'|'max'} */ (part) };
            }
        }
    }
    return { base: String(key), part: null };
}

/**
 * Buckets incoming stat keys by the stat they actually address.
 *
 * Without this, "hp_current" and "hp_max" both resolved to HP and were applied one
 * after another, so the result depended on JSON key order - which no model guarantees.
 * Grouping first means both halves are combined once, deterministically.
 *
 * @param {Record<string, any>} sourceStats Raw stats object from the model.
 * @param {(key: string) => string|null} resolveBase Maps a bare name to a real stat key.
 * @param {(key: string) => boolean} isExactStat True if the key IS a configured stat.
 * @param {(key: string) => boolean} shouldSkip Keys to ignore entirely.
 * @returns {Map<string, { whole?: any, current?: any, max?: any }>}
 */
function groupIncomingStats(sourceStats, resolveBase, isExactStat, shouldSkip) {
    const groups = new Map();

    for (const updKey of Object.keys(sourceStats)) {
        if (shouldSkip(updKey)) continue;

        let actualKey = null;
        let part = null;

        // A stat genuinely named like the key (say a user stat called "HP Max") wins
        // over reading the key as a suffix.
        if (isExactStat(updKey)) {
            actualKey = resolveBase(updKey) || updKey;
        } else {
            const split = splitStatKeyPart(updKey);
            if (split.part) {
                const baseMatch = resolveBase(split.base);
                if (baseMatch) { actualKey = baseMatch; part = split.part; }
            }
            if (!actualKey) actualKey = resolveBase(updKey);
        }

        if (!actualKey) {
            debugLog('Ignoring stat key that matches no configured stat:', updKey);
            continue;
        }

        const group = groups.get(actualKey) || {};
        if (part) group[part] = sourceStats[updKey];
        else group.whole = sourceStats[updKey];
        groups.set(actualKey, group);
    }

    return groups;
}

/**
 * Folds a grouped update into a stat's existing value.
 *
 * @param {any} existingValue
 * @param {{ whole?: any, current?: any, max?: any }} group
 * @param {object} statDef
 * @returns {any}
 */
/** The values a field is allowed to hold, or an empty list when it allows anything. */
export function allowedValues(def) {
    return (def?.options || [])
        .map(value => String(value ?? '').trim())
        .filter(Boolean);
}

/**
 * Holds a field to the values it is allowed to have.
 *
 * A field with no options allows anything, which is every field until somebody says
 * otherwise. With options, a value that is not on the list is refused and whatever was
 * there stays - the point of declaring a vocabulary is that the extractor cannot quietly
 * widen it, and inventing a synonym every few messages is exactly what it does otherwise.
 *
 * Matching is exact after trimming. "healthy" is refused rather than corrected to
 * "Healthy": a list of allowed values is also a list of allowed spellings, and silently
 * rewriting one is how the sheet and the story start disagreeing about what it says.
 *
 * Refusing means keeping what is there, so a value stored before the list was narrowed
 * survives untouched. Narrowing a list in the builder must not rewrite characters nobody
 * was looking at - the same rule renaming a field follows.
 *
 * @param {object} def The stat or field definition.
 * @param {*} incoming What is being written.
 * @param {*} existing What is there now.
 * @returns {*} The value to store.
 */
export function constrainToOptions(def, incoming, existing) {
    const allowed = allowedValues(def);
    if (!allowed.length) return incoming;

    const wanted = String(incoming ?? '').trim();
    // Clearing a field is always allowed: empty means "use the default" on a card, and
    // refusing it would make a value impossible to take back.
    if (!wanted) return incoming;
    if (allowed.includes(wanted)) return incoming;

    debugLog(`"${wanted}" is not an allowed value for ${def?.name || 'this field'} `
        + `(${allowed.join(', ')}); kept "${existing ?? ''}"`);
    return existing;
}

/**
 * Cuts a value down to the field's length, if it has one.
 *
 * At a word boundary, and marked. A value cut mid-word reads as corruption rather than as
 * a limit doing its job, and an unmarked one reads as the reader's own wording - which
 * matters here because the value goes back to the reader next turn as the current state.
 *
 * @param {object} def The stat or field definition.
 * @param {*} value
 * @returns {*} Unchanged when there is no limit, or none is needed.
 */
export function capToLength(def, value) {
    const limit = Number(def?.maxLength);
    if (!Number.isFinite(limit) || limit <= 0) return value;

    const text = String(value ?? '');
    if (text.length <= limit) return value;

    const cut = text.slice(0, limit);
    const lastSpace = cut.lastIndexOf(' ');
    // Only back off to a word boundary when there is a reasonable amount of it left;
    // one very long word would otherwise cut down to nothing.
    const body = (lastSpace > limit * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd();

    debugLog(`"${def?.name || 'field'}" trimmed from ${text.length} to ${limit} characters`);
    return `${body}…`;
}

/**
 * Every rule a field's definition places on an incoming value.
 *
 * One function because there is one choke point - world stats, player stats, character
 * stats and collection fields all pass through here - and two rules that both have to
 * hold. It is not called constrainToOptions any more because it no longer only does that,
 * and a name that describes half of what a function does is worse than a longer one.
 *
 * @param {object} def
 * @param {*} incoming
 * @param {*} existing
 * @returns {*}
 */
export function constrainToDefinition(def, incoming, existing) {
    const kept = constrainToOptions(def, incoming, existing);
    // Only ever cut what was actually written. When the options guard refuses a value it
    // hands back the one already stored, and trimming that would rewrite something nobody
    // submitted - the same rule that stops narrowing a list rewriting characters nobody
    // was looking at.
    if (kept !== incoming) return kept;
    return capToLength(def, kept);
}

function combineStatValue(existingValue, group, statDef) {
    const configuredMax = resolveMaxValue(statDef);

    let value = existingValue;
    if (group.whole !== undefined) {
        value = mergeStatValue(value, group.whole, configuredMax);
    }
    if (group.current === undefined && group.max === undefined) return value;

    const parts = splitValue(value);
    let current = parts.current;
    // The configured maximum is a fallback only: a value that carries its own denominator
    // has already been raised in play, and that ceiling is the real one.
    let max = parts.max || configuredMax || '';

    if (group.current !== undefined) current = String(group.current).trim();
    // A raised ceiling is a change like any other, so it is visible in the diff and can be
    // held for review rather than being forbidden outright - growth is legitimate, and it
    // should be something you agreed to rather than something that happened.
    if (group.max !== undefined) max = String(group.max).trim();

    return max ? clampToCeiling(`${current}/${max}`) : current;
}

/**
 * Finds the most likely existing key for a given stat name, handling synonyms.
 */
export function findMatchingStatKey(existingStats, searchKey) {
    const keys = Object.keys(existingStats);
    const searchLower = searchKey.toLowerCase();
    
    // 1. Exact match
    const exact = keys.find(k => k.toLowerCase() === searchLower);
    if (exact) return exact;
    
    // 2. Synonym match
    for (const [canonical, synonyms] of Object.entries(STAT_SYNONYMS)) {
        if (searchLower === canonical || synonyms.includes(searchLower)) {
            // Check if any of our existing keys are in this synonym group
            const match = keys.find(k => {
                const kLower = k.toLowerCase();
                return kLower === canonical || synonyms.includes(kLower);
            });
            if (match) return match;
        }
    }
    
    // 3. Fuzzy prefix match (e.g. "hp_current" matches "hp")
    const prefixMatch = keys.find(k => {
        const kLower = k.toLowerCase();
        return searchLower.startsWith(kLower) || kLower.startsWith(searchLower);
    });
    if (prefixMatch) return prefixMatch;

    return null;
}

/**
 * Merges an update into the current state.
 *
 * @param {object} update
 * @param {{ dryRun?: boolean, label?: string }} [options]
 *   dryRun returns the resulting state without saving, syncing or emitting, so callers
 *   can diff what an update *would* do before letting it happen.
 * @returns {StatusState} The resulting state.
 */
export function applyUpdate(update, options = {}) {
    // allowReplace is off unless the caller asks: a per-message reply is a delta, and a
    // list in it is a mistake rather than an instruction to empty anything. The history
    // scan, which reads the whole story to produce a corrected list, passes it.
    const { dryRun = false, label = 'AI update', admitCharacters = false, allowReplace = false } = options;
    // Findings for characters with nowhere to keep them, reported rather than dropped.
    const offstageSkipped = [];
    const state = structuredClone(committedState || loadStateFromMetadata());
    let statedPlayerCollections = false;
    
    // Decrement tombstones whenever a new update is processed (likely a new AI message)
    if (state.recently_deleted) {
        for (const colId in state.recently_deleted) {
            const items = state.recently_deleted[colId];
            for (const itemName in items) {
                if (--items[itemName] <= 0) delete items[itemName];
            }
            if (Object.keys(items).length === 0) delete state.recently_deleted[colId];
        }
    }

    const settings = getSettings().statusTracker;
    
    const bindingStat = settings.sceneBindingStat;
    let oldBindingValue = null;
    if (bindingStat) {
        oldBindingValue = state.global[bindingStat] !== undefined ? state.global[bindingStat] : '';
    }
    
    const validGlobalKeys = new Set(settings.globalStats.map(s => s.name.toLowerCase()));

    if (update.global) {
        Object.keys(update.global).forEach(updKey => {
            const actualKey = Object.keys(state.global).find(k => k.toLowerCase() === updKey.toLowerCase()) || updKey;
            if (validGlobalKeys.has(actualKey.toLowerCase())) {
                const statDef = settings.globalStats.find(s => s.name.toLowerCase() === actualKey.toLowerCase());
                const merged = mergeStatValue(state.global[actualKey], update.global[updKey], resolveMaxValue(statDef));
                state.global[actualKey] = constrainToDefinition(statDef, merged, state.global[actualKey]);
            }
        });
    }
    
    let newBindingValue = null;
    if (bindingStat) {
        newBindingValue = state.global[bindingStat] !== undefined ? state.global[bindingStat] : '';
    }

    // Apply Player updates
    if (update.player) {
        debugLog('Applying player update:', update.player);
        const validPlayerKeys = new Set(settings.playerStats.map(s => s.name.toLowerCase()));
        const collectionIds = new Set(settings.collections.map(c => c.id.toLowerCase()));

        const sourceStats = update.player.stats || update.player;

        // Group first so "energy_current" and "energy_max" combine into a single
        // value instead of overwriting each other in whatever order the model emitted.
        const playerGroups = groupIncomingStats(
            sourceStats,
            (name) => {
                const matched = findMatchingStatKey(state.player.stats, name) || name;
                return validPlayerKeys.has(matched.toLowerCase()) ? matched : null;
            },
            (key) => validPlayerKeys.has(key.toLowerCase()),
            (key) => {
                const lower = key.toLowerCase();
                return lower === 'name' || lower === 'stats' || lower === 'collections'
                    || collectionIds.has(lower);
            },
        );

        for (const [actualKey, group] of playerGroups) {
            const statDef = settings.playerStats.find(s => s.name.toLowerCase() === actualKey.toLowerCase());
            const merged = combineStatValue(state.player.stats[actualKey], group, statDef);
            state.player.stats[actualKey] = constrainToDefinition(statDef, merged, state.player.stats[actualKey]);
        }

        // Look for collections both in .collections and at top level
        const collectionsToProcess = { ...(update.player.collections || {}) };
        Object.keys(update.player).forEach(key => {
            const lowerKey = key.toLowerCase();
            if (collectionIds.has(lowerKey) && lowerKey !== 'stats' && lowerKey !== 'collections' && lowerKey !== 'name') {
                debugLog(`Found flattened collection "${key}" in player update`);
                collectionsToProcess[key] = update.player[key];
            }
        });

        Object.keys(collectionsToProcess).forEach(colId => {
            applyCollectionUpdate(state.player, colId, collectionsToProcess[colId], { allowReplace });
        });
        // Only an update that named the player's collections is allowed to shrink the
        // stored copy. Everything else merges, so a stats-only turn cannot empty them.
        statedPlayerCollections = Object.keys(collectionsToProcess).length > 0;
    }
    
    if (update.characters && Array.isArray(update.characters)) {
        // AI provided a list of characters.
        // We will update existing characters or add new ones. We do NOT remove existing characters.
        let hasOverridesUpdates = false;
        const validCharKeys = new Set(settings.npcStats.map(s => s.name.toLowerCase()));
        const collectionIds = new Set(settings.collections.map(c => c.id.toLowerCase()));

        // Create lookup maps for performance (Step 3: Reduce Redundant Logic)
        const stateCharMap = new Map(
            state.characters
                .filter(c => c && typeof c.name === 'string')
                .map(c => [c.name.toLowerCase(), c])
);
        const settingsChars = getSettings().characters;
        const settingsCharMap = new Map();
        const settingsCharRegexList = [];
        
        settingsChars.forEach(c => {
            if (c.name) settingsCharMap.set(c.name.toLowerCase(), c);
            if (c.aliases) {
                c.aliases.forEach(a => {
                    if (a.isRegex) {
                        try { settingsCharRegexList.push({ regex: new RegExp(a.pattern, 'i'), char: c }); } catch { /* skip invalid regex */ }
                    } else if (a.pattern) {
                        settingsCharMap.set(a.pattern.toLowerCase(), c);
                    }
                });
            }
        });

        update.characters.forEach(updChar => {
            if (!updChar.name) return;
            // Through the alias map first. The narrator calls the same person different
            // things from line to line, and matching the raw name meant an update
            // addressed to an alias found nobody - then, in speakers mode, was dropped
            // as an invented character rather than applied to the character it named.
            const canonicalUpdName = resolveCanonicalName(updChar.name);
            const lowerUpdName = canonicalUpdName.toLowerCase();
            debugLog(`Applying update for character: ${updChar.name}`, updChar);
            
        // Find existing data for this character to preserve any stats not mentioned in the update
        let charData = stateCharMap.get(lowerUpdName);
        
        // Find character definition in settings
        let matchedChar = settingsCharMap.get(lowerUpdName) || settingsCharRegexList.find(r => r.regex.test(updChar.name))?.char;

        // In 'speakers' mode presence is decided by what appeared in the message, so a
        // character the model invents in its JSON must not silently join the scene.
        //
        if (!charData && settings.castMode === 'speakers' && !admitCharacters) {
            debugLog('Ignoring character not present in the message:', updChar.name);
            return;
        }

        // A history scan is the deliberate exception: it reads the whole story, and
        // almost everyone it has something to say about is off stage. Their card can
        // still be brought up to date - but they must not walk onto the stage to do it.
        // Admitting them to state.characters *is* joining the scene, which is how one
        // scan filled the tracker bar with the entire cast of the story.
        if (!charData && admitCharacters) {
            if (!matchedChar) {
                // Nowhere to keep it. Counted rather than dropped in silence.
                offstageSkipped.push(updChar.name);
                return;
            }
            const detached = updateCardOffstage(matchedChar, updChar, state, settings, { dryRun, allowReplace });
            // A dry run works on a throwaway clone, and the review panel can only show a
            // row for something the diff can see. Putting them in the clone gives the
            // panel its rows; the real apply above went to the card, so the scene itself
            // is untouched.
            if (dryRun && detached) state.characters.push(detached);
            return;
        }

        if (!charData) {
            // The third way into the cast, and the last one this guard was missing: an
            // update naming somebody who is not here yet builds them a row.
            if (!mayJoinScene(canonicalUpdName)) return;
            // The same construction the scene cast uses. It was written out again here,
            // which is why a character walking back on stage came back with their stats
            // restored from their card but none of their belongings - the two copies had
            // drifted, and only one of them knew about collections.
            charData = buildCharacterState(canonicalUpdName, state, settings);
            state.characters.push(charData);
            stateCharMap.set(lowerUpdName, charData);
        }
            
            if (bindingStat) {
                charData.boundTo = newBindingValue !== null ? newBindingValue : '';
            }
            
            const sourceStats = updChar.stats || updChar;

            const charGroups = groupIncomingStats(
                sourceStats,
                (name) => {
                    const matched = findMatchingStatKey(charData.stats, name) || name;
                    return validCharKeys.has(matched.toLowerCase()) ? matched : null;
                },
                (key) => validCharKeys.has(key.toLowerCase()),
                (key) => {
                    const lower = key.toLowerCase();
                    return lower === 'name' || lower === 'stats' || lower === 'boundto'
                        || lower === 'collections' || collectionIds.has(lower);
                },
            );

            for (const [canonicalKey, group] of charGroups) {
                const statDef = settings.npcStats.find(s => s.name.toLowerCase() === canonicalKey.toLowerCase());
                const merged = combineStatValue(charData.stats[canonicalKey], group, statDef);
                charData.stats[canonicalKey] = constrainToDefinition(statDef, merged, charData.stats[canonicalKey]);

                // The card object lives in settings, not in the cloned state, so a dry
                // run must not touch it at all - skipping the save would still leave the
                // mutation in memory for the next unrelated save to persist.
                if (matchedChar && !dryRun) {
                    if (!matchedChar.statusOverrides) matchedChar.statusOverrides = {};
                    // Record the combined result rather than the raw fragment, so a card
                    // override is never left holding just a "_max" half.
                    matchedChar.statusOverrides[canonicalKey] = charData.stats[canonicalKey];
                    hasOverridesUpdates = true;
                }
            }

            // Look for collections both in .collections and at top level
            const collectionsToProcess = { ...(updChar.collections || {}) };
            Object.keys(updChar).forEach(key => {
                const lowerKey = key.toLowerCase();
                if (collectionIds.has(lowerKey) && lowerKey !== 'stats' && lowerKey !== 'collections' && lowerKey !== 'name') {
                    debugLog(`Found flattened collection "${key}" in character update for ${updChar.name}`);
                    collectionsToProcess[key] = updChar[key];
                }
            });

            Object.keys(collectionsToProcess).forEach(colId => {
                applyCollectionUpdate(charData, colId, collectionsToProcess[colId], { allowReplace });
            });

            // Keep them on the card too, so what this character carries and knows
            // outlives their time on stage. Same reasoning as statusOverrides above, and
            // the same dry-run rule: the card lives in settings, not in the cloned state.
            if (matchedChar && !dryRun && Object.keys(collectionsToProcess).length) {
                matchedChar.statusCollections = structuredClone(charData.collections || {});
                hasOverridesUpdates = true;
            }
        });

        if (hasOverridesUpdates) {
            saveSettings();
        }
    }
    
    // Scene binding is the *other* way of deciding who left. Running both would give
    // two authorities over the same list, so it only applies in 'ai' cast mode.
    if (settings.castMode !== 'speakers'
        && bindingStat && oldBindingValue !== null && newBindingValue !== null
        && oldBindingValue !== newBindingValue) {
        state.characters = state.characters.filter(char => char.boundTo === newBindingValue);
    }
    
    state.timestamp = Date.now();

    // Hung off the returned state so a caller can report what it could not place,
    // without changing the shape every other caller reads.
    if (offstageSkipped.length) {
        Object.defineProperty(state, 'offstageSkipped', {
            value: offstageSkipped, enumerable: false, configurable: true,
        });
    }

    if (dryRun) return state;

    saveStateToMetadata(state, { label });
    syncPlayerToMaster(state, { authoritative: statedPlayerCollections });
    eventSource.emit('sillynpc-status-updated', state);
    return state;
}

/**
 * The character card a name belongs to: the card's own name first, then its aliases.
 *
 * @param {string} name
 * @returns {object|null}
 */
export function findCardForName(name) {
    if (!name) return null;
    const lower = String(name).trim().toLowerCase();
    const cards = getSettings().characters || [];

    const byName = cards.find(c => (c.name || '').toLowerCase() === lower);
    if (byName) return byName;

    for (const card of cards) {
        for (const alias of card.aliases || []) {
            if (!alias?.pattern) continue;
            if (alias.isRegex) {
                try { if (new RegExp(alias.pattern, 'i').test(name)) return card; } catch { /* invalid regex */ }
            } else if (alias.pattern.trim().toLowerCase() === lower) {
                return card;
            }
        }
    }
    return null;
}

/**
 * The name a character should be stored under.
 *
 * Aliases collapse onto the card's own name, so a character the narrator calls
 * "Instructor Kovacs" in one line and "Mr. Kovacs" in the next is one row in the cast
 * rather than two. A name with no card is its own canonical form - unknown characters
 * are tracked too, and there is nothing to collapse them onto.
 *
 * @param {string} name
 * @returns {string}
 */
export function resolveCanonicalName(name) {
    return findCardForName(name)?.name || String(name ?? '').trim();
}

/** This name is you. You are the player, and the player is not one of the cast. */
export const CAST_PERSONA = 'persona';
/** Not a character at all - narration the reader mistook for somebody speaking. */
export const CAST_EXCLUDED = 'excluded';

/**
 * Standing decisions about who is not an NPC in this chat.
 *
 * Kept in the chat rather than the settings, beside the item rules, and for the same
 * reason: "Alex is me" is true in this story, and another chat may have a real
 * character of that name. The extension cannot tell the two apart - which is why this is
 * a decision somebody makes rather than a name match - so it must not carry one chat's
 * answer into another.
 *
 * One map, name to reason, rather than two lists. Both reasons keep the name out of the
 * cast; recording which one it was is what lets the panel say why, and lets "this is me"
 * come to mean more later without every entry being re-decided.
 *
 * @returns {Record<string, 'persona'|'excluded'>} Keyed by lowercased canonical name.
 */
export function getCastDecisions() {
    try {
        const map = loadStateFromMetadata()?.castDecisions;
        return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    } catch {
        return {};
    }
}

/**
 * Records, or clears, what somebody is.
 *
 * @param {string} name
 * @param {'persona'|'excluded'|null} reason Null lets them back into the scene.
 * @returns {boolean} True when anything changed.
 */
export function setCastDecision(name, reason) {
    const key = resolveCanonicalName(name).toLowerCase();
    if (!key) return false;

    const state = loadStateFromMetadata();
    if (!state.castDecisions || typeof state.castDecisions !== 'object') state.castDecisions = {};

    if (reason === null || reason === undefined) {
        if (!(key in state.castDecisions)) return false;
        delete state.castDecisions[key];
    } else {
        if (state.castDecisions[key] === reason) return false;
        state.castDecisions[key] = reason;
        // Out of the scene now as well as in future: a decision that only takes effect
        // next time reads as having been ignored.
        state.characters = (state.characters || [])
            .filter(c => resolveCanonicalName(c.name).toLowerCase() !== key);
    }

    saveStateToMetadata(state, { label: reason ? 'Cast decision' : 'Cast decision cleared' });
    return true;
}

/**
 * Your own portrait, for a speaker label you have said is you.
 *
 * "This is me" kept the name out of the cast and stopped there, so the chat still drew the
 * same blank stand-in it gives any name it has never heard of - which reads as the decision
 * having been ignored. The persona has a picture and a sheet already; this is what lets a
 * line the model wrote as "Alex:" use them.
 *
 * Deliberately outranks a card of the same name, as the decision does everywhere else: it
 * was made about this name, in this chat, by you.
 *
 * @param {string} name The speaker label as it was written.
 * @returns {{ name: string, imageUrl: string } | null} Null when this is not you.
 */
export function resolvePersonaSpeaker(name) {
    // No blank-name guard: setCastDecision refuses to record one, so a nameless speaker
    // has no decision to find and falls out here like anybody else undecided.
    const canonical = resolveCanonicalName(name);
    if (getCastDecisions()[canonical.toLowerCase()] !== CAST_PERSONA) return null;

    const persona = resolvePersonaAvatarAndName();
    // The player's own portrait wins, since that is the face they made for this character.
    // The persona picture stays as the fallback here rather than the blank the sheet
    // shows: a line in the chat needs something beside it either way.
    return {
        name: persona.name,
        imageUrl: getPlayerImageUrl() || getUserAvatar(persona.avatar),
    };
}

/**
 * Whether this name is allowed to be a character in this chat.
 *
 * The one gate every admission goes through. There are three ways into the cast - the
 * chat decorator, the extractor, and an update that names somebody new - and they used to
 * disagree: the Not Speakers list guarded only the first, so a label you had excluded was
 * still reported into the scene by the second. Asking one question in one place is what
 * stops them drifting apart again.
 *
 * A card always wins, as it does for speaker detection: somebody genuinely called "Guide"
 * is not silenced by "guide" being on a list of things that are not people. A decision
 * made here is not overridden that way, because it was made about this character.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function mayJoinScene(name) {
    const canonical = resolveCanonicalName(name);
    if (!canonical) return false;
    if (getCastDecisions()[canonical.toLowerCase()]) return false;

    // Only for names nobody has made a card for.
    if (findCardForName(canonical)) return true;
    return !getIgnoredSpeakerLabels().has(normaliseSpeakerLabel(canonical));
}

/**
 * Folds cast rows that turn out to be the same character onto one another.
 *
 * Presence used to match on the raw detected name, so an alias produced a second row
 * with its own stats. Repairs existing state as well as preventing new duplicates: a
 * chat that already has both spellings heals on the next message.
 *
 * @param {object} state
 * @returns {boolean} True when anything was merged or renamed.
 */
function mergeDuplicateCharacters(state) {
    const kept = new Map();
    const out = [];
    let changed = false;

    for (const character of state.characters || []) {
        const canonical = resolveCanonicalName(character.name);
        const key = canonical.toLowerCase();
        const existing = kept.get(key);

        if (!existing) {
            if (character.name !== canonical) { character.name = canonical; changed = true; }
            kept.set(key, character);
            out.push(character);
            continue;
        }

        // Whichever was seen more recently describes the character better; the other
        // only fills gaps, so nothing recorded under either spelling is lost.
        const existingTick = Number(existing.lastSeenTick ?? -1);
        const incomingTick = Number(character.lastSeenTick ?? -1);
        const [fresh, stale] = incomingTick > existingTick ? [character, existing] : [existing, character];

        existing.stats = { ...stale.stats, ...fresh.stats };
        existing.collections = mergeCollectionMaps(stale.collections || {}, fresh.collections || {});
        existing.lastSeenTick = Math.max(existingTick, incomingTick);
        if (fresh.boundTo !== undefined) existing.boundTo = fresh.boundTo;
        existing.name = canonical;
        changed = true;
    }

    if (changed) state.characters = out;
    return changed;
}

/**
 * Reconciles who is in the scene from what actually appeared in a message.
 *
 * Scene membership used to depend on the model maintaining an exact cast list while
 * also updating the scene-binding stat. Four failure modes came out of that, the worst
 * being that a narrative which moved to a new location without touching the binding
 * stat left every previous character in the tracker forever.
 *
 * Presence signals for one message are the union of everyone detected speaking in it
 * and (when the extraction pass runs) everyone it reports present - a character can be
 * in a scene without having a line. Anyone in neither, for castGraceMessages messages
 * running, leaves.
 *
 * Idempotent per message: re-rendering the same message does not advance the clock, and
 * a second call for the same message adds to that message's signals rather than
 * replacing them.
 *
 * Two kinds of signal arrive here. Speaker detection only knows who *spoke*, so a
 * character standing silently must not be dropped - hence the grace period. The
 * extraction pass answers a stronger question, "who is present", and returns a
 * complete cast; that can be trusted to remove people immediately, which is what makes
 * a scene change take effect at once rather than three messages later.
 *
 * @param {string[]} names Characters observed in this message.
 * @param {string|number} messageId The message these observations came from.
 * @param {{ authoritative?: boolean }} [options] authoritative:true means "this is the
 *   complete cast" - anyone absent leaves now, grace period notwithstanding.
 * @returns {boolean} True when the scene changed and was saved.
 */
export function reconcileScenePresence(names, messageId, options = {}) {
    const settings = getSettings().statusTracker;
    if (settings.castMode !== 'speakers') return false;

    const state = structuredClone(committedState || loadStateFromMetadata());
    if (!state.presence || typeof state.presence !== 'object') {
        state.presence = { tick: 0, messageId: null, seen: [] };
    }
    const presence = state.presence;
    const key = String(messageId);

    // Collapse aliases before anything is matched or created, or the same character
    // arrives twice under two spellings and gets two rows with two sets of stats.
    // Anyone the reader has been told is not a character is dropped here rather than
    // admitted and removed again - both the decorator and the extractor arrive through
    // this function, which is what makes one decision cover both.
    const incoming = (names || []).map(n => resolveCanonicalName(n)).filter(n => n && mayJoinScene(n));

    // Repairs a chat that already has both spellings, as well as preventing new ones.
    let changed = mergeDuplicateCharacters(state);

    // Signals recorded before aliases were resolved are still in alias form, and would
    // read as absent against the canonical cast.
    const normalisedSeen = [];
    for (const name of presence.seen || []) {
        const canonical = resolveCanonicalName(name);
        if (!normalisedSeen.some(n => n.toLowerCase() === canonical.toLowerCase())) {
            normalisedSeen.push(canonical);
        }
    }
    if (normalisedSeen.join('|') !== (presence.seen || []).join('|')) changed = true;
    presence.seen = normalisedSeen;

    if (presence.messageId !== key) {
        // A new message: the clock advances and this message's signals start fresh.
        presence.tick = (Number(presence.tick) || 0) + 1;
        presence.messageId = key;
        presence.seen = [];
    }
    for (const name of incoming) {
        if (!presence.seen.some(n => n.toLowerCase() === name.toLowerCase())) presence.seen.push(name);
    }

    const seenLower = new Set(presence.seen.map(n => n.toLowerCase()));
    const grace = Math.max(0, Number(settings.castGraceMessages ?? 3));

    // Everyone observed is present now.
    for (const name of presence.seen) {
        const existing = state.characters.find(ch => ch.name.toLowerCase() === name.toLowerCase());
        if (existing) {
            if (existing.lastSeenTick !== presence.tick) { existing.lastSeenTick = presence.tick; changed = true; }
        } else {
            state.characters.push(buildCharacterState(name, state, settings));
            state.characters.at(-1).lastSeenTick = presence.tick;
            changed = true;
        }
    }

    // Anyone unseen for long enough leaves.
    const survivors = state.characters.filter(ch => {
        if (seenLower.has(ch.name.toLowerCase())) return true;
        // A complete cast list makes absence conclusive rather than merely unobserved.
        if (options.authoritative) return false;
        // Characters that predate presence tracking get this tick as their baseline
        // rather than being dropped immediately.
        if (ch.lastSeenTick === undefined) { ch.lastSeenTick = presence.tick; return true; }
        return (presence.tick - ch.lastSeenTick) < grace;
    });
    if (survivors.length !== state.characters.length) {
        debugLog('Scene presence: dropping',
            state.characters.filter(ch => !survivors.includes(ch)).map(ch => ch.name));
        state.characters = survivors;
        changed = true;
    }

    if (!changed) return false;

    state.timestamp = Date.now();
    // Not an undo step. Who is on stage is re-derived from the messages on every render,
    // so this fires several times a second while a chat loads - ten of them wiped the
    // entire undo ring in four seconds, and took the only copy of a story's stats with
    // it. Presence is not something anyone means to undo.
    saveStateToMetadata(state, { label: 'Scene cast', recordHistory: false });
    eventSource.emit('sillynpc-status-updated', state);
    return true;
}

/**
 * Builds a fresh character state seeded from the NPC schema and any card overrides.
 * Shared by presence reconciliation and registerActiveCharacter.
 */
/**
 * Brings a character's card up to date while they are elsewhere.
 *
 * The scene cast and the record of what a character owns used to be the same list, so
 * the only way to update someone was to put them in the room. This writes to the card
 * instead: buildCharacterState reads it back the moment they next appear, so nothing is
 * lost and nobody is teleported into a scene they are not in.
 *
 * @param {object} card The character card from settings.
 * @param {object} updChar The character's portion of the update.
 * @param {object} state Current state, read for defaults only.
 * @param {object} settings Tracker settings.
 * @param {{dryRun?: boolean}} options
 */
function updateCardOffstage(card, updChar, state, settings, { dryRun = false, allowReplace = false } = {}) {
    // A detached actor: built the same way the cast builds one, so it starts from what
    // the card already knows rather than from nothing.
    const actor = buildCharacterState(card.name, state, settings);

    const validKeys = new Set((settings.npcStats || []).map(s => s.name.toLowerCase()));
    const sourceStats = updChar.stats || {};
    for (const [key, value] of Object.entries(sourceStats)) {
        const matched = findMatchingStatKey(actor.stats, key) || key;
        if (!validKeys.has(matched.toLowerCase())) continue;
        actor.stats[matched] = String(value);
    }

    const collectionIds = new Set((settings.collections || []).map(c => c.id.toLowerCase()));
    const collectionsToProcess = { ...(updChar.collections || {}) };
    for (const key of Object.keys(updChar)) {
        const lower = key.toLowerCase();
        if (collectionIds.has(lower) && lower !== 'stats' && lower !== 'collections' && lower !== 'name') {
            collectionsToProcess[key] = updChar[key];
        }
    }
    for (const colId of Object.keys(collectionsToProcess)) {
        applyCollectionUpdate(actor, colId, collectionsToProcess[colId], { allowReplace });
    }

    if (dryRun) return actor;

    card.statusOverrides = { ...(card.statusOverrides || {}), ...actor.stats };
    if (Object.keys(collectionsToProcess).length) {
        card.statusCollections = structuredClone(actor.collections || {});
    }
    saveSettings();
    debugLog(`Updated ${card.name} on their card without adding them to the scene`);
    return actor;
}

function buildCharacterState(charName, state, trackerSettings) {
    const charData = { name: charName, stats: {}, collections: {} };
    if (trackerSettings.sceneBindingStat) {
        charData.boundTo = state.global[trackerSettings.sceneBindingStat] ?? '';
    }
    const matchedChar = (getSettings().characters || [])
        .find(c => (c.name || '').toLowerCase() === charName.toLowerCase());

    (trackerSettings.npcStats || []).forEach(stat => {
        let value = stat.defaultValue || '';
        const override = matchedChar?.statusOverrides?.[stat.name];
        if (override !== undefined && String(override).trim() !== '') value = override;
        charData.stats[stat.name] = getInitialStatValue(value, resolveMaxValue(stat));
    });

    // What they were carrying and knew last time they were on stage.
    //
    // The scene cast is the only place a character's collections used to live, and
    // leaving the scene deleted the entry - so an NPC's spells and inventory survived
    // exactly as long as they were in the room. Their card keeps them now, the same way
    // it already keeps their stats.
    if (matchedChar?.statusCollections) {
        charData.collections = structuredClone(matchedChar.statusCollections);
    }
    return charData;
}

/**
 * Registers a character as active in the scene based on a matched setting character.
 */
export function registerActiveCharacter(charName) {
    if (!charName) return;
    if (!mayJoinScene(charName)) return false;

    const state = structuredClone(committedState || loadStateFromMetadata());
    const settings = getSettings();
    const trackerSettings = settings.statusTracker;
    
    const existingChar = state.characters.find(c => c.name.toLowerCase() === charName.toLowerCase());
    if (existingChar) return false; // Already registered

    const charData = { name: charName, stats: {}, collections: {} };
    if (trackerSettings.sceneBindingStat) {
        charData.boundTo = state.global[trackerSettings.sceneBindingStat] !== undefined ? state.global[trackerSettings.sceneBindingStat] : '';
    }
    
    const settingsChars = settings.characters;
    const matchedChar = settingsChars.find(c => c.name.toLowerCase() === charName.toLowerCase());

    trackerSettings.npcStats.forEach(s => {
        let value = s.defaultValue || '';
        if (matchedChar && matchedChar.statusOverrides && matchedChar.statusOverrides[s.name] !== undefined && String(matchedChar.statusOverrides[s.name]).trim() !== '') {
            value = matchedChar.statusOverrides[s.name];
        }
        charData.stats[s.name] = getInitialStatValue(value, s.maxStatValue);
    });

    state.characters.push(charData);
    state.timestamp = Date.now();
    saveStateToMetadata(state);
    return true; // Indicates state changed
}

/**
 * Removes an active character from the scene.
 */
export function removeActiveCharacter(charName) {
    if (!charName) return;
    
    const state = JSON.parse(JSON.stringify(committedState || loadStateFromMetadata()));
    const initialLen = state.characters.length;
    
    state.characters = state.characters.filter(c => c.name.toLowerCase() !== charName.toLowerCase());
    
    if (state.characters.length !== initialLen) {
        state.timestamp = Date.now();
        saveStateToMetadata(state);
        return true;
    }
    return false;
}

/**
 * Logic to handle collection updates (add, remove, update)
 * @param {ActorState} actor 
 * @param {string} collectionId 
 * @param {Object} update 
 */
/**
 * An item with every configured field present, defaulted and of the right type.
 *
 * This lived inside the full-replace branch only, so an item arriving through the
 * normal delta path - which is every item the per-message extractor adds - kept
 * whatever the model sent and never gained the fields it did not mention. A new item
 * therefore turned up holding little more than a name, with a quantity of "3" stored
 * as text beside another stored as a number.
 *
 * Fields the message did not state are filled from the schema default rather than
 * guessed: a blank is an honest record that the story never said so.
 *
 * @param {object} itemData Raw item from a reply, or from the master database.
 * @param {Array<object>} fields The collection's configured fields.
 * @returns {object}
 */
/**
 * One item, with every field the schema declares, typed and within its allowed values.
 *
 * `previous` is the item as it stands, when there is one. Without it a value already
 * stored off-list would be refused on every later write - narrowing a list in the builder
 * would then rewrite items nobody was editing, which is exactly what keeping the old value
 * is meant to prevent.
 */
function normaliseItem(itemData, fields, previous = null) {
    const out = {};
    for (const fieldDef of fields || []) {
        let val = constrainToDefinition(fieldDef, itemData?.[fieldDef.name], previous?.[fieldDef.name]);

        if (val === undefined || val === null) {
            val = fieldDef.defaultValue !== undefined && fieldDef.defaultValue !== ''
                ? fieldDef.defaultValue
                : (fieldDef.type === 'number' ? 0 : (fieldDef.type === 'boolean' ? false : ''));
        }

        if (fieldDef.type === 'number') {
            out[fieldDef.name] = parseFloat(val) || 0;
        } else if (fieldDef.type === 'boolean') {
            out[fieldDef.name] = (val === true || val === 'true');
        } else {
            out[fieldDef.name] = String(val);
        }
    }
    return out;
}
function applyCollectionUpdate(actor, collectionId, update, { allowReplace = false } = {}) {
    const settings = getSettings().statusTracker;
    const colDef = settings.collections.find(c => c.id.toLowerCase() === collectionId.toLowerCase());
    
    // Validate collection exists
    if (!colDef) {
        console.warn(LOG_PREFIX, `Attempted to update non-existent collection: ${collectionId}`);
        return;
    }

    const actualCollectionId = colDef.id;

    // Validate target
    const isPlayer = actor.name === getCurrentPersonaName(); // Simple check for player
    if (isPlayer && colDef.target === 'npc') {
        debugLog(`Blocked collection update: ${collectionId} is NPC-only, but target is player.`);
        return;
    }
    if (!isPlayer && colDef.target === 'player') {
        debugLog(`Blocked collection update: ${collectionId} is player-only, but target is NPC (${actor.name}).`);
        return;
    }

    if (!actor.collections) actor.collections = {};
    
    // A bare array used to mean "this is everything" whatever asked for it, so a reply
    // that listed items instead of reporting changes emptied the collection and rebuilt
    // it from that list - deleting everything the reply happened not to restate. The
    // system prompt asks for {add, remove} and says omission is not removal; a small
    // model disobeys anyway, and the code has to survive that.
    //
    // Replacement is still right for the history scan, which reads the whole story to
    // produce a corrected list and puts it through the review panel. It is never right
    // for a single message, so the caller has to say so.
    // An explicit replacement: code that rebuilt the list itself and means it. Said in
    // the data rather than through an option on the call, because the flag had to be
    // remembered by every caller of buildUpdateFromChanges and three of the four forgot -
    // so an accepted removal was read as a list of additions and the item never left.
    if (update && !Array.isArray(update) && Array.isArray(update.replace)) {
        return applyCollectionUpdate(actor, collectionId, update.replace, { allowReplace: true });
    }

    if (Array.isArray(update) && !allowReplace) {
        debugLog(`Collection "${actualCollectionId}" arrived as a list; treating it as additions.`);
        return applyCollectionUpdate(actor, collectionId, { add: update }, { allowReplace });
    }
    // Handle Full State Sync (Array)
    if (Array.isArray(update)) {
        actor.collections[actualCollectionId] = [];
        const validFields = colDef.fields;
        const primaryField = validFields.find(f => f.isPrimary) || { name: 'name' };

        update.forEach(itemData => {
            if (!itemData || typeof itemData !== 'object') return;
            
            const itemName = itemData[primaryField.name] || itemData.name;
            if (!String(itemName ?? '').trim()) return;

            // Skip if recently deleted (tombstone)
            const lowerName = String(itemName).toLowerCase();
            const state = committedState || loadStateFromMetadata();
            if (state && state.recently_deleted && state.recently_deleted[actualCollectionId] && state.recently_deleted[actualCollectionId][lowerName]) {
                debugLog(`Skipping tombstoned item: ${itemName} in ${actualCollectionId}`);
                return;
            }

            // Master Database Merge Logic
            const masterItem = getMergedItem(actualCollectionId, itemData);

            actor.collections[actualCollectionId].push(normaliseItem(masterItem, validFields));
        });
        return;
    }

    if (!actor.collections[actualCollectionId]) actor.collections[actualCollectionId] = [];
    
    // Handle Delta Update (Object)
    // Handle "clear"
    if (update.clear === true) {
        actor.collections[actualCollectionId] = [];
        return;
    }

    // Handle "add"
    if (Array.isArray(update.add)) {
            for (const itemData of update.add) {
                const primaryField = colDef.fields.find(f => f.isPrimary) || { name: 'name' };
                const itemName = itemData[primaryField.name] || itemData.name;
                const lowerName = String(itemName).toLowerCase();
                const state = committedState || loadStateFromMetadata();
                
                if (state?.recently_deleted?.[actualCollectionId]?.[lowerName]) {
                    debugLog(`Skipping AI-added tombstoned item: ${itemName} in ${actualCollectionId}`);
                    continue;
                }
                addItem(actor, actualCollectionId, itemData);
            }
    }

    // Handle "remove"
    if (Array.isArray(update.remove)) {
        for (const itemName of update.remove) removeItem(actor, actualCollectionId, itemName);
    }

    // Handle "update"
    if (Array.isArray(update.update)) {
        for (const upd of update.update) {
            if (upd.name) updateItem(actor, actualCollectionId, upd.name, upd);
        }
    }
}

/**
 * Adds an item to an actor's collection.
 */
export function addItem(actor, collectionId, itemData) {
    if (!actor.collections) actor.collections = {};
    if (!actor.collections[collectionId]) actor.collections[collectionId] = [];
    
    const settings = getSettings().statusTracker;
    const colDef = settings.collections.find(c => c.id === collectionId);
    if (!colDef) return;

    const primaryField = colDef.fields.find(f => f.isPrimary) || { name: 'name' };
    const itemName = itemData[primaryField.name] !== undefined ? itemData[primaryField.name] : itemData.name;
    if (itemName === undefined || itemName === null) return;

    // Clear from recently_deleted if it was there
    const lowerName = String(itemName).toLowerCase();
    const state = committedState || loadStateFromMetadata();
    if (state && state.recently_deleted && state.recently_deleted[collectionId]) {
        if (state.recently_deleted[collectionId][lowerName]) {
            delete state.recently_deleted[collectionId][lowerName];
        }
    }

    const validFields = new Set(colDef.fields.map(f => f.name));

    // Filter fields to only allowed ones
    const filteredItem = { [primaryField.name]: itemName };
    Object.keys(itemData).forEach(key => {
        if (validFields.has(key)) {
            filteredItem[key] = itemData[key];
        }
    });

    // Find if item with same primary field value exists (case-insensitive)
    const existingIndex = actor.collections[collectionId].findIndex(i => String(i[primaryField.name]).toLowerCase() === String(itemName).toLowerCase());
    
    if (existingIndex !== -1) {
        const existing = actor.collections[collectionId][existingIndex];
        // Merge fields
        const merged = { ...existing, ...filteredItem };
        
        // Handle quantity merging if a numeric quantity field exists
        const qtyField = colDef.fields.find(f => f.type === 'number' && (f.name === 'quantity' || f.name === 'qty' || f.name === 'count'));
        if (qtyField) {
            const fieldName = qtyField.name;
            if (existing[fieldName] !== undefined && filteredItem[fieldName] !== undefined) {
                const q1 = parseFloat(existing[fieldName]) || 0;
                const q2 = parseFloat(filteredItem[fieldName]) || 0;
                // The same number that is already held is the model restating the state,
                // not the character acquiring a second lot. Summing it doubled the
                // quantity on every message that mentioned the item, compounding in
                // silence - and asked the review panel to confirm the same doubling over
                // and over.
                //
                // The two cannot be told apart from the delta alone, so this picks the
                // safer error: finding exactly two more rope while already holding two is
                // missed, which the story shows and a person can correct. The other way
                // round grows without bound and reads as the tracker inventing loot.
                //
                // Judged on the quantity alone rather than on the whole item: an add that
                // corrects some other field - a note, a description - is a real update,
                // and the quantity coming along with it unchanged must not be doubled for
                // having been mentioned.
                if (q1 !== q2) merged[fieldName] = q1 + q2;
            }
        }

        // Normalised like any other item: the merge could otherwise leave a quantity the
        // model sent as text sitting beside one already stored as a number.
        actor.collections[collectionId][existingIndex] = normaliseItem(merged, colDef.fields, existing);
    } else {
        // This branch filled in defaults but never enforced types, so an item added
        // through the delta path - which is every item the per-message extractor adds -
        // kept "4" as a string where the replace path would have stored 4.
        actor.collections[collectionId].push(normaliseItem(filteredItem, colDef.fields));
    }
}

/**
 * Removes an item from an actor's collection by name.
 */
export function removeItem(actor, collectionId, itemName, isManual = false) {
    if (!actor.collections || !actor.collections[collectionId] || !itemName) return;
    
    const settings = getSettings().statusTracker;
    const colDef = settings.collections.find(c => c.id === collectionId);
    const primaryField = colDef ? colDef.fields.find(f => f.isPrimary) : { name: 'name' };
    const primaryFieldName = primaryField ? primaryField.name : 'name';

    const lowerName = String(itemName).toLowerCase();
    actor.collections[collectionId] = actor.collections[collectionId].filter(i => String(i[primaryFieldName]).toLowerCase() !== lowerName);

    if (isManual) {
        const state = committedState || loadStateFromMetadata();
        if (state && state.recently_deleted) {
            if (!state.recently_deleted[collectionId]) state.recently_deleted[collectionId] = {};
            state.recently_deleted[collectionId][lowerName] = 3; // TTL 3 messages
        }
    }
}

/**
 * Updates an item in an actor's collection.
 */
function updateItem(actor, collectionId, itemName, updates) {
    if (!actor.collections || !actor.collections[collectionId] || !itemName) return;
    
    const settings = getSettings().statusTracker;
    const colDef = settings.collections.find(c => c.id === collectionId);
    if (!colDef) return;

    const primaryField = colDef.fields.find(f => f.isPrimary) || { name: 'name' };
    const primaryFieldName = primaryField.name;
    const validFields = new Set(colDef.fields.map(f => f.name));

    const lowerName = String(itemName).toLowerCase();
    const itemIndex = actor.collections[collectionId].findIndex(i => String(i[primaryFieldName]).toLowerCase() === lowerName);
    
    if (itemIndex !== -1) {
        const item = actor.collections[collectionId][itemIndex];
        Object.keys(updates).forEach(key => {
            if (validFields.has(key)) {
                item[key] = updates[key];
            }
        });
    }
}

/**
 * Synchronizes a manual override change immediately into the active chat metadata state.
 */
export function syncOverrideToActiveState(charName, statName, newValue) {
    if (!charName || !statName) return false;
    
    // Attempt to load current state; if we don't have one, we can't sync.
    const state = loadStateFromMetadata();
    if (!state) return false;
    
    const existingChar = state.characters.find(c => c.name.toLowerCase() === charName.toLowerCase());
    if (existingChar) {
        if (newValue === '') {
            const settings = getSettings().statusTracker;
            const statDef = settings.npcStats.find(s => s.name === statName);
            existingChar.stats[statName] = statDef ? (statDef.defaultValue || '') : '';
        } else {
            existingChar.stats[statName] = newValue;
        }
        
        state.timestamp = Date.now();
        saveStateToMetadata(state);
        return true;
    }
    
    return false;
}

/**
 * Merges an AI-provided item with its Master Database entry if it exists.
 * If not, adds the item to the Master Database.
 */
function getMergedItem(collectionId, aiItem) {
    const settings = getSettings();
    const colDef = settings.statusTracker.collections.find(c => c.id === collectionId);
    if (!colDef) return aiItem;

    const primaryField = colDef.fields.find(f => f.isPrimary) || { name: 'name' };
    const itemName = aiItem[primaryField.name] || aiItem.name;
    if (!itemName) return aiItem;

    const masterDb = settings.master_items || {};
    if (!masterDb[collectionId]) masterDb[collectionId] = {};
    
    const lowerName = String(itemName).toLowerCase();
    const masterEntry = masterDb[collectionId][lowerName];

    if (masterEntry) {
        const mergedItem = { ...aiItem };
        colDef.fields.forEach(field => {
            // Static fields come from Master DB if available
            const isStatic = field.isStatic !== false && (field.type !== 'number' || field.isPrimary);
            if (isStatic && masterEntry[field.name] !== undefined) {
                mergedItem[field.name] = masterEntry[field.name];
            }
        });
        return mergedItem;
    } else {
        // Not found, add to master
        updateMasterItem(collectionId, itemName, aiItem);
        return aiItem;
    }
}

/**
 * Updates a single item in the Master Database.
 * Only saves fields marked as static.
 */
export function updateMasterItem(collectionId, itemName, itemData) {
    const settings = getSettings();
    if (!settings.master_items) settings.master_items = {};
    if (!settings.master_items[collectionId]) settings.master_items[collectionId] = {};

    const colDef = settings.statusTracker.collections.find(c => c.id === collectionId);
    if (!colDef) return;

    const staticData = {};
    colDef.fields.forEach(field => {
        const isStatic = field.isStatic !== false && (field.type !== 'number' || field.isPrimary);
        if (isStatic && itemData[field.name] !== undefined) {
            staticData[field.name] = itemData[field.name];
        }
    });

    const lowerName = String(itemName).toLowerCase();
    settings.master_items[collectionId][lowerName] = staticData;
    saveSettings();
}

/**
 * Handles renaming an item in the Master Database.
 */
export function renameMasterItem(collectionId, oldName, newName, itemData) {
    const settings = getSettings();
    if (!settings.master_items || !settings.master_items[collectionId]) return;

    const oldLower = String(oldName).toLowerCase();
    const newLower = String(newName).toLowerCase();

    if (settings.master_items[collectionId][oldLower]) {
        delete settings.master_items[collectionId][oldLower];
    }
    
    updateMasterItem(collectionId, newName, itemData);
}

/**
 * Removes an item from the Master Database.
 */
export function deleteMasterItem(collectionId, itemName) {
    const settings = getSettings();
    if (!settings.master_items || !settings.master_items[collectionId]) return;

    const lowerName = String(itemName).toLowerCase();
    if (settings.master_items[collectionId][lowerName]) {
        debugLog(`Deleting master item: ${itemName} from ${collectionId}`);
        delete settings.master_items[collectionId][lowerName];
        saveSettings();
    }
}

/**
 * Moves every stored item from one collection id to another.
 *
 * Chat state (actor.collections[id]) and the Master Database
 * (settings.master_items[id]) are both keyed by the collection id, so renaming a
 * collection without this leaves all of its items stranded under the old key.
 *
 * @param {string} oldId
 * @param {string} newId
 * @returns {number} How many stores held items under the old id, so the caller can say
 *   what was carried across rather than leaving the user to check.
 */
export function renameCollectionId(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return 0;

    let moved = 0;
    const settings = getSettings();

    // Master Database
    const master = settings.master_items;
    if (master && master[oldId]) {
        master[newId] = { ...(master[newId] || {}), ...master[oldId] };
        moved += Object.keys(master[oldId]).length;
        delete master[oldId];
    }

    // Persona master storage (all personas, not just the active one)
    for (const persona of Object.values(settings.personaData || {})) {
        const cols = persona?.collections;
        if (cols && cols[oldId] !== undefined) {
            moved += (cols[oldId] || []).length;
            cols[newId] = cols[oldId];
            delete cols[oldId];
        }
    }

    // Character cards. Missing from this list until now, which was the worst of the
    // omissions: a card is what a character walks back into a scene carrying, so a rename
    // left everyone off stage to return empty-handed - and the items were still in the
    // settings file under the old key, invisible and unreachable.
    for (const card of settings.characters || []) {
        const cols = card?.statusCollections;
        if (cols && cols[oldId] !== undefined) {
            moved += (cols[oldId] || []).length;
            cols[newId] = cols[oldId];
            delete cols[oldId];
        }
    }

    // Live chat state
    const state = committedState || loadStateFromMetadata();
    if (state) {
        const actors = [state.player, ...(state.characters || [])].filter(Boolean);
        for (const actor of actors) {
            if (actor.collections && actor.collections[oldId] !== undefined) {
                moved += (actor.collections[oldId] || []).length;
                actor.collections[newId] = actor.collections[oldId];
                delete actor.collections[oldId];
            }
        }
        if (state.recently_deleted && state.recently_deleted[oldId] !== undefined) {
            state.recently_deleted[newId] = state.recently_deleted[oldId];
            delete state.recently_deleted[oldId];
        }
        saveStateToMetadata(state);
    }

    saveSettings();
    return moved;
}

/** Which stores a stat list's values live in, and which rule scope points at it. */
const STAT_SCOPES = {
    globalStats: { ruleScope: 'global' },
    playerStats: { ruleScope: 'player' },
    npcStats: { ruleScope: 'characters' },
};

/** Moves one key of an object, keeping its position. @returns {boolean} whether it moved */
function moveKey(holder, oldName, newName) {
    if (!holder || typeof holder !== 'object' || !Object.hasOwn(holder, oldName)) return false;

    // The same collapse rule the collections use: if both keys are present, the one the
    // schema still knows about is the newer and is kept.
    const occupied = holder[newName] !== undefined && holder[newName] !== '' && holder[newName] !== null;
    const keep = occupied ? holder[newName] : holder[oldName];

    const entries = Object.entries(holder);
    for (const key of Object.keys(holder)) delete holder[key];
    let written = false;
    for (const [key, value] of entries) {
        if (key === oldName || key === newName) {
            if (!written) { holder[newName] = keep; written = true; }
        } else {
            holder[key] = value;
        }
    }
    return true;
}

/**
 * Renames a stat, carrying its stored values and the settings that point at it.
 *
 * Stats are keyed by their name in five places, and the builder used to change only the
 * name in the schema. Everything else then failed to find the stat and filled it in at
 * its default - which is why renaming "HP" to "Health" showed 100 where 300/3000 had
 * been, and why the HUD stopped drawing it as a meter: a bare default has no ceiling, and
 * only a value with one can be a meter.
 *
 * Nothing deleted the old values. They stayed under the old key, unreachable, which is
 * the reason this can be repaired at all rather than only prevented.
 *
 * References are machine-written and are moved with the stat: the scene binding, and any
 * time rule whose scope points at this list. The display template is only rewritten when
 * the old name is unambiguous - if another stat list still has a stat by that name, a
 * {{HP}} in the template may well mean that one, and rewriting it would break a working
 * template to fix one that is not.
 *
 * @param {'globalStats'|'playerStats'|'npcStats'} listKey
 * @param {string} oldName
 * @param {string} newName
 * @returns {{ values: number, references: number, templateUpdated: boolean, cssMentions: boolean }}
 */
export function renameStat(listKey, oldName, newName) {
    const empty = { values: 0, references: 0, templateUpdated: false, cssMentions: false };
    if (!STAT_SCOPES[listKey] || !oldName || !newName || oldName === newName) return empty;

    const settings = getSettings();
    const tracker = settings.statusTracker;
    let values = 0;
    let references = 0;

    const state = committedState || loadStateFromMetadata();

    if (listKey === 'globalStats' && state) {
        if (moveKey(state.global, oldName, newName)) values += 1;
    }

    if (listKey === 'playerStats') {
        if (state && moveKey(state.player?.stats, oldName, newName)) values += 1;
        // Every persona, not just the active one: the others are not loaded now but are
        // the same player returning to a different chat.
        for (const persona of Object.values(settings.personaData || {})) {
            if (moveKey(persona?.stats, oldName, newName)) values += 1;
        }
    }

    if (listKey === 'npcStats') {
        for (const actor of (state?.characters || [])) {
            if (moveKey(actor?.stats, oldName, newName)) values += 1;
        }
        // Character cards - what someone off stage walks back in carrying.
        for (const card of settings.characters || []) {
            if (moveKey(card?.statusOverrides, oldName, newName)) values += 1;
        }
        if (tracker.sceneBindingStat === oldName) {
            tracker.sceneBindingStat = newName;
            references += 1;
        }
    }

    // A rule names both the stat it changes and the stat it reads to decide whether to.
    const ruleScope = STAT_SCOPES[listKey].ruleScope;
    for (const rule of tracker.timeRules || []) {
        const scope = rule.scope === 'global' ? 'global'
            : rule.scope === 'characters' ? 'characters' : 'player';
        if (scope !== ruleScope) continue;
        if (rule.stat === oldName) { rule.stat = newName; references += 1; }
        if (rule.conditionStat === oldName) { rule.conditionStat = newName; references += 1; }
    }

    const otherLists = Object.keys(STAT_SCOPES).filter(k => k !== listKey);
    const stillUsedElsewhere = otherLists.some(key =>
        (tracker[key] || []).some(s => s?.name === oldName));

    let templateUpdated = false;
    if (!stillUsedElsewhere && typeof tracker.template === 'string') {
        // Only inside the braces, and only the whole name: a template that says "HP" in
        // its own prose is prose, and {{HPMax}} is a different stat.
        //
        // Except when the prose is the label. Text sitting immediately beside a
        // reference and reading exactly the old name is not a sentence, it is a caption
        // for the value next to it - so "HP [{{HP}}]" becomes "Health [{{Health}}]"
        // rather than a tracker that calls the field something nothing else does.
        // Done first: once the reference is rewritten there is no longer a pairing to
        // recognise.
        const word = String.fromCharCode(92) + 'p{L}' + String.fromCharCode(92) + 'p{N}_';
        const labelled = new RegExp(
            `(?<![${word}])${escapeRegExp(oldName)}(?![${word}])`
            + `([^{}]{0,4}?)`
            + `\\{\\{([#^/]?)${escapeRegExp(oldName)}\\}\\}`,
            'gu');

        const pattern = new RegExp(`\\{\\{([#^/]?)${escapeRegExp(oldName)}\\}\\}`, 'g');
        const rewritten = tracker.template
            .replace(labelled, `${newName}$1{{$2${newName}}}`)
            .replace(pattern, `{{$1${newName}}}`);
        if (rewritten !== tracker.template) {
            tracker.template = rewritten;
            templateUpdated = true;
        }
    }

    // Custom CSS is not rewritten. A selector can be built from a stat name in more ways
    // than can be recognised, and a wrong edit to someone's stylesheet is worse than a
    // sentence telling them where to look.
    const cssMentions = !stillUsedElsewhere
        && String(tracker.customCSS || '').toLowerCase().includes(oldName.toLowerCase());

    if (state) saveStateToMetadata(state);
    saveSettings();
    return { values, references, templateUpdated, cssMentions };
}


/**
 * Moves a stored value from one field name to another, everywhere it is kept.
 *
 * A rename in the builder used to be read as one field leaving and another arriving: the
 * old key was not in the schema any more, so the next write to that item filtered it out
 * and the value went with it. Silently, and item by item as each one happened to be
 * touched, which is the hardest kind of loss to notice.
 *
 * The key keeps its position in the object rather than being appended at the end. Nothing
 * reads items positionally, but a settings file where a rename shuffles every item is
 * harder to read and harder to diff.
 *
 * @param {string} collectionId
 * @param {string} oldName
 * @param {string} newName
 * @returns {number} How many items were changed - the caller says so, because a rename
 *   that moved nothing and a rename that moved forty items look identical otherwise.
 */
export function renameCollectionField(collectionId, oldName, newName) {
    if (!collectionId || !oldName || !newName || oldName === newName) return 0;

    let moved = 0;

    /** @param {object} item */
    const renameIn = (item) => {
        if (!item || typeof item !== 'object' || !Object.hasOwn(item, oldName)) return item;

        // A collision should not happen - the builder refuses a duplicate field name - but
        // if the item already carries the new key with something in it, that something is
        // the newer of the two and is not overwritten by a key the schema had abandoned.
        const occupied = item[newName] !== undefined && item[newName] !== '' && item[newName] !== null;
        const keep = occupied ? item[newName] : item[oldName];

        // Both keys collapse into one, written at whichever of the two came first. Deciding
        // the value up front rather than as the loop meets each key is what makes that true
        // in either order: written the other way, a stored {school, tradition} kept the
        // later key's value whatever the rule said, and only the reverse order tested it.
        const out = {};
        for (const [key, existing] of Object.entries(item)) {
            if (key === oldName || key === newName) {
                if (!Object.hasOwn(out, newName)) out[newName] = keep;
            } else {
                out[key] = existing;
            }
        }
        moved += 1;
        return out;
    };

    const renameInList = (list) => Array.isArray(list) ? list.map(renameIn) : list;

    const settings = getSettings();

    // The Master Database keeps one object per item name rather than a list.
    const master = settings.master_items?.[collectionId];
    if (master && typeof master === 'object') {
        for (const [itemName, itemData] of Object.entries(master)) {
            master[itemName] = renameIn(itemData);
        }
    }

    for (const persona of Object.values(settings.personaData || {})) {
        const cols = persona?.collections;
        if (cols?.[collectionId]) cols[collectionId] = renameInList(cols[collectionId]);
    }

    // Character cards - what a character walks back into a scene carrying.
    for (const card of settings.characters || []) {
        const cols = card?.statusCollections;
        if (cols?.[collectionId]) cols[collectionId] = renameInList(cols[collectionId]);
    }

    const state = committedState || loadStateFromMetadata();
    if (state) {
        for (const actor of [state.player, ...(state.characters || [])].filter(Boolean)) {
            const cols = actor.collections;
            if (cols?.[collectionId]) cols[collectionId] = renameInList(cols[collectionId]);
        }
        saveStateToMetadata(state);
    }

    saveSettings();
    return moved;
}

/**
 * What a system deliberately does NOT carry.
 *
 * Stated as an exclusion rather than a list of what to keep. A system used to capture
 * thirteen named keys, which meant every setting added afterwards was silently left
 * global - Time Rules, the clock, review thresholds, the lore and portrait prompts and
 * the lorebook selections all followed you from one ruleset into the next. An allow-list
 * falls behind by default; this way a new setting travels unless somebody decides it
 * should not.
 *
 * The line is your world versus your machine: everything about the fiction belongs to the
 * system, and the connections that do the work belong to you.
 */
const SYSTEM_EXCLUDED_ROOT = new Set([
    // Carried separately, as the world.
    'characters', 'personaData', 'master_items',
    // The library itself, and which system is open.
    'statusTracker', 'activeSystem', 'version', 'enabled',
    // Which provider makes images and where the files land: accounts and disk.
    'imageBackend', 'geminiImageModel', 'imageSaveRoute',
    'loreProfileId', 'imageProfileId',
    // Your window, not your world.
    'popupWidth', 'popupHeight',
]);

const SYSTEM_EXCLUDED_TRACKER = new Set([
    // The library lives inside statusTracker; a system must never contain itself.
    'presets',
    // Which connection reads, what it is capable of, and what it is allowed to spend.
    'extractionProfileId', 'scanProfileId',
    // How often to checkpoint is a habit, not a property of a ruleset.
    'systemAutoSaveMinutes', 'systemCheckpointsKept',
    'extractionMaxTokens', 'scanMaxTokens', 'extractionUseSchema',
    // Whether the tracker runs at all is not a property of a ruleset.
    'enabled',
]);

/** A deep copy of everything except the named keys. */
function copyExcept(source, excluded) {
    const out = {};
    for (const [key, value] of Object.entries(source || {})) {
        if (excluded.has(key)) continue;
        out[key] = structuredClone(value);
    }
    return out;
}

/** Writes a captured block back, skipping anything that block is not allowed to set. */
function assignExcept(target, source, excluded) {
    for (const [key, value] of Object.entries(source || {})) {
        if (excluded.has(key)) continue;
        target[key] = structuredClone(value);
    }
}

/**
 * The part of a system that is not configuration: who exists in it, what they carry, and
 * the player's records.
 *
 * A ruleset without its cast is only half a system. Changing from one to another used to
 * keep every character, the whole item library and the player's stats from the last one,
 * none of which fit - so the choice was to lose the work or live with the mismatch.
 */
function captureWorld(settings) {
    return {
        characters: structuredClone(settings.characters || []),
        personaData: structuredClone(settings.personaData || {}),
        master_items: structuredClone(settings.master_items || {}),
    };
}

/** @param {object|undefined} world Absent on any profile saved before systems carried one. */
function restoreWorld(settings, world) {
    if (!world) return false;
    // Emptied and refilled rather than reassigned: chat.js caches the character list by
    // identity, and replacing the reference would leave it holding the old system's cast.
    const characters = settings.characters;
    characters.splice(0, characters.length, ...structuredClone(world.characters || []));
    settings.personaData = structuredClone(world.personaData || {});
    settings.master_items = structuredClone(world.master_items || {});
    return true;
}

/** Writes the active system back to its slot. Always called before switching away. */
function captureActiveSystem() {
    const settings = getSettings();
    const active = settings.activeSystem;
    const existing = settings.statusTracker.presets?.[active];
    if (!active || !existing) return false;
    saveSystemPreset(active,
        existing.metadata?.description ?? '', existing.metadata?.author ?? 'User');
    return true;
}

/** The system currently in use. */
export function getActiveSystem() {
    return getSettings().activeSystem || '';
}

/** What makes one configuration recognisably the same system as another. */
function systemSignature(config) {
    // Either shape: a profile saved since systems carried everything nests its tracker
    // settings, one saved before that holds them flat.
    const tracker = config?.statusTracker || config || {};
    return JSON.stringify([
        (tracker.globalStats || []).map(s => s?.name),
        (tracker.npcStats || []).map(s => s?.name),
        (tracker.playerStats || []).map(s => s?.name),
        (tracker.collections || []).map(c => c?.id),
    ]);
}

function unusedSystemName(presets, base) {
    if (!presets[base]) return base;
    for (let i = 2; ; i++) if (!presets[`${base} ${i}`]) return `${base} ${i}`;
}

/**
 * Gives the configuration already in use a system to belong to.
 *
 * Runs once, when nothing is marked active. The configuration you are working in is
 * matched against the saved systems by which stats and collections it defines - a
 * configuration built from "Energy RPG" is still recognisably that system - so it adopts
 * the current characters and item library rather than a duplicate appearing beside it.
 * With no match, the live configuration becomes a system of its own.
 *
 * Either way the current world goes with it. Nothing is stranded, and nothing is deleted.
 *
 * @returns {boolean} Whether a migration happened.
 */
export function migrateToActiveSystem() {
    const settings = getSettings();
    if (settings.activeSystem) return false;

    const st = settings.statusTracker;
    const presets = st.presets || {};
    const live = systemSignature(st);
    const matches = Object.keys(presets)
        .filter(name => systemSignature(presets[name]?.config || {}) === live);

    // Two systems that define the same stats cannot be told apart, so neither is claimed.
    const name = matches.length === 1
        ? matches[0]
        : unusedSystemName(presets, 'Default System');

    const existing = presets[name];
    saveSystemPreset(name,
        existing?.metadata?.description ?? '', existing?.metadata?.author ?? 'User');
    settings.activeSystem = name;
    saveSettings();
    debugLog(`Configuration adopted by system: ${name}`);
    return true;
}

/**
 * Makes a system the one in use, carrying its world in with it.
 *
 * The outgoing system is captured first, always. Switching away must never be the thing
 * that loses a world, which is why nothing here depends on having saved by hand.
 *
 * @returns {boolean} False when there is no such system, or it is already active.
 */
export function setActiveSystem(name) {
    const settings = getSettings();
    const target = settings.statusTracker.presets?.[name];
    if (!target || settings.activeSystem === name) return false;

    captureActiveSystem();
    applySystemPreset(target);
    // A saved system with no recorded world has an empty one - the starter systems ship
    // that way. Moving into it must not inherit the last system's cast, which is the
    // whole point: a Pathfinder chat should not open holding twenty-five D&D characters.
    // The outgoing world was captured a moment ago, so switching back returns all of it.
    if (!target.world) {
        restoreWorld(settings, { characters: [], personaData: {}, master_items: {} });
    }
    settings.activeSystem = name;
    saveSettings();
    debugLog(`Active system: ${name}`);
    return true;
}

/**
 * Starts a new system from the shipped defaults, with nobody in it.
 *
 * The old flow was "save current as", which asks you to remember to do it and leaves no
 * way to begin from a clean sheet - a new ruleset always started as a copy of the last.
 *
 * @returns {boolean} False when the name is missing or already taken.
 */
export function createSystem(name) {
    const settings = getSettings();
    const st = settings.statusTracker;
    if (!name || st.presets?.[name]) return false;

    captureActiveSystem();

    // Reset by the same rule the capture uses, so a new system starts from the defaults in
    // everything it owns. Resetting a named handful meant time rules, prompts and review
    // thresholds quietly carried over from whichever system you happened to be in.
    const defaults = structuredClone(defaultSettings);
    assignExcept(st, defaults.statusTracker, SYSTEM_EXCLUDED_TRACKER);
    assignExcept(settings, defaults, SYSTEM_EXCLUDED_ROOT);

    settings.characters.splice(0, settings.characters.length);
    settings.personaData = {};
    settings.master_items = {};

    saveSystemPreset(name);
    settings.activeSystem = name;
    saveSettings();
    return true;
}

/**
 * Saves the current status tracker configuration as a preset.
 */
export function saveSystemPreset(name, description = '', author = 'User') {
    if (!name) return;
    const settings = getSettings();
    const st = settings.statusTracker;
    
    const profile = {
        version: '2.1.0',
        metadata: {
            name,
            description,
            author
        },
        config: {
            ...copyExcept(settings, SYSTEM_EXCLUDED_ROOT),
            statusTracker: copyExcept(st, SYSTEM_EXCLUDED_TRACKER),
        },
        world: captureWorld(settings),
    };

    if (!st.presets) st.presets = {};
    st.presets[name] = profile;
    saveSettings();
}

/**
 * Applies a system preset to the current configuration.
 */
export function applySystemPreset(profile) {
    if (!profile || !profile.config) return;
    const st = getSettings().statusTracker;
    const cfg = profile.config;
    
    const settings = getSettings();

    // Two shapes. A profile saved since systems carried everything keeps its tracker
    // settings under `statusTracker`; one saved before that, or exported to share a
    // ruleset, holds a flat handful of tracker keys directly. Both load, and neither
    // touches a setting it does not define.
    if (cfg.statusTracker) {
        assignExcept(st, cfg.statusTracker, SYSTEM_EXCLUDED_TRACKER);
        assignExcept(settings, cfg, new Set([...SYSTEM_EXCLUDED_ROOT, 'displayStyle']));
    } else {
        assignExcept(st, cfg, new Set([...SYSTEM_EXCLUDED_TRACKER, 'displayStyle']));
    }

    // A stat list from an older profile may predate either field.
    for (const stat of st.playerStats || []) {
        if (stat.format === undefined) stat.format = '{{value}}';
        if (stat.maxStatValue === undefined) stat.maxStatValue = '100';
    }

    // The theme was called displayStyle and lived in config; it is menuStyle at the root
    // now, and carried like anything else. Old profiles still name the old one.
    if (cfg.displayStyle !== undefined) {
        const legacyThemeMap = {
            'modern': 'modern-dark',
            'minimal': 'default',
            'compact': 'default'
        };
        settings.menuStyle = legacyThemeMap[cfg.displayStyle] || cfg.displayStyle;
    }

    // Absent on any profile saved before systems carried a world, and on a profile
    // somebody exported to share a ruleset. Both must leave the current cast alone rather
    // than emptying it.
    restoreWorld(getSettings(), profile.world);

    saveSettings();
}

/**
 * Saved states of a system.
 *
 * A system's stored copy is only rewritten when you switch away from it, so a system you
 * never leave keeps whatever it held the last time you did - which is how two deleted
 * characters and a 165KB image stayed frozen inside one for weeks. Checkpoints give it a
 * history instead of a single overwritten copy.
 *
 * The state itself is written to user/files/ and only an index entry - about a hundred
 * bytes - is kept in settings.json. The first version stored the whole thing inline, which
 * would have re-serialised and re-uploaded every saved world on every settings change:
 * five states of a 200KB world is a megabyte rewritten each time a slider moves. The
 * payload never changes after it is written, so it has no business in a file that does.
 *
 * @param {object} preset
 * @returns {Array<{ id: string, savedAt: number, label: string, path: string, characters: number }>}
 */
export function getCheckpoints(preset) {
    return Array.isArray(preset?.checkpoints) ? preset.checkpoints : [];
}

/** Base64 for a UTF-8 string. btoa alone throws on anything outside Latin-1, and character
 *  names here are routinely Hungarian. Chunked because spreading a large array into
 *  fromCharCode overflows the call stack. */
function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** Counts saves within a session, so two in the same millisecond cannot collide. */
let checkpointSequence = 0;

/**
 * A filename the upload route accepts: alphanumerics, dash and underscore only.
 *
 * The timestamp alone was not unique. Date.now() repeats inside a millisecond, and a
 * restore saves "Before restore" immediately after whatever prompted it - so the two
 * could share a name, the second would overwrite the first, and dropping the older index
 * entry would then delete the file the newer one still pointed at.
 */
function checkpointFileName(system, savedAt) {
    const slug = String(system).replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40) || 'system';
    const unique = `${savedAt}-${(checkpointSequence++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return `sillynpc-state-${slug}-${unique}.json`;
}

/**
 * Records the live state as a new checkpoint of the active system.
 *
 * Captures configuration as well as the world: "so we cannot screw up permanently a
 * setting" is the point, and a world-only checkpoint would restore your characters while
 * leaving a ruined ruleset in place.
 *
 * @param {string} [label]
 * @returns {Promise<{ saved: boolean, kept: number, reason?: string }>}
 */
export async function saveCheckpoint(label = 'Manual save') {
    const settings = getSettings();
    const active = settings.activeSystem;
    const preset = settings.statusTracker.presets?.[active];
    if (!active || !preset) return { saved: false, kept: 0, reason: 'no active system' };

    const payload = {
        config: {
            ...copyExcept(settings, SYSTEM_EXCLUDED_ROOT),
            statusTracker: copyExcept(settings.statusTracker, SYSTEM_EXCLUDED_TRACKER),
        },
        world: captureWorld(settings),
    };
    const serialised = JSON.stringify(payload);

    const history = getCheckpoints(preset);
    // A checkpoint identical to the newest is noise: an interval save on an untouched
    // system would otherwise push real history out a few minutes at a time. Compared by
    // the bytes we are about to write, so it needs no second copy in memory.
    if (history[0]?.size === serialised.length && history[0]?.digest === digestOf(serialised)) {
        return { saved: false, kept: history.length, reason: 'unchanged' };
    }

    const savedAt = Date.now();
    const name = checkpointFileName(active, savedAt);
    let path;
    try {
        const response = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name, data: toBase64(serialised) }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        path = (await response.json()).path;
    } catch (err) {
        console.warn(LOG_PREFIX, 'Could not write the saved state:', err);
        // No index entry without a file behind it: an entry pointing at nothing offers a
        // restore that cannot work, which is worse than not offering one.
        return { saved: false, kept: history.length, reason: 'write failed' };
    }

    history.unshift({
        id: name,
        savedAt,
        label: String(label || 'Manual save'),
        path,
        characters: (payload.world.characters || []).length,
        size: serialised.length,
        digest: digestOf(serialised),
    });

    const limit = Math.max(1, Number(settings.statusTracker.systemCheckpointsKept) || 5);
    // Files for anything falling off the end go too, or user/files/ grows without bound.
    // Awaited so the caller knows the cleanup finished: left floating, a save that returns
    // before its deletes land reports a state the disk does not yet agree with.
    const dropped = history.slice(limit);
    history.length = Math.min(history.length, limit);
    // Never delete a file another entry still points at. Names are unique now, so this
    // should not arise - but the cost of being wrong is a saved state that restores
    // nothing, and the check is one comparison.
    const stillReferenced = new Set(history.map(entry => entry.path));
    await Promise.all(
        dropped
            .filter(entry => !stillReferenced.has(entry.path))
            .map(entry => deleteCheckpointFile(entry.path)),
    );
    preset.checkpoints = history;

    saveSettings();
    debugLog(`Checkpoint saved for "${active}" (${history.length} kept)`);
    return { saved: true, kept: history.length };
}

/**
 * A cheap fingerprint of a saved state, for spotting one that has not changed.
 *
 * Not a cryptographic hash and does not need to be: a collision costs one skipped save of
 * an identical-looking state, and the length is checked alongside it.
 */
function digestOf(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return hash;
}

/** Removes a checkpoint's file, ignoring one that has already gone. */
async function deleteCheckpointFile(path) {
    if (!path) return;
    try {
        await fetch('/api/files/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path }),
        });
    } catch (err) {
        debugLog('Could not delete a saved state file', path, err);
    }
}

/**
 * Puts a checkpoint back.
 *
 * Takes a checkpoint of the current state first, so restoring is itself undoable - the one
 * thing a restore must never be is a one-way door.
 *
 * @param {number} index Into the checkpoint list, newest first.
 * @returns {Promise<boolean>}
 */
export async function restoreCheckpoint(index) {
    const settings = getSettings();
    const active = settings.activeSystem;
    const preset = settings.statusTracker.presets?.[active];
    if (!active || !preset) return false;

    const target = getCheckpoints(preset)[Number(index)];
    if (!target) return false;

    let payload;
    try {
        const response = await fetch(target.path.startsWith('/') ? target.path : `/${target.path}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        payload = await response.json();
    } catch (err) {
        console.warn(LOG_PREFIX, 'Could not read the saved state:', err);
        return false;
    }

    // Only after the payload is in hand: a failed read must not cost you a checkpoint slot
    // for a restore that then does not happen.
    await saveCheckpoint('Before restore');

    applySystemPreset({ config: payload.config, world: payload.world });
    saveSettings();
    debugLog(`Restored the state saved at ${new Date(target.savedAt).toLocaleString()}`);
    return true;
}

/**
 * Removes one checkpoint and its file.
 *
 * @param {number} index
 * @returns {Promise<boolean>}
 */
export async function deleteCheckpoint(index) {
    const settings = getSettings();
    const preset = settings.statusTracker.presets?.[settings.activeSystem];
    if (!preset) return false;
    const history = getCheckpoints(preset);
    const target = history[Number(index)];
    if (!target) return false;
    history.splice(Number(index), 1);
    preset.checkpoints = history;
    saveSettings();
    await deleteCheckpointFile(target.path);
    return true;
}

let checkpointTimer = null;

/**
 * Starts or stops the interval save, matching the current settings.
 *
 * Idempotent: it clears any existing timer first, so it can be called freely without
 * stacking them up.
 */
export function applyCheckpointSchedule() {
    if (checkpointTimer) {
        clearInterval(checkpointTimer);
        checkpointTimer = null;
    }

    const minutes = Number(getSettings().statusTracker.systemAutoSaveMinutes) || 0;
    if (minutes <= 0) return;

    checkpointTimer = setInterval(() => {
        // Silent by design: an interval save that toasts every few minutes is a nuisance,
        // and one that saved nothing because nothing changed has nothing to announce.
        saveCheckpoint('Automatic');
    }, minutes * 60 * 1000);

    debugLog(`Automatic system checkpoints every ${minutes} minute(s)`);
}

/**
 * Deletes a system preset.
 */
export function deleteSystemPreset(name) {
    if (!name) return;
    const settings = getSettings();
    if (settings.statusTracker.presets?.[name]) {
        delete settings.statusTracker.presets[name];
        saveSettings();
    }
}

/**
 * Imports a system preset from a JSON string.
 */
export function importSystemPreset(jsonText) {
    const profile = JSON.parse(jsonText);
    if (!profile.config || !profile.metadata || !profile.metadata.name) {
        throw new Error('Invalid System Profile format.');
    }
    const settings = getSettings();
    if (!settings.statusTracker.presets) settings.statusTracker.presets = {};
    settings.statusTracker.presets[profile.metadata.name] = profile;
    saveSettings();
    return profile;
}


