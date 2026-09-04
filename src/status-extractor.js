import { getContext } from '../../../../st-context.js';
import { getSettings, saveSettings } from './settings.js';
import {
    THREAD_KINDS, openThreads, coerceThread, addThread, closeThread,
    activeThreads, touchThreads, pruneThreads,
} from './threads.js';
import { LOG_PREFIX, debugLog, SYSTEM_PROMPT, PROFILE_FIELDS, aiMayEditProfileField, anyProfileFieldUnlocked } from './constants.js';
export { SYSTEM_PROMPT };
import { extractJSON, safeJsonParse, splitValue, describeConnection, currentMessageIndex } from './utils.js';
import { charactersMentionedIn } from './chat.js';
import { mentionsName } from './mentions.js';
import { charactersFromActivatedLore } from './activated-lore.js';
import { recordUsage } from './usage.js';
import {
    loadStateFromMetadata,
    saveStateToMetadata,
    rememberSwipeBase,
    applyUpdate,
    reconcileScenePresence,
    resolveMaxValue,
    getPlayerCard,
    findCardForName,
} from './status-logic.js';
import { computeStateDiff, partitionChanges, buildUpdateFromChanges, attachReasons } from './status-diff.js';
import { setPendingChanges, isItemDecided } from './status-review.js';
import { recordAppliedChanges, recordThreadChanges } from './status-snapshots.js';
import { applyTimeRules } from './status-rules.js';

/**
 * Second-pass state extraction.
 *
 * Asking the narrative model to also emit a <status_update> block makes it do two jobs
 * in one response, and character cards frequently forbid exactly that — a card that says
 * "never write numbers or status updates in the outcome" is in direct conflict with the
 * tracker's instructions, and the conflict peaks on the turns where stats actually change.
 *
 * Instead, once a message has been written, this sends the message and the current state
 * to a separate request whose only job is to return JSON. The narrative prompt then
 * carries no tracker instructions at all, so the two stop fighting.
 *
 * The schema is generated from the user's own configured stats, which is also what stops
 * the model inventing keys like `energy_max` in the first place.
 */

/** Guards against an extraction triggering the events that would start another. */
let extractionInFlight = false;

/** Message ids already extracted, so a re-render does not re-run the request. */
const extractedMessages = new Set();

export function resetExtractionState() {
    extractionInFlight = false;
    extractedMessages.clear();
}

/**
 * Forgets that messages from this index onward were ever read.
 *
 * The guard is keyed `messageId:swipeId`, and message ids are positions rather than
 * identities - delete the newest message and the next one written takes its number back.
 * Regenerate does exactly that, and the replacement arrives at the same index on swipe 0,
 * so the key was already in the set and the new reply was refused with 'already extracted'
 * - the tracker kept the discarded reply's numbers and never looked at the one on screen.
 *
 * Always safe: an index past the end of the chat has nothing to re-read, so the only thing
 * a stale entry there can do is refuse whatever occupies that position next.
 *
 * @param {string|number} index
 * @returns {number} How many were forgotten.
 */
export function forgetExtractionsFrom(index) {
    const from = Number(index);
    if (!Number.isFinite(from)) return 0;

    let forgotten = 0;
    for (const key of [...extractedMessages]) {
        if (Number(String(key).split(':')[0]) >= from && extractedMessages.delete(key)) {
            forgotten += 1;
        }
    }
    if (forgotten) debugLog(`Forgot ${forgotten} extraction(s) from message ${from} on`);
    return forgotten;
}

/**
 * Everyone who has a profile that could be unlocked: the cards, and the player.
 *
 * The player's four fields live on their persona record rather than in the character list,
 * so asking the list alone would miss a player who has opened one. Guarded because
 * getPlayerCard needs a persona, and the schema is built in places where there may not be
 * one yet.
 */
function profileOwners() {
    const cards = getSettings().characters || [];
    try {
        return [...cards, getPlayerCard()];
    } catch {
        return cards;
    }
}

/**
 * A JSON schema describing exactly the stats and collections this user has configured.
 *
 * Deliberately restricted to the keywords Google's structured-output subset accepts:
 * type, properties, items, required. An earlier version used additionalProperties,
 * which Gemini does not support - the schema was rejected and every reply came back as
 * an empty object. The system prompt carries the "no other keys" rule instead.
 *
 * @param {object} trackerSettings
 */
