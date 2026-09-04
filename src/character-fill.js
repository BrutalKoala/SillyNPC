import { getContext } from '../../../../st-context.js';
import { loadWorldInfo } from '../../../../world-info.js';
import { getSettings, saveSettings } from './settings.js';
import { debugLog, PROFILE_FIELDS } from './constants.js';
import { requestExtraction, coerceToUpdate, describeCollections } from './status-extractor.js';
import { applyUpdate, resolveMaxValue, loadStateFromMetadata } from './status-logic.js';
import { describeTrackedFacts, describeProfile, buildLoreExcerpt, createLoreEntry, generateLoreContent, saveLoreContent } from './api.js';
import { tryAutoSyncLorebook, getChatLorebookName } from './lorebook.js';
import { charactersMentionedIn } from './mentions.js';
import { getPersonaData } from './status-logic.js';

/**
 * Filling in a character card that was created from a chat, or by hand, and is empty.
 *
 * Three things make a card useful, in this order, because each one feeds the next: a lore
 * entry describing who they are, the tracker fields that put them in the system, and a
 * portrait. Doing them one at a time meant three separate trips through three different
 * panels, and a character mentioned once in the story usually got none of them.
 */

/**
 * The fields this card is supposed to have.
 *
 * The player and a character are configured from different lists - that is what the
 * Player and Character halves of System Builder are - so Fill has to ask which it is
 * filling before it can say what is missing.
 */
export function requiredStatNames(char) {
    const tracker = getSettings().statusTracker;
    return ((char?.isPlayer ? tracker.playerStats : tracker.npcStats) || [])
        .map(stat => stat?.name)
        .filter(Boolean);
}

/**
 * Where this card's values actually are.
 *
 * A character's live on the card, which is what they walk back into a scene carrying.
 * The player's live in the chat: the card is only the seed a new chat starts from, so
 * reading it would report fields as empty that the player has had for fifty messages.
 */
function storedFacts(char) {
    if (!char?.isPlayer) {
        return { stats: char?.statusOverrides || {}, collections: char?.statusCollections || {} };
    }
    let state = null;
    try { state = loadStateFromMetadata(); } catch { /* no chat open */ }
    return { stats: state?.player?.stats || {}, collections: state?.player?.collections || {} };
}

/** Which of those the card has nothing for. A blank string counts as nothing. */
export function missingStats(char) {
    const { stats } = storedFacts(char);
    return requiredStatNames(char).filter(name => !String(stats[name] ?? '').trim());
}

/** The collections this card can hold anything in. */
function fillableCollections(char) {
    const wanted = char?.isPlayer ? 'player' : 'npc';
    return (getSettings().statusTracker.collections || [])
        .filter(col => col?.id && (col.target === 'all' || col.target === wanted));
}

/** What this card already carries, by item name, across every collection. */
export function carriedItems(char) {
    const stored = storedFacts(char).collections;
    const names = [];
    for (const col of fillableCollections(char)) {
        for (const item of stored[col.id] || []) {
            const name = String(item?.name ?? '').trim();
            if (name) names.push(name);
        }
    }
    return names;
}

/**
 * What this card is missing, and what filling it would do.
 *
 * Read before anything is sent, so the plan shown to the user is the plan that runs. A
 * stage already done is reported as done rather than quietly skipped, because "nothing
 * happened" and "there was nothing to do" look the same from outside.
 *
 * `checked` is what the plan ticks by default, and it is not simply the opposite of
 * `done`: belongings are offered on a character who already carries things, but not
 * ticked, because adding to a list somebody curated by hand is not what they asked for
 * when they pressed a button about empty fields.
 *
 * @param {object} char
 * @returns {{ lore: object, data: object, belongings: object, image: object, anything: boolean }}
 */
export function auditCharacter(char) {
    const missingProfile = missingProfileFields(char);
    const profile = missingProfile.length === 0
        ? { done: true, summary: 'Age, appearance, personality and speech are all filled in.' }
        : {
            done: false,
            missing: missingProfile.map(f => f.id),
            summary: `${missingProfile.length} of ${PROFILE_FIELDS.length} empty: `
                + `${missingProfile.map(f => f.label).join(', ')}.`,
        };

    const lore = char?.lorebook
        ? { done: true, summary: 'Already linked to a lorebook entry.' }
        : { done: false, summary: 'No lorebook entry. Will look for one, and write it if there is none.' };

    const missing = missingStats(char);
    const data = missing.length === 0
        ? { done: true, missing: [], summary: 'Every tracker field already has a value.' }
        : { done: false, missing, summary: `${missing.length} of ${requiredStatNames(char).length} fields are empty: ${missing.join(', ')}.` };

    const carried = carriedItems(char);
    const belongings = fillableCollections(char).length === 0
        ? { done: true, summary: 'No collections are configured for characters.' }
        : carried.length
            // Offered, but not ticked. Nothing here is ever removed or duplicated, so the
            // only thing at stake is an item arriving that you did not ask for.
            ? { done: false, checked: false, summary: `Already carries ${carried.join(', ')}. Tick to let the story add more.` }
            : { done: false, checked: true, summary: 'Nothing recorded. Will add what the story plainly gives them.' };

    const image = char?.imageUrl
        ? { done: true, summary: 'Already has a portrait.' }
        : { done: false, summary: 'No portrait. Will draw one.' };

    const wanted = (stage) => stage.checked ?? !stage.done;
    return {
        profile, lore, data, belongings, image,
        anything: wanted(profile) || wanted(lore) || wanted(data)
            || wanted(belongings) || wanted(image),
    };
}

