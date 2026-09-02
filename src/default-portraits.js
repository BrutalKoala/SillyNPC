import { getSettings, saveSettings } from './settings.js';
import { persistGeneratedImage } from './api.js';
import { debugLog } from './constants.js';
import { getContext } from '../../../../st-context.js';

/**
 * Faces for people who have none.
 *
 * There used to be one fallback picture, so every stranger in the story wore the same
 * face. A pool means a crowd looks like a crowd - but which face somebody gets cannot be
 * decided fresh each time it is asked, because it is asked on every render of every
 * message. A random draw per call would reshuffle every portrait in the chat on each
 * redraw, swipe and reload.
 *
 * So the draw happens once and is remembered. What it is remembered against differs by
 * who is asking:
 *
 *   - somebody with a card and no portrait keeps their face for good, written onto the
 *     card. They are a known person; a face that changes is a different person.
 *   - a stranger keeps theirs for a run of appearances and draws again if they come back
 *     much later. The guard you speak to for three messages is one guard; the guard two
 *     hundred messages later is somebody else wearing the same word.
 */

/** Where a chat records which face it gave to whom. */
export const FACES_KEY = 'sillynpc_faces';

/** How far apart two sightings have to be before the second is somebody new. */
export const DEFAULT_RUN_GAP = 12;

/* ─── The pool ────────────────────────────────────────────────────────────── */

/** The pool, always an array of entries with a src and a tag list. */
export function getPool() {
    const images = getSettings().defaultImages;
    if (!Array.isArray(images)) return [];
    return images.filter(entry => entry && typeof entry.src === 'string' && entry.src);
}

/**
 * Moves any picture still held as a data URI onto disk.
 *
 * The old single fallback was assigned straight into settings.json, which is the bloat
 * writing portraits to disk exists to avoid - settings.json grew by the size of the image
 * and was rewritten on every save. A pool of them would multiply it.
 *
 * Separate from normalizeSettings because this needs a write and that pass cannot wait
 * for one. Safe to run at every startup: an entry already on disk is left alone, and a
 * write that fails leaves the entry as it was rather than losing the picture.
 *
 * @returns {Promise<number>} How many were moved.
 */
export async function repairDefaultImages() {
    const images = getSettings().defaultImages;
    if (!Array.isArray(images)) return 0;

    let moved = 0;
    for (const entry of images) {
        if (!entry || typeof entry.src !== 'string' || !entry.src.startsWith('data:')) continue;
        try {
            const stored = await persistGeneratedImage(entry.src, 'default');
            if (stored && !stored.startsWith('data:')) { entry.src = stored; moved++; }
        } catch (err) {
            debugLog('Could not move a fallback portrait to disk', err);
        }
    }

    if (moved) saveSettings();
    return moved;
}

/**
 * A word reduced to what it shares with its plural.
 *
 * Categories are named in the plural and tags in the singular - "Nobles" holding people
 * you would tag "noble" - so without this the two never meet, and the tag that would have
 * been most useful is the one that silently does nothing.
 *
 * A trailing s and no more. Real stemming is a library, and the words being matched here
 * are one or two the user chose themselves; "witches" against "witch" is the price, and
 * they can add the tag they actually typed.
 */
function stem(word) {
    return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

/** The words in a name or a category, lowercased and stemmed, for matching against tags. */
function wordsOf(text) {
    return String(text || '').toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean).map(stem);
}

/**
 * The entries worth drawing from for this speaker.
 *
 * A tag match wins when there is one: "Guard 1" should not draw a courtier. With no tag
 * matching anything the whole pool is eligible, so tagging some of them does not make the
 * rest unreachable - which is what would happen if a tagged pool only ever answered tags.
 *
 * @param {string} name The speaker's name.
 * @param {string} [category] A carded character's category, matched the same way.
 */
export function eligibleImages(name, category = '') {
    const pool = getPool();
    if (pool.length === 0) return [];

    const words = new Set([...wordsOf(name), ...wordsOf(category)]);
    if (words.size === 0) return pool;

    const tagged = pool.filter(entry =>
        (Array.isArray(entry.tags) ? entry.tags : [])
            .some(tag => wordsOf(tag).some(word => words.has(word))));

    return tagged.length ? tagged : pool;
}

/**
 * One of the eligible faces, at random.
 *
 * @param {string} name
 * @param {string} [category]
 * @param {() => number} [random] Injected so a test can say which one it wants.
 */
export function drawFace(name, category = '', random = Math.random) {
    const eligible = eligibleImages(name, category);
    if (eligible.length === 0) return '';
    return eligible[Math.floor(random() * eligible.length)]?.src || '';
}

/**
 * A face chosen from the name itself, the same way every time.
 *
 * For when there is nowhere to remember a choice - no message to file it against, or no
 * chat open. Drawing at random there would be the one thing this whole module exists to
 * prevent: a face that changes on every redraw. Deriving it from the name instead is not
 * random, but it is steady, and steady is the property that matters.
 */