export function buildExtractionSchema(trackerSettings) {
    // Takes the stat definitions rather than their names, so a field that says how it
    // should be written can pass that on. A free-text field used to arrive as nothing but
    // a name and `{ type: 'string' }`, which is how one grew into a running log.
    const stringMap = (stats) => ({
        type: 'object',
        properties: Object.fromEntries((stats || [])
            .filter(stat => stat?.name)
            .map(stat => [
                stat.name,
                stat.hint?.trim()
                    ? { type: 'string', description: stat.hint.trim() }
                    : { type: 'string' },
            ])),
    });

    // A collection is a delta, not a listing. Asking for the full contents meant any
    // item the model failed to restate read as a deletion, which is how characters
    // kept being proposed for losing things the story never took from them.
    const collectionProps = (target) => {
        const relevant = (trackerSettings.collections || [])
            .filter(c => c.target === 'all' || c.target === target);
        if (!relevant.length) return null;
        return {
            type: 'object',
            properties: Object.fromEntries(relevant.map(col => [col.id, {
                type: 'object',
                properties: {
                    add: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: Object.fromEntries((col.fields || []).map(f => [
                                f.name,
                                { type: f.type === 'number' ? 'number' : (f.type === 'boolean' ? 'boolean' : 'string') },
                            ])),
                        },
                    },
                    remove: { type: 'array', items: { type: 'string' } },
                },
            }])),
        };
    };

    const globalStatDefs = trackerSettings.globalStats || [];
    const playerStatDefs = trackerSettings.playerStats || [];
    const npcStatDefs = trackerSettings.npcStats || [];

    const playerCollections = collectionProps('player');
    const npcCollections = collectionProps('npc');

    /* The four profile fields, but only if somebody has actually unlocked one.
     *
     * A schema names what may come back, so listing these tells the model to look for
     * changes to them on every message - work and tokens nobody should pay for a feature
     * they have not switched on. The lock is per character and per field, so "any of them,
     * anywhere" is the only question the schema can ask; the apply side does the precise
     * filtering and drops anything for a field that is still locked. */
    const profileProps = anyProfileFieldUnlocked(profileOwners()) ? {
        type: 'object',
        properties: Object.fromEntries(PROFILE_FIELDS.map(field => [
            field.id, { type: 'string', description: field.hint },
        ])),
    } : null;

    return {
        type: 'object',
        // Required at the top level so a model cannot satisfy the schema with "{}",
        // which is exactly what happened while the schema was being rejected.
        required: ['global', 'player', 'characters'],
        properties: {
            global: stringMap(globalStatDefs),
            player: {
                type: 'object',
                properties: {
                    stats: stringMap(playerStatDefs),
                    ...(playerCollections ? { collections: playerCollections } : {}),
                    ...(profileProps ? { profile: profileProps } : {}),
                },
            },
            characters: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['name'],
                    properties: {
                        name: { type: 'string' },
                        stats: stringMap(npcStatDefs),
                        ...(npcCollections ? { collections: npcCollections } : {}),
                        ...(profileProps ? { profile: profileProps } : {}),
                    },
                },
            },
            // Only when threads are on. A schema names what may come back, so a key it
            // does not mention is a key the model is told not to send - the ask would
            // still be in the prompt and the answer would never arrive, which is the
            // worst shape of failure: a feature that is switched on and silent.
            ...(trackerSettings.threadsEnabled === true ? {
                threads: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['text', 'quote'],
                        properties: {
                            kind: { type: 'string' },
                            text: { type: 'string' },
                            quote: { type: 'string' },
                            who: { type: 'string' },
                        },
                    },
                },
                closed: { type: 'array', items: { type: 'string' } },
            } : {}),
        },
    };
}

/**
 * Renders the current state in the envelope the reply must use.
 *
 * Two lessons are baked in here. A prose summary invited the model to reply in that
 * shape ({"World":..., "Miller":...}), so the state is shown as JSON in the target
 * shape instead. And listing every field of every collection item made the exchange
 * long enough that replies were truncated before the "characters" array, so
 * collections are summarised as item names with quantities.
 */
/**
 * The collections and their fields, so a reply can use the right ones.
 *
 * Lived in the history scan, whose own comment explains why it exists: given only a prose
 * description, a 3B model invented its own keys and returned nothing usable. The
 * per-message extractor never had it, which is why the collections it produced were the
 * weakest part of its reply and why a newly created item arrived holding nothing but a
 * name - `name` was the only field it had ever been shown.
 *
 * @param {object} trackerSettings
 * @returns {string}
 */
export function describeCollections(trackerSettings) {
    const lines = [];
    for (const col of trackerSettings.collections || []) {
        const fields = (col.fields || []).map((f) => {
            const type = f.type && f.type !== 'text' ? ` (${f.type})` : '';
            const choices = (f.options || []).length ? ` [one of ${f.options.join(', ')}]` : '';
            return `${f.name}${type}${choices}${f.isPrimary ? ' [identifies the item]' : ''}`;
        }).join(', ');

        /* The label and the note, not just the id. An id is a key - "pictures" tells the
           model as little as a column name does, and the prompt used to send nothing else,
           which is why guidance about inventories had to stand in for saying what a
           collection actually holds. The label is already on every collection and was
           simply never sent; the note is optional and blank until somebody writes one. */
        const label = String(col.name ?? '').trim();
        const title = label && label.toLowerCase() !== String(col.id).toLowerCase()
            ? `"${col.id}" (${label})` : `"${col.id}"`;
        const note = String(col.hint ?? '').trim();

        lines.push(`- ${title} for ${col.target || 'all'}`
            + `${note ? ` - ${note.replace(/\s*$/, '').replace(/\.?$/, '.')}` : ''}`
            + ` Fields: ${fields || 'name'}`);
    }
    return lines.join('\n');
}

/**
 * A worked example of a collection change, in the ids and fields actually configured.
 *
 * The prompt's only example was `{"add": [{"name": "Rope"}]}`, which taught the model that
 * an item has one field. The scan learned this lesson already - a filled-in example in the
 * user's own schema is the difference between a reply that fits and one that does not -
 * but it builds a *full list*, and the per-message extractor needs a delta.
 *
 * Placeholders sit in angle brackets so a small model cannot mistake one for content;
 * a value it must not guess is marked as such rather than shown as a plausible number.
 *
 * @param {object} trackerSettings
 * @returns {string}
 */
export function buildDeltaExample(trackerSettings) {
    const cols = trackerSettings.collections || [];
    if (!cols.length) return '';

    const col = cols[0];
    const primary = (col.fields || []).find(f => f.isPrimary)?.name || 'name';

    const item = {};
    for (const field of col.fields || [{ name: 'name' }]) {
        if (field.name === primary) {
            item[field.name] = '<exact name>';
        } else if (field.type === 'number') {
            item[field.name] = '<number, or omit if the message does not say>';
        } else if (field.type === 'boolean') {
            item[field.name] = '<true or false, or omit if the message does not say>';
        } else {
            item[field.name] = '<or omit if the message does not say>';
        }
    }

    const shape = { [col.id]: { add: [item], remove: ['<exact name of something lost>'] } };
    return JSON.stringify(shape, null, 2);
}