/**
 * Which profile fields this card has nothing for. A blank string counts as nothing.
 *
 * Not gated by the per-field lock, deliberately. The lock protects what you wrote, and an
 * empty field has nothing to protect - so Fill may still seed a blank on a brand-new
 * character and leave you to correct it. What the lock stops is the per-message reader
 * *changing* a field afterwards; see aiMayEditProfileField.
 */
export function missingProfileFields(char) {
    const profile = char?.profile || {};
    return PROFILE_FIELDS.filter(field => !String(profile[field.id] ?? '').trim());
}

/** What the reader is told when filling in who somebody is. */
export const PROFILE_SYSTEM_PROMPT = [
    'You are filling in the profile of one character in a roleplaying session.',
    'Reply with a JSON object and nothing else. No prose, no markdown, no code fences.',
    '',
    'Shape:',
    '  { "<field>": "<value>" }',
    '',
    '- Fill only the fields you are asked for. Omit any field the material does not',
    '  support - a blank is an honest answer, and a guess becomes a fact the moment it',
    '  is written to the sheet.',
    '- Describe what this character IS, not what is happening to them right now. A profile',
    '  outlives the scene it was written from.',
    '- Third person. No preamble.',
].join('\n');

/**
 * What there is to go on, before anything is sent.
 *
 * Four cases, and the one that mattered is the last: a character with no entry who has not
 * appeared yet. Fill used to send the recent story anyway, and the recent story is the
 * reader's own messages and their persona - so the model described the persona, because
 * that was the only person in front of it. Withholding the story is what makes that
 * impossible rather than merely discouraged.
 *
 * An entry the reader wrote by hand but never linked counts. fillLore has always looked
 * for one; fillProfile never did, so a perfectly good description sat unread unless the
 * link had been made by hand.
 *
 * @param {object} char
 * @returns {Promise<{ story: string, lore: string, enough: boolean }>}
 */
export async function fillSources(char) {
    // The linked entry, or one that matches by name and was never linked to.
    let lore = await readLoreEntry(char);
    if (!lore && !char?.lorebook) {
        if (await tryAutoSyncLorebook(char, { silent: true })) {
            lore = await readLoreEntry(char);
        }
    }

    /* Name and non-regex aliases, on word boundaries, honouring the case-insensitive
       setting - charactersMentionedIn is that matcher and is what decides who the tracker
       reads about, so Fill agreeing with it is worth more than a second rule that could
       disagree. Passed this one character rather than the cast: the question is whether
       *they* are in it. */
    const excerpt = buildLoreExcerpt(getContext()?.chat || []);
    const mentioned = excerpt.text
        ? charactersMentionedIn(excerpt.text, [char]).length > 0
        : false;

    return {
        story: mentioned ? excerpt.text : '',
        lore,
        enough: Boolean(mentioned || lore),
    };
}

/**
 * The ask, generated from the field list so a field cannot exist without being asked for.
 */
function buildProfilePrompt(char, wanted, sources) {
    const parts = [`Character: ${char.name}`];

    // Named so the story cannot be mistaken for a description of them. The reader writes
    // most of what is in an excerpt, so their persona is the best-described person in it
    // by some distance, and the subject may be a passing mention.
    const persona = getPersonaData();
    if (persona?.name && persona.name !== char.name) {
        parts.push(`${persona.name} is the reader's own character, not the subject. `
            + `Nothing about ${persona.name} belongs on ${char.name}'s profile.`);
    }

    const known = describeProfile(char);
    if (known) parts.push(`Already known about them, do not contradict it:\n${known}`);

    /* The story first, and said to be the better source.

       A lorebook entry is written to steer a scene, so it is often broad where a profile
       wants the particular - and it may itself have been written from a chat this
       character was barely in. What they were seen doing beats what an entry says about
       them, so the story leads and the entry backs it up.

       The story is here at all only when they are in it. See fillSources. */
    if (sources.story) {
        parts.push(`Recent story - the best source, describe them from what they do here:\n`
            + sources.story);
    }

    if (sources.lore) {
        parts.push((sources.story ? 'Their lorebook entry, as background' : 'Their lorebook entry')
            + `:\n${sources.lore}`);
    }

    const facts = describeTrackedFacts(char);
    if (facts) parts.push(`What the tracker records about them:\n${facts}`);

    parts.push(
        'Fill in these fields:\n'
        + wanted.map(field => `- ${field.id}: ${field.hint}`).join('\n'),
    );

    return parts.join('\n\n');
}