export function steadyFace(name, category = '') {
    const eligible = eligibleImages(name, category);
    if (eligible.length === 0) return '';

    const text = String(name || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
    return eligible[Math.abs(hash) % eligible.length]?.src || '';
}

/* ─── Who has which face ──────────────────────────────────────────────────── */

/**
 * The chat's record of faces given out.
 *
 * The context key is `chatMetadata`; there is no `chat_metadata` on the context and
 * reading one returns a throwaway object, so every write would go to garbage.
 */
function facesRecord({ create = false } = {}) {
    const metadata = getContext()?.chatMetadata;
    if (!metadata) return null;
    if (!metadata[FACES_KEY] || typeof metadata[FACES_KEY] !== 'object') {
        if (!create) return null;
        metadata[FACES_KEY] = { runs: [] };
    }
    const record = metadata[FACES_KEY];
    if (!Array.isArray(record.runs)) record.runs = [];
    return record;
}

/** Everything this chat has handed out, for the panel that lists it. */
export function getRuns() {
    return facesRecord()?.runs ?? [];
}

/** Forgets every assignment, so the next sighting of everybody draws again. */
export function clearRuns() {
    const record = facesRecord({ create: true });
    if (!record) return;
    record.runs = [];
    getContext()?.saveMetadataDebounced?.();
}

/**
 * The face this stranger wears in this message.
 *
 * Looking at an old message must never change what it showed, so a message inside a run
 * that already covers it is answered without writing anything. A sighting close after the
 * end of a run extends it; one far enough after starts a new run, which is the whole
 * point - the same word two hundred messages later is a different person.
 *
 * @param {string} name
 * @param {number} messageId
 * @param {{ gap?: number, random?: () => number }} [options]
 * @returns {string} A portrait path, or '' when the pool is empty.
 */
export function faceForStranger(name, messageId, { gap, random } = {}) {
    if (!name || getPool().length === 0) return '';

    // Nothing to file a choice against, or nowhere to file it. Steady rather than
    // random: a random draw here would change the face on every redraw, which is the
    // one failure this module exists to prevent.
    const at = Number(messageId);
    if (!Number.isFinite(at)) return steadyFace(name);

    const record = facesRecord({ create: true });
    if (!record) return steadyFace(name);

    const key = String(name).toLowerCase();
    const mine = record.runs.filter(run => run && run.name === key);

    // Already covered: answer, and touch nothing. This is what makes scrolling back
    // through the chat show the same faces it showed the first time.
    const covering = mine.find(run => at >= run.first && at <= run.last);
    if (covering) return covering.src;

    const window = Number.isFinite(Number(gap))
        ? Number(gap)
        : (Number(getSettings().defaultPortraitRunGap) || DEFAULT_RUN_GAP);

    // Still the same person: extend whichever run this sits closest after.
    const recent = mine
        .filter(run => at > run.last && at - run.last <= window)
        .sort((a, b) => b.last - a.last)[0];
    if (recent) {
        recent.last = at;
        getContext()?.saveMetadataDebounced?.();
        return recent.src;
    }

    const src = drawFace(name, '', random);
    if (!src) return '';
    record.runs.push({ name: key, src, first: at, last: at });
    getContext()?.saveMetadataDebounced?.();
    return src;
}

/**
 * The face this card wears while it has no portrait of its own.
 *
 * Kept on the card rather than in the chat, and for good rather than for a run: a
 * character with a card is somebody the story knows by name, and they should look the
 * same in every chat they appear in.
 *
 * Held in its own field rather than in imageUrl. imageUrl means "a picture of this
 * character", which a shared fallback is not - putting one there would send it out with
 * an export and step through it with the portrait arrows.
 *
 * @param {object} char
 * @param {{ random?: () => number }} [options]
 * @returns {string}
 */
export function faceForCard(char, { random } = {}) {
    if (!char || getPool().length === 0) return '';

    // A card with a portrait of its own needs no fallback. Without this, every carded
    // character in the chat would draw one and have it written to their card on the first
    // render - a field nothing ever reads, saved on everybody.
    if (char.imageUrl) return '';

    // Still in the pool? A face that was removed has to be replaced rather than left
    // pointing at a file that is gone.
    const pool = getPool();
    if (char.defaultPortrait && pool.some(entry => entry.src === char.defaultPortrait)) {
        return char.defaultPortrait;
    }

    const src = drawFace(char.name, char.category, random);
    if (!src) return '';
    char.defaultPortrait = src;
    saveSettings();
    return src;
}

/**
 * Whichever of the two applies, for one speaker in one message.
 *
 * @param {{ char?: object, name?: string, messageId?: number }} who
 * @returns {string}
 */
export function faceFor({ char, name, messageId }) {
    if (char) return faceForCard(char);
    return faceForStranger(name, messageId);
}