function describeCurrentState(state, trackerSettings) {
    const relevant = (target) => (trackerSettings.collections || [])
        .filter(c => c.target === 'all' || c.target === target);

    const summarise = (actor, target) => {
        const cols = relevant(target);
        if (!cols.length) return undefined;
        const out = {};
        for (const col of cols) {
            const primary = (col.fields || []).find(f => f.isPrimary)?.name || 'name';
            const qtyField = (col.fields || []).find(f => f.type === 'number'
                && ['quantity', 'qty', 'count'].includes(f.name));
            // Shown as objects rather than names. Collections used to render as bare
            // strings - "spells": ["Fireball"] - so the model never saw that an item
            // has a weight or a description, and had no shape to copy when adding one.
            // Empty fields are dropped: they say nothing, and a long inventory of
            // mostly-blank objects would crowd out the message being read.
            out[col.id] = (actor?.collections?.[col.id] || []).map(item => {
                const name = item?.[primary] ?? item?.name ?? '';
                if (!name) return null;
                const shown = { [primary]: String(name) };
                for (const field of col.fields || []) {
                    if (field.name === primary) continue;
                    const value = item?.[field.name];
                    if (value === undefined || value === null || value === '') continue;
                    if (field.type === 'number' && Number(value) === 0) continue;
                    shown[field.name] = value;
                }
                return shown;
            }).filter(Boolean);
        }
        return out;
    };

    const playerCollections = summarise(state.player, 'player');
    const shape = {
        global: { ...(state.global || {}) },
        player: {
            stats: { ...(state.player?.stats || {}) },
            ...(playerCollections ? { collections: playerCollections } : {}),
        },
        characters: (state.characters || []).map(char => {
            const charCollections = summarise(char, 'npc');
            return {
                name: char.name,
                stats: { ...(char.stats || {}) },
                ...(charCollections ? { collections: charCollections } : {}),
            };
        }),
    };
    return JSON.stringify(shape, null, 2);
}

/**
 * Ceilings the model must respect.
 *
 * These used to come only from the configured maxStatValue, which contradicts the
 * state whenever a stat has grown in play: a character whose Energy reached 120/120
 * was shown "Energy: 120/120" alongside "Energy: 0..80", and the model resolved the
 * contradiction by trusting the limit - silently dragging the character back to 78/80
 * and destroying the progression.
 *
 * The live value wins. Once play has raised a ceiling, that is the real ceiling; the
 * configured maximum is only a starting point for stats that have never moved.
 *
 * @param {object} trackerSettings
 * @param {object} state Current tracker state, used for live ceilings.
 */
export function describeLimits(trackerSettings, state) {
    /** The denominator of a "cur/max" value, if it has one and it is a number. */
    const liveMax = (value) => {
        const { max } = splitValue(value);
        return max && Number.isFinite(parseFloat(max)) ? max : '';
    };

    /** The highest ceiling any present character currently shows for a stat. */
    const liveNpcMax = (name) => {
        let best = '';
        for (const char of state?.characters || []) {
            const found = liveMax(char?.stats?.[name]);
            if (found && (!best || parseFloat(found) > parseFloat(best))) best = found;
        }
        return best;
    };

    const describe = (list, label, lookup) => {
        const entries = (list || [])
            .map(stat => ({
                name: stat.name,
                // Live first, configured only as a fallback.
                max: lookup(stat.name) || resolveMaxValue(stat),
                min: stat.min,
            }))
            .filter(e => e.max || (e.min !== undefined && e.min !== ''))
            .map(e => `${e.name}: ${e.min !== undefined && e.min !== '' ? e.min : 0}..${e.max || '?'}`);
        return entries.length ? `${label}: ${entries.join(', ')}` : '';
    };

    /**
     * The stats that may only hold certain values.
     *
     * A refused value costs a whole message of tracking for that field, so naming the
     * vocabulary is worth the tokens: the guard is what makes the list true, and this
     * is what stops it having to.
     */
    const describeChoices = (list, label) => {
        const entries = (list || [])
            .filter(stat => (stat?.options || []).length)
            .map(stat => `${stat.name}: one of ${stat.options.join(', ')}`);
        return entries.length ? `${label}: ${entries.join('; ')}` : '';
    };

    /**
     * How a free-text field should be written, in the user's own words.
     *
     * Sent here as well as in the schema because the schema is optional - Use Schema is a
     * setting, and several backends ignore or reject one - while this block is always
     * part of the prompt. A field with nothing to say adds nothing.
     */
    const describeShapes = (list, label) => {
        const entries = (list || [])
            .filter(stat => stat?.name && String(stat.hint ?? '').trim())
            .map(stat => {
                const limit = Number(stat.maxLength);
                const cap = Number.isFinite(limit) && limit > 0
                    ? ` (at most ${limit} characters)`
                    : '';
                return `${stat.name}: ${String(stat.hint).trim()}${cap}`;
            });
        return entries.length ? `${label}: ${entries.join('; ')}` : '';
    };

    return [
        describe(trackerSettings.playerStats, 'Player limits',
            (name) => liveMax(state?.player?.stats?.[name])),
        describe(trackerSettings.npcStats, 'Character limits', liveNpcMax),
        describeChoices(trackerSettings.globalStats, 'World values'),
        describeChoices(trackerSettings.playerStats, 'Player values'),
        describeChoices(trackerSettings.npcStats, 'Character values'),
        describeShapes(trackerSettings.globalStats, 'How to write world values'),
        describeShapes(trackerSettings.playerStats, 'How to write player values'),
        describeShapes(trackerSettings.npcStats, 'How to write character values'),
    ].filter(Boolean).join('\n');
}