/**
 * Fills in who somebody is, from the story, their entry and what the tracker knows.
 *
 * Only blanks. A field you wrote yourself is the one thing on the card that is certainly
 * right, and a fill that overwrote it would make the button dangerous rather than useful -
 * the same rule fillData follows for tracker fields.
 *
 * Writes straight to the card rather than through applyUpdate: a profile is not tracker
 * state, and routing it through the update path is exactly how it would end up somewhere
 * the per-message reader could reach it.
 *
 * @returns {Promise<{ ok: boolean, filled: string[], reason?: string }>}
 */
export async function fillProfile(char) {
    const wanted = missingProfileFields(char);
    if (wanted.length === 0) return { ok: true, filled: [] };

    const sources = await fillSources(char);
    if (!sources.enough) {
        return {
            ok: true, filled: [],
            reason: `Nothing to go on: ${char.name} has no lorebook entry and is not `
                + 'mentioned in the recent story. Write them into a message, or give them '
                + 'an entry, and try again.',
        };
    }

    const prompt = buildProfilePrompt(char, wanted, sources);
    const raw = await requestExtraction(
        prompt, null, getSettings().statusTracker, PROFILE_SYSTEM_PROMPT, { usageKind: 'fill' });
    const answer = coerceToUpdate(raw);

    if (!answer || typeof answer !== 'object') {
        return { ok: false, filled: [], reason: 'The reader replied with something that could not be read.' };
    }

    if (!char.profile || typeof char.profile !== 'object') char.profile = {};
    const filled = [];
    for (const field of wanted) {
        const value = answer[field.id];
        if (value === undefined || value === null || String(value).trim() === '') continue;
        char.profile[field.id] = String(value).trim();
        filled.push(field.label);
    }

    if (!filled.length) {
        return { ok: true, filled: [], reason: 'The material did not say enough to fill anything.' };
    }

    saveSettings();
    return { ok: true, filled };
}

/** The linked entry's text, or an empty string. Read fresh: it may have just been written. */
export async function readLoreEntry(char) {
    if (!char?.lorebook?.world) return '';
    try {
        const worldData = await loadWorldInfo(char.lorebook.world);
        const entries = worldData?.entries;
        const entry = Array.isArray(entries)
            ? entries.find(e => Number(e.uid) === Number(char.lorebook.uid))
            : entries?.[char.lorebook.uid];
        return entry?.content || '';
    } catch (err) {
        debugLog('Could not read the linked lore entry', err);
        return '';
    }
}

/**
 * Gives the card a lore entry: the one that already exists, or a new one.
 *
 * Linking beats writing. A character named in a lorebook the user has curated by hand is
 * better described there than by anything generated, and writing a second entry for the
 * same person is how a lorebook fills up with duplicates.
 *
 * @returns {Promise<{ ok: boolean, action: string, reason?: string }>}
 */
export async function fillLore(char) {
    if (char.lorebook) return { ok: true, action: 'already linked' };

    if (await tryAutoSyncLorebook(char, { silent: true })) {
        return { ok: true, action: 'linked an existing entry' };
    }

    const world = getSettings().defaultLorebook || getChatLorebookName();
    if (!world) {
        return {
            ok: false, action: 'none',
            reason: 'No lorebook to write into. Choose a Default Target Lorebook in Generation, '
                + 'or open a chat that has one.',
        };
    }

    /* No test on whether there is anything to write from.

       An entry is worth having for a character who has not appeared yet - that is most of
       what somebody is doing when they make a card in advance - and the lore writer reads
       the Data Bank and its own configurable slice of the chat, which is a different and
       larger question than "is this name in the last fifteen messages".

       The profile is the one that must not describe somebody it has never been told about;
       see fillSources. Applying the same test here refused far more than intended, because
       its Data Bank half is switched off by default. */
    const { uid } = await createLoreEntry(char, world, char.name);
    const { content, tags } = await generateLoreContent(char, world, uid);
    if (!String(content || '').trim()) {
        return { ok: false, action: 'none', reason: 'The lore writer returned nothing usable.' };
    }

    await saveLoreContent(char, world, uid, tags, content);
    return { ok: true, action: `wrote a new entry in "${world}"` };
}