/**
 * Builds the extraction prompt.
 *
 * The lead-up matters. Tabletop play routinely announces a cost in one message, takes
 * the roll in the next and resolves in a third - and a character card that forbids
 * numbers in its prose means the resolving message says only that the spell landed.
 * Neither message alone is enough: the first names a cost nobody has paid yet, the last
 * shows the spend with no figure attached.
 *
 * Earlier messages are therefore supplied as context, explicitly marked as already
 * accounted for, so a cost can be attributed to the message that actually spent it
 * without being applied twice.
 *
 * @param {object} state
 * @param {string} messageText The message being extracted.
 * @param {object} trackerSettings
 * @param {string[]} [leadUp] Preceding messages, oldest first.
 */
/**
 * Cards for characters the message names who are not in the scene.
 *
 * A character written in by the narrator - because their lorebook entry fired, or simply
 * because the story mentions them - is restored from their card when presence is
 * reconciled. But that happens after this request was built, so the reader saw a state
 * without them and reported them as new with nothing to their name.
 *
 * Kept out of the "characters" array on purpose. That array is the scene cast, and the
 * prompt tells the reader to return it complete; putting an absent character in it would
 * be read as "they are here". This is a separate note saying what they already have.
 *
 * @param {object} state
 * @param {string} messageText
 * @returns {string}
 */
function describeAbsentButNamed(state, messageText, trackerSettings) {
    const present = new Set((state.characters || []).map(c => String(c.name).toLowerCase()));
    const candidates = [...charactersMentionedIn(messageText), ...charactersFromActivatedLore()];

    const seen = new Set();
    const lines = [];
    for (const char of candidates) {
        const key = String(char.name || '').toLowerCase();
        if (!key || present.has(key) || seen.has(key)) continue;
        seen.add(key);

        const stats = char.statusOverrides || {};
        // Stats only. Their belongings used to be listed here too, and models restated the
        // list back as additions - which the apply side read as acquiring them a second
        // time, doubling a quantity on every message. An echoed stat overwrites itself; an
        // echoed collection accumulates. The belongings are restored from the card the
        // moment the reply puts them in the scene, so listing them bought nothing and cost
        // that.
        if (!Object.keys(stats).length) continue;

        lines.push(JSON.stringify({ name: char.name, stats }));
    }

    return lines.join(String.fromCharCode(10));
}

// Exported for the tests: what reaches the model on every message is worth holding to
// a shape, and the vocabulary in it is the whole point of this function.
export function buildUserPrompt(state, messageText, trackerSettings, leadUp = []) {
    // What is already open, so the reader is not asked to find it again every message.
    //
    // The active ones only. This listed every open thread, which made the block grow with
    // the pile: a chat carrying eighty of them paid eighty lines here on every single
    // message, to stop the model re-proposing threads that mostly were not being sent to
    // it anyway. The ones worth naming are the ones in play, and addThread still refuses
    // an exact repeat of any of the rest.
    const openText = activeThreads(state, currentMessageIndex())
        .map(t => `  - "${t.quote}"`).join('\n');
    const limits = describeLimits(trackerSettings, state);
    const schema = describeCollections(trackerSettings);
    const example = buildDeltaExample(trackerSettings);
    const absent = describeAbsentButNamed(state, messageText, trackerSettings);
    const context = leadUp.length
        ? '\n### EARLIER MESSAGES (context only - already reflected in the state above)\n'
            + leadUp.join('\n---\n')
        : '';
    return [
        /* What the words in this prompt mean here, before any of them are used.
         *
         * The system prompt above may be the shipped one or one somebody wrote themselves,
         * and either way it has to talk about stats and collections in the abstract. It
         * cannot know that this setup's collections are "pictures" and "contacts" rather
         * than an inventory. This can, so it says so - and says the lists are closed, which
         * is what stops a model reporting a plausible stat nobody configured. */
        '### WHAT YOU MAY CHANGE',
        'The stats are exactly the ones named in the current state below. The collections '
            + 'are exactly the ones listed under their own heading. There are no others: a '
            + 'name that does not appear below does not exist here, whatever it is called '
            + 'in other games.',
        '\n### CURRENT STATE',
        describeCurrentState(state, trackerSettings) || '(empty)',
        limits ? '\n### LIMITS\n' + limits : '',
        // The fields each collection actually has. Without this the model had only the
        // prompt's one example to go by, which showed a single field called name - so
        // that is all a new item ever arrived with.
        // Before the field list, so it reads as part of what is already known rather
        // than as an instruction about shape.
        absent ? '\n### KNOWN BUT NOT IN THE SCENE\n'
            + 'These characters are named in the message but are not in the scene. They '
            + 'are already tracked, and what they own is already on file - never list or '
            + 're-add their belongings. Do not repeat their stats back either; if the '
            + 'message puts one of them into the scene, include them in \"characters\" and '
            + 'report only what this message changed.\n' + absent : '',
        schema ? '\n### COLLECTIONS AND THEIR FIELDS\n' + schema : '',
        example ? '\n### A COLLECTION CHANGE LOOKS LIKE THIS\n' + example
            + '\nOmit any field the message does not state. Do not guess a value.' : '',
        describeOpenProfileFields(state),
        buildMinimalExample(state, trackerSettings),
        context,
        '\n### LATEST MESSAGE (apply what this one changes)',
        messageText,
        '\n### TASK',
        'Return the updated state as JSON.',
        // Here rather than in the system prompt on purpose. A user's own extraction
        // prompt replaces the shipped one outright, so anything added there would never
        // reach anybody who has written their own - the trap that lost [CONTEXT] from the
        // image template. This section is assembled by the extension either way. It also
        // keeps the ask off the history scan, which builds its own prompt and has no use
        // for a clause per change across hundreds of messages.
        trackerSettings.extractionReasons === false ? '' : [
            'Also return a "why" object explaining every value you changed: one short',
            'clause each, naming what in the latest message caused it.',
            'Key it by the stat - "Time" for a world stat, "Player.Health" for the player,',
            '"Elza.Health" for a character.',
            // The line that may cure rather than explain: a change that has to name its
            // cause is harder to invent than one that only has to be plausible.
            'If you cannot point at something in the latest message, do not change the',
            'value at all and do not list it.',
        ].join('\n'),
        // Threads. Also here rather than the system prompt, and for the same reason as the
        // reasons above: a user's own extraction prompt replaces the shipped one outright.
        //
        // The ask names speech acts rather than asking what was important. "Will this
        // matter later" is the question nobody can answer at the time - it is why
        // summaries lose the line that turns out to count - but "did somebody promise,
        // threaten, owe, confide, set a deadline or make a plan" is answerable from the
        // message alone.
        trackerSettings.threadsEnabled !== true ? '' : [
            '',
            'Also return a "threads" array for anything in the latest message that opened',
            'one of these and is not finished with:',
            ...THREAD_KINDS.map(k => `  ${k.id} - ${k.hint}`),
            'Each: { "kind": "...", "text": "what is outstanding, one line",',
            '"quote": "the words from the message that opened it", "who": "who it is about" }.',
            // The rule that keeps this from becoming invented plot. A quote can be checked
            // against the message; a description cannot.
            'The quote must be words that appear in the latest message. If you cannot quote',
            'it, do not list it.',
            'Most messages open nothing. An empty array is the usual answer.',
            openText ? `Already open, do not list again:\n${openText}` : '',
            'Return "closed" as an array of the quoted lines above that this message',
            'resolved, if any.',
        ].filter(Boolean).join('\n'),
    ].filter(Boolean).join('\n');
}

/**
 * The few messages before this one, trimmed so a long reply cannot dominate the prompt.
 * @param {string|number} messageId
 * @param {number} count How many preceding messages to include.
 * @returns {string[]} Oldest first, each labelled by speaker.
 */
function collectLeadUp(messageId, count) {
    if (!count || count <= 0) return [];
    const chat = getContext()?.chat || [];
    const index = Number(messageId);
    if (!Number.isInteger(index) || index <= 0) return [];

    const out = [];
    for (let i = Math.max(0, index - count); i < index; i++) {
        const message = chat[i];
        if (!message || typeof message.mes !== 'string' || !message.mes.trim()) continue;
        const who = message.is_user ? 'Player' : 'Narrator';
        // Enough for a cost line or a roll result without pulling a whole scene back in.
        const text = message.mes.length > 1200 ? message.mes.slice(-1200) : message.mes;
        out.push(`[${who}] ${text}`);
    }
    return out;
}

/**
 * Runs the request, preferring a dedicated Connection Profile.
 *
 * @returns {Promise<string|object>} Model output. A backend given a json_schema may
 * return already-parsed data rather than text, so callers must handle both.
 */

/** What a reply cost, whether it arrived as text or as already-parsed data. */
function describeAnswer(answer) {
    if (typeof answer === 'string') return answer;
    try { return JSON.stringify(answer ?? ''); } catch { return ''; }
}
export async function requestExtraction(userPrompt, schema, trackerSettings, systemPrompt = null, { usageKind = 'extraction' } = {}) {
    // A caller may pass its own - the history scan does. Otherwise the user's, if they
    // have written one, and the built-in if not.
    systemPrompt = systemPrompt || trackerSettings.extractionPrompt?.trim() || SYSTEM_PROMPT;
    const context = getContext();
    const profileId = trackerSettings.extractionProfileId;
    const maxTokens = Number(trackerSettings.extractionMaxTokens) || 1200;

    debugLog(`Extraction -> ${describeConnection(profileId)}, reply budget ${maxTokens}`);

    if (profileId) {
        // Connection Manager can be disabled, and the profile may have been deleted;
        // either throws, so fall through to the main API rather than failing the sync.
        try {
            const service = context.ConnectionManagerRequestService;
            const result = await service.sendRequest(
                profileId,
                [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
                maxTokens,
                { extractData: true, includePreset: false },
                // Structured output is opt-in: some backends return an empty object
                // rather than reject a schema they dislike, which loses the update
                // silently. The system prompt pins the shape without it.
                (schema && trackerSettings.extractionUseSchema) ? { json_schema: schema } : {},
            );
            const answer = typeof result === 'string' ? result : (result?.content ?? result ?? '');
            recordUsage(usageKind, { prompt: systemPrompt + userPrompt, reply: describeAnswer(answer) });
            return answer;
        } catch (err) {
            console.warn(LOG_PREFIX, 'Extraction profile unavailable, falling back to the main API:', err);
        }
    }

    const raw = await context.generateRawData({
        prompt: userPrompt,
        systemPrompt,
        responseLength: maxTokens,
        jsonSchema: trackerSettings.extractionUseSchema ? schema : null,
    });
    const answer = typeof raw === 'string' ? raw : (raw?.content ?? raw ?? '');
    recordUsage(usageKind, { prompt: systemPrompt + userPrompt, reply: describeAnswer(answer) });
    return answer;
}

/**
 * Turns whatever the backend returned into an update object.
 *
 * A structured-output backend returns parsed data; everything else returns text that
 * may be wrapped in prose or a code fence, which extractJSON/safeJsonParse handle.
 *
 * @param {string|object} raw
 * @returns {object|null}
 */
export function coerceToUpdate(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return Array.isArray(raw) ? null : raw;
    return safeJsonParse(extractJSON(String(raw)));
}

/**
 * The unlocked profile fields, with what they currently say.
 *
 * The schema grew a `profile` key and nothing told the model it existed, which left a slot
 * with no instruction and no current value to compare against - it would have been writing
 * blind. Here rather than in the system prompt for the reason threads and the reasons
 * object are here: a user's own extraction prompt replaces the shipped one outright, and an
 * ask that lives only in the shipped text never reaches them.
 *
 * Only the unlocked ones. A locked field is dropped on apply whatever comes back, so
 * listing it would spend tokens inviting a change that is thrown away.
 *
 * @returns {string} Empty when nothing is unlocked, so the caller leaves the section out.
 */
function describeOpenProfileFields(state) {
    const lines = [];

    const describe = (card, label) => {
        const open = PROFILE_FIELDS.filter(f => aiMayEditProfileField(card, f.id));
        if (!open.length) return;
        for (const field of open) {
            const value = String(card.profile?.[field.id] ?? '').trim();
            lines.push(`- ${label}.${field.id}: ${value || '(blank)'}`);
        }
    };

    if (state?.player?.name) {
        try { describe(getPlayerCard(), state.player.name); } catch { /* no persona */ }
    }
    for (const actor of state?.characters || []) {
        const card = findCardForName(actor?.name);
        if (card) describe(card, actor.name);
    }

    if (!lines.length) return '';
    return '\n### PROFILE FIELDS YOU MAY UPDATE\n'
        + 'These describe who somebody IS, not what is happening to them, and they change '
        + 'rarely - a scar, a haircut, a lasting change of manner. Update one only when the '
        + 'latest message plainly shows it. Omitting a field means unchanged, which is '
        + 'almost always the right answer. Return them under "profile" on that character, '
        + 'beside "stats".\n'
        + lines.join('\n');
}

/**
 * A minimal reply, in the stats this setup actually has.
 *
 * Small models copy the shape of an example far more reliably than they follow a
 * description of it, and an example is only useful if it is about them: a hard-coded
 * '"Stamina": "12/20"' teaches a model about a stat that may not exist here, and invites it
 * to report one that does not.
 *
 * Placeholders where a value would be, so nothing here can be mistaken for a fact about the
 * scene - the same reasoning as buildDeltaExample, which does this for collections.
 */
function buildMinimalExample(state, trackerSettings) {
    const firstNamed = (list) => (list || []).map(s => s?.name).filter(Boolean)[0];

    const playerStat = firstNamed(trackerSettings.playerStats);
    const npcStat = firstNamed(trackerSettings.npcStats);
    const present = (state?.characters || []).map(c => c?.name).filter(Boolean);
    if (!playerStat && !npcStat && !present.length) return '';

    const characters = present.length
        ? present.slice(0, 2).map((name, i) => (i === 0 && npcStat
            ? `    { "name": ${JSON.stringify(name)}, "stats": { ${JSON.stringify(npcStat)}: "<new value>" } }`
            : `    { "name": ${JSON.stringify(name)} }`))
        : [];

    return '\n### A MINIMAL REPLY LOOKS LIKE THIS\n{\n'
        + '  "global": {},\n'
        + (playerStat
            ? `  "player": { "stats": { ${JSON.stringify(playerStat)}: "<new value>" } },\n`
            : '  "player": {},\n')
        + `  "characters": [\n${characters.join(',\n')}\n  ]\n}\n`
        + 'Everyone present is listed; only what changed carries a value.';
}

/**
 * Writes back any profile field the reader changed and is allowed to change.
 *
 * Deliberately outside applyUpdate. That writes the state - chat metadata, which the diff,
 * the review gate and the timeline all read - while a profile lives on the card, in
 * settings, shared by every chat. Routing one through the other would put global data on a
 * per-message path, which is how the player's stats once reached master storage.
 *
 * The lock is enforced here as well as in the schema. The schema only knows whether anybody
 * has unlocked anything; this knows which character and which field, and drops the rest even
 * when the model returns them anyway.
 *
 * Undoing is the swipe base's job: it snapshots every profile before the message runs, and
 * rebaseToSwipe puts them back. See snapshotProfiles.
 *
 * @returns {string[]} What changed, as "Name.Field", for the log.
 */
export function applyProfileFromReply(parsed) {
    if (!anyProfileFieldUnlocked(profileOwners())) return [];

    const changed = [];

    const write = (card, incoming) => {
        if (!card || !incoming || typeof incoming !== 'object') return;
        if (!card.profile || typeof card.profile !== 'object') card.profile = {};

        for (const field of PROFILE_FIELDS) {
            if (!aiMayEditProfileField(card, field.id)) continue;
            const value = String(incoming[field.id] ?? '').trim();
            // An omitted field means "unchanged", and a blank one is the model failing to
            // answer rather than deciding somebody has no personality.
            if (!value || value === String(card.profile[field.id] ?? '').trim()) continue;
            card.profile[field.id] = value;
            changed.push(`${card.name}.${field.label}`);
        }
    };

    if (parsed?.player?.profile) {
        try { write(getPlayerCard(), parsed.player.profile); } catch { /* no persona */ }
    }

    for (const incoming of Array.isArray(parsed?.characters) ? parsed.characters : []) {
        if (incoming?.profile) write(findCardForName(incoming.name), incoming.profile);
    }

    if (changed.length) {
        saveSettings();
        debugLog('Profile fields the story changed:', changed);
    }
    return changed;
}

/**
 * Opens and closes threads from what the reader returned.
 *
 * Saved in its own step rather than through applyUpdate, and returns what it did so a
 * caller reading a whole history can report totals.
 *
 * @param {object} parsed The reply.
 * @param {string|number|null} messageId Which message opened them.
 * @param {string} [messageText] The message itself, used only to decide whether the player
 *   was named in it. The history scan does not pass one, and does not need to.
 * @returns {{ opened: number, closed: number }}
 */
export function applyThreadsFromReply(parsed, messageId = null, messageText = '') {
    const trackerSettings = getSettings().statusTracker;
    if (trackerSettings.threadsEnabled !== true) return { opened: 0, closed: 0 };

    const proposed = Array.isArray(parsed?.threads) ? parsed.threads : [];
    const resolved = Array.isArray(parsed?.closed) ? parsed.closed : [];
    const state = loadStateFromMetadata();
    const present = (Array.isArray(parsed?.characters) ? parsed.characters : [])
        .map(c => c?.name)
        .filter(Boolean);

    /* The player, who is never in `characters` - they are reported under `player` - and so
       could never touch a thread about themselves. In a real chat most threads are about
       the player, and those were the ones ageing fastest.

       Only when the reply actually names them, rather than always. They are in every scene
       by definition, so counting them unconditionally would mean their threads never
       decayed at all and simply held the cap by weight. Naming is the honest signal: a
       reply that says "Kristof, you're the one holding the line" is engaging with them,
       and one that never mentions them is not. Second-person narration means this is
       often false, which is the point. */
    const playerName = String(state?.player?.name || '').trim();
    if (playerName && mentionsName(messageText, playerName)) present.push(playerName);

    // No early return on "nothing proposed" any more. Most messages open and close
    // nothing, and those are exactly the messages that say a thread is still live: whoever
    // it is about was in the scene. Leaving before touching them was what let a running
    // obligation age as though the story had dropped it.
    if (!proposed.length && !resolved.length && !present.length) return { opened: 0, closed: 0 };

    const now = currentMessageIndex();
    let opened = 0;
    let closed = 0;
    const touched = touchThreads(state, present, messageId ?? now);

    // Kept so the message can be told what it did: rebaseToSwipe rebuilds a swipe from
    // what was recorded against it, and a thread recorded nowhere is a thread that swipe
    // loses on the way back.
    const openedThreads = [];
    const closedIds = [];

    for (const raw of proposed) {
        const thread = coerceThread(raw, { messageId });
        // Refused rather than repaired. A thread with no quotable source is a thread
        // nobody opened, and the whole value of these is that the line can be checked.
        if (!thread) continue;
        if (addThread(state, thread)) {
            openedThreads.push(thread);
            opened += 1;
        }
    }

    for (const quote of resolved) {
        const key = String(quote ?? '').trim().toLowerCase();
        if (!key) continue;
        const match = openThreads(state)
            .find(t => String(t.quote).toLowerCase().includes(key)
                || key.includes(String(t.quote).toLowerCase()));
        if (match && closeThread(state, match.id)) {
            closedIds.push(match.id);
            closed += 1;
        }
    }

    // Only ever grew before. Every open thread also went into the next extraction prompt
    // as "already open, do not list again", so a chat that had collected eighty of them
    // was paying for eighty lines on every message while only the injected handful ever
    // reached the story.
    const pruned = pruneThreads(state, now);

    if (opened || closed || touched || pruned.open || pruned.closed) {
        saveStateToMetadata(state, { label: 'Threads', recordHistory: false });
        // Only when there is a message to record against. The catch-up scan passes none:
        // it reads the whole story rather than one reply, so there is no swipe to return
        // to and nothing for a rebuild to put back.
        //
        // Only what this message did, too - a thread dropped by the cap was not closed by
        // the reply, so a swipe back has nothing to undo about it.
        if ((opened || closed) && messageId !== null && messageId !== undefined) {
            recordThreadChanges(messageId, { opened: openedThreads, closed: closedIds });
        }
        debugLog(`Threads: opened ${opened}, closed ${closed}, touched ${touched}, `
            + `pruned ${pruned.open} open and ${pruned.closed} settled`);
    }
    return { opened, closed, touched, pruned };
}

/**
 * Brings an already-open chat within the caps.
 *
 * The caps arrived after the flooding did, so the chats that need them most are the ones
 * that already have eighty threads in them and would otherwise carry that until their next
 * extraction. Runs on chat load.
 *
 * It says what it removed rather than doing it quietly. Deleting sixty entries without a
 * word would look like the feature had lost them, and the number is the thing that makes
 * it read as tidying instead.
 *
 * @returns {{ open: number, closed: number }}
 */
export function tidyThreadsOnLoad() {
    const trackerSettings = getSettings().statusTracker;
    if (trackerSettings.threadsEnabled !== true) return { open: 0, closed: 0 };

    const state = loadStateFromMetadata();
    if (!Array.isArray(state?.threads) || !state.threads.length) return { open: 0, closed: 0 };

    const pruned = pruneThreads(state, currentMessageIndex());
    if (!pruned.open && !pruned.closed) return pruned;

    saveStateToMetadata(state, { label: 'Threads', recordHistory: false });

    const parts = [];
    if (pruned.open) parts.push(`${pruned.open} stale`);
    if (pruned.closed) parts.push(`${pruned.closed} settled`);
    toastr.info(`Tidied ${parts.join(' and ')} thread${pruned.open + pruned.closed === 1 ? '' : 's'}. `
        + 'Pin one to keep it for good.', 'SillyNPC');
    debugLog(`Threads tidied on load: ${pruned.open} open, ${pruned.closed} settled`);
    return pruned;
}

/**
 * Extracts state from one message and applies it.
 *
 * @param {string} messageText
 * @param {string|number} messageId
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ applied: boolean, reason?: string }>}
 */
/**
 * Tells the user an extraction failed, without becoming a nuisance.
 *
 * Only the two cases where the tracker wanted to change something and could not: a reply
 * that would not parse, and a request that threw. A reply that parsed and found nothing to
 * change is the ordinary case and says nothing, and neither do the guards that decline to
 * run at all.
 *
 * Repeats are swallowed. A model that returns unusable output does it on every message,
 * and a toast per message would bury the chat it is complaining about.
 *
 * @param {string} message
 */
let lastReportedProblem = '';
function reportExtractionProblem(message) {
    if (message === lastReportedProblem) return;
    lastReportedProblem = message;
    if (typeof toastr !== 'undefined') toastr.warning(message, 'SillyNPC');
}

export async function extractStateFromMessage(messageText, messageId, options = {}) {
    const trackerSettings = getSettings().statusTracker;
    if (!trackerSettings.enabled) return { applied: false, reason: 'tracker disabled' };
    if (!options.force && trackerSettings.extractionMode !== 'extract') {
        return { applied: false, reason: 'extraction disabled' };
    }
    if (!messageText || !String(messageText).trim()) return { applied: false, reason: 'empty message' };

    // Keyed on the swipe as well as the message. On the message alone, the first swipe
    // was read and every later one came back 'already extracted' and was never looked at
    // - so whichever reply you kept, the tracker held the numbers from swipe 1.
    const swipeId = getContext()?.chat?.[Number(messageId)]?.swipe_id ?? 0;
    const key = `${messageId}:${swipeId}`;
    if (!options.force && extractedMessages.has(key)) return { applied: false, reason: 'already extracted' };
    if (extractionInFlight) return { applied: false, reason: 'already running' };

    extractionInFlight = true;
    try {
        const state = loadStateFromMetadata();
        // Before anything is applied. A later swipe of this message rebuilds from here
        // rather than from what this one leaves behind.
        rememberSwipeBase(messageId, state);
        const schema = buildExtractionSchema(trackerSettings);
        const leadUp = collectLeadUp(messageId, Number(trackerSettings.extractionContextMessages ?? 2));
        const userPrompt = buildUserPrompt(state, String(messageText), trackerSettings, leadUp);

        debugLog('Extraction request for message', key);
        const raw = await requestExtraction(userPrompt, schema, trackerSettings);

        const parsed = coerceToUpdate(raw);
        if (!parsed || typeof parsed !== 'object') {
            console.warn(LOG_PREFIX, 'Extraction returned nothing usable; state left unchanged.', raw);
            // Said out loud, not just to the console. A reply that could not be read and a
            // message that genuinely changed nothing look identical from the outside, so
            // silence here reads as "the tracker is broken" rather than "this one failed".
            reportExtractionProblem(
                'The reader replied with something that could not be read, so nothing was '
                + 'changed. A smaller or faster model is the usual cause; the full reply is '
                + 'in the browser console.',
            );
            return { applied: false, reason: 'unparseable' };
        }

        // Presence first: applyUpdate refuses to introduce characters in speakers mode,
        // so anyone the extraction reports must be admitted to the scene before their
        // stats can land.
        if (Array.isArray(parsed.characters)) {
            const names = parsed.characters.map(c => c?.name).filter(Boolean);
            // The prompt asks for everyone present, not just whoever changed, so this
            // list is complete and absence means departure.
            if (names.length) reconcileScenePresence(names, key, { authoritative: true });
        }

        // Threads, applied on their own rather than through applyUpdate. They are not
        // tracker state - nothing about them is a stat or an item - and routing them
        // through the update path would put them in the diff, the review rows and the
        // undo history as if a number had moved.
        //
        // They are also not held for review. A thread costs a line in the prompt and
        // closing a wrong one is a click; holding them would mean a decision per message
        // about something that is only ever context.
        applyThreadsFromReply(parsed, messageId, String(messageText));

        // Profiles, for whichever fields have been unlocked. Outside applyUpdate on
        // purpose: these live on the card rather than in the state.
        applyProfileFromReply(parsed);

        // Propose, then decide. A dry run says what the update would do, so additions,
        // removals and implausible jumps can be held back for a look rather than
        // becoming fact.
        const currentState = loadStateFromMetadata();
        const wouldBe = applyUpdate(parsed, { dryRun: true });
        const proposed = computeStateDiff(currentState, wouldBe, trackerSettings);
        // Standing decisions are applied before the split, not after. Filtering only the
        // pending half would let a protected item be deleted outright by anyone whose
        // "Ask Before Applying" is set loosely enough for removals to apply on their own.
        const changes = proposed.filter(change => !isItemDecided(change));
        const blocked = proposed.length - changes.length;

        // The reader's own account of what it did, put on the rows it explains. Never part
        // of the state: applyUpdate reads only the keys it knows, so "why" is inert there,
        // and it is read here instead.
        const unmatched = attachReasons(changes, parsed.why);
        if (parsed.why && Object.keys(parsed.why).length) {
            debugLog('Why the reader changed things', parsed.why);
        }

        const { auto, pending } = partitionChanges(changes, trackerSettings);

        // The parsed update is only safe to apply whole when nothing was held back. If a
        // row was blocked by a standing decision, applying `parsed` would carry out the
        // very change that was blocked, so the surviving rows are rebuilt instead.
        if (pending.length === 0 && blocked === 0) {
            applyUpdate(parsed);
        } else if (auto.length > 0) {
            // Apply the uncontroversial part now so the tracker stays current while the
            // rest waits.
            applyUpdate(buildUpdateFromChanges(auto, currentState, trackerSettings));
        }

        // Now that the message's own update has landed, the clock has moved - so what
        // elapsed time implies can be worked out. This is arithmetic on a timestamp the
        // narrator wrote, not a reading of the prose, so it applies rather than being
        // proposed, and lands as its own undo step.
        const timed = applyTimeRules(messageId);

        // Written even when nothing changed, so a quiet message is distinguishable from
        // a message older than the record. Costs no prompt tokens: extra is not read
        // back into the context.
        const applied = (pending.length === 0 ? changes : auto).concat(timed.rows);
        recordAppliedChanges(messageId, applied);

        if (pending.length > 0) {
            setPendingChanges(messageId, pending, unmatched);
            debugLog(`${pending.length} change(s) awaiting review on message ${key}`);
        }

        extractedMessages.add(key);
        // Cleared on success so a later failure is announced rather than swallowed as a
        // repeat of one the user has already dealt with.
        lastReportedProblem = '';
        debugLog('Extraction applied for message', key);
        return { applied: true, pending: pending.length };
    } catch (err) {
        console.error(LOG_PREFIX, 'Extraction failed; state left unchanged.', err);
        reportExtractionProblem(`The tracker could not read this message: ${err?.message || err}`);
        return { applied: false, reason: String(err?.message || err) };
    } finally {
        extractionInFlight = false;
    }
}