/** What the reader is told when filling one character's fields. */
export const FILL_SYSTEM_PROMPT = [
    'You are filling in a character sheet for one character in a roleplaying session.',
    'Reply with a JSON object and nothing else. No prose, no markdown, no code fences.',
    '',
    'Shape:',
    '  { "stats": { "<field>": "<value>" }, "collections": { "<id>": [ {...} ] } }',
    '',
    '- Fill only the fields you are asked for. Omit any field the material does not',
    '  support - a blank is an honest answer, and a guess becomes a fact the moment it',
    '  is written to the sheet.',
    '- Write a value that has a maximum as "current/maximum", for example "8/10".',
    '- Collections are optional. Include an item only where the material plainly says',
    '  this character has it.',
].join('\n');

/**
 * The material the reader is given about one character.
 *
 * Belongings are described only when they are wanted. Naming the collections at all is an
 * invitation to fill them, and the point of the separate tick is that a curated inventory
 * is left alone unless it was asked about.
 */
export function buildFillPrompt(char, missing, lore, trackerSettings, { collections = true } = {}) {
    const defs = ((char?.isPlayer ? trackerSettings.playerStats : trackerSettings.npcStats) || [])
        .filter(s => missing.includes(s?.name));
    const describe = (stat) => {
        const max = resolveMaxValue(stat);
        const range = max ? ` (out of ${max})` : '';
        const example = stat.defaultValue ? `, typically "${stat.defaultValue}"` : '';
        return `- ${stat.name}${range}${example}`;
    };

    const facts = describeTrackedFacts(char);
    const chat = getContext()?.chat || [];
    const schema = collections ? describeCollections(trackerSettings) : '';

    return [
        '### CHARACTER',
        char.name,
        '',
        '### FIELDS TO FILL',
        defs.map(describe).join('\n') || '(none)',
        schema ? '\n### BELONGINGS THEY MAY HAVE\n' + schema
            + '\nOnly where the material plainly gives it to them.' : '',
        facts ? '\n### ALREADY RECORDED ABOUT THEM\n' + facts : '',
        lore ? '\n### THEIR LORE ENTRY\n' + lore : '',
        '\n### RECENT MESSAGES',
        buildLoreExcerpt(chat).text || '(no chat to read)',
        '\n### TASK',
        `Fill in what the material supports for ${char.name}, as JSON.`,
    ].filter(Boolean).join('\n');
}

/**
 * Reads the story and the lore entry, and writes what it finds to the card.
 *
 * Only the fields that were empty. Filling a card is not licence to rewrite values
 * somebody set by hand, and the answer is a reading of prose either way.
 *
 * The two halves are chosen separately in the plan, and both travel in one request: a
 * character can need a field without wanting their inventory touched, and can want
 * belongings with every field already set.
 *
 * @param {object} char
 * @param {{ fields?: boolean, collections?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, filled: string[], items: number, reason?: string }>}
 */
export async function fillData(char, { fields = true, collections = true } = {}) {
    const trackerSettings = getSettings().statusTracker;
    const missing = fields ? missingStats(char) : [];
    if (missing.length === 0 && !collections) return { ok: true, filled: [], items: 0 };

    const lore = await readLoreEntry(char);
    const prompt = buildFillPrompt(char, missing, lore, trackerSettings, { collections });
    const raw = await requestExtraction(prompt, null, trackerSettings, FILL_SYSTEM_PROMPT, { usageKind: 'fill' });
    const answer = coerceToUpdate(raw);

    if (!answer || typeof answer !== 'object') {
        return { ok: false, filled: [], items: 0, reason: 'The reader replied with something that could not be read.' };
    }

    // Only what was asked for. A model that answers about fields already filled in is
    // answering a question nobody asked, and acting on it would overwrite a real value.
    const stats = {};
    for (const name of missing) {
        const value = answer.stats?.[name];
        if (value === undefined || value === null || String(value).trim() === '') continue;
        stats[name] = String(value);
    }

    // Dropped rather than merely unasked for: a model that offers belongings anyway must
    // not get them onto a card whose owner declined that tick.
    const offered = (collections && answer.collections && typeof answer.collections === 'object')
        ? answer.collections : {};
    const items = Object.values(offered)
        .reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);

    if (!Object.keys(stats).length && !items) {
        return { ok: true, filled: [], items: 0, reason: 'The material did not say enough to fill anything.' };
    }

    if (char.isPlayer) {
        // Never through `characters`. That channel admits whoever it names into the scene
        // cast, and putting the player there is the exact thing "this is me" exists to
        // stop - it would give them a tracker row beside their own HUD.
        applyUpdate({ player: { stats, collections: offered } }, { label: 'Filled in' });
    } else {
        // admitCharacters writes to the card for someone who is not in the scene, which is
        // the usual case for a card being filled in, and to the scene for someone who is.
        applyUpdate(
            { characters: [{ name: char.name, stats, collections: offered }] },
            { label: 'Filled in', admitCharacters: true },
        );
    }

    return { ok: true, filled: Object.keys(stats), items };
}
