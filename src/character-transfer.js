import { getSettings, saveSettings, normalizeSettings } from './settings.js';
import { createCharacter } from './characters.js';
import { toDataUrl, adoptImageForCharacter, createLoreEntry, saveLoreContent } from './api.js';
import { tryAutoSyncLorebook, getChatLorebookName } from './lorebook.js';
import { loadWorldInfo } from '../../../../world-info.js';
import { blankProfile, PROFILE_FIELDS, debugLog } from './constants.js';

/**
 * Sending one character to somebody else, and taking one in.
 *
 * Separate from the whole-settings export in settings.js, which is a backup: it replaces
 * everything you have with everything in the file. This is the other job - one character
 * out of a collection, into somebody else's collection, alongside what is already there.
 *
 * The difference that shapes the format is that the file has to survive leaving this
 * machine. Two things a character record holds are meaningless anywhere else:
 *
 *   - portraits are stored as paths into /user/images, so a path names a file the
 *     recipient does not have. They are inlined as data URIs here and written back to
 *     disk on the way in.
 *   - the lorebook link is { world, uid } - an index into a book the recipient has no
 *     copy of. The entry's own words travel instead.
 */

export const TRANSFER_FORMAT = 'sillynpc-characters';
export const TRANSFER_VERSION = 1;

/* ─── Out ─────────────────────────────────────────────────────────────────── */

/** A character's lore entry as words rather than as a pointer, or null. */
async function readLoreEntry(char) {
    if (!char?.lorebook?.world) return null;
    try {
        const worldData = await loadWorldInfo(char.lorebook.world);
        const entries = worldData?.entries;
        const entry = Array.isArray(entries)
            ? entries.find(e => Number(e.uid) === Number(char.lorebook.uid))
            : entries?.[char.lorebook.uid];
        if (!entry || !String(entry.content ?? '').trim()) return null;
        return {
            keys: Array.isArray(entry.key) ? entry.key.map(String) : [],
            content: String(entry.content),
        };
    } catch (err) {
        debugLog('Could not read the lore entry for export', err);
        return null;
    }
}

/**
 * One character, as something that can be sent.
 *
 * A portrait whose file has gone is dropped rather than exported as a hole: the count
 * comes back so the caller can say how many, instead of the recipient finding out.
 *
 * @param {object} char
 * @returns {Promise<{ record: object, lostImages: number }>}
 */
export async function serialiseCharacter(char) {
    const images = [];
    let lostImages = 0;
    let portrait = -1;

    for (const path of Array.isArray(char.images) ? char.images : []) {
        const dataUri = await toDataUrl(path);
        if (!dataUri) { lostImages++; continue; }
        if (path === char.imageUrl) portrait = images.length;
        images.push(dataUri);
    }

    const profile = {};
    for (const field of PROFILE_FIELDS) {
        const value = String(char.profile?.[field.id] ?? '').trim();
        if (value) profile[field.id] = value;
    }

    return {
        lostImages,
        record: {
            name: String(char.name || ''),
            color: String(char.color || ''),
            category: String(char.category || ''),
            imageFit: String(char.imageFit || ''),
            aliases: Array.isArray(char.aliases) ? structuredClone(char.aliases) : [],
            profile,
            statusOverrides: char.statusOverrides && typeof char.statusOverrides === 'object'
                ? structuredClone(char.statusOverrides)
                : {},
            images,
            // Which of them is in use, by position - the paths do not survive the trip.
            portrait: portrait >= 0 ? portrait : (images.length ? 0 : -1),
            lore: await readLoreEntry(char),
        },
    };
}

/**
 * The file, for one character or a selection of them.
 *
 * @param {object[]} chars
 * @returns {Promise<{ payload: object, lostImages: number }>}
 */
export async function exportCharacters(chars) {
    const records = [];
    let lostImages = 0;

    for (const char of chars) {
        const { record, lostImages: lost } = await serialiseCharacter(char);
        records.push(record);
        lostImages += lost;
    }

    return {
        lostImages,
        payload: {
            format: TRANSFER_FORMAT,
            version: TRANSFER_VERSION,
            exported: new Date().toISOString(),
            characters: records,
        },
    };
}

/* ─── In ──────────────────────────────────────────────────────────────────── */

/**
 * Reads a transfer file, refusing anything that is not one.
 *
 * Told apart from a whole-settings backup on purpose, and by name rather than by shape:
 * a backup also has a `characters` array, and importing one here would take a person's
 * whole collection and file it as a single character.
 *
 * @param {string} text
 * @returns {object} The payload.
 */
export function parseTransferFile(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('That file is not JSON.');
    }

    if (!data || typeof data !== 'object') throw new Error('That file is empty.');

    if (data.format !== TRANSFER_FORMAT) {
        throw new Error(Array.isArray(data.characters)
            ? 'That looks like a full settings backup rather than a character file. '
              + 'Import it from Advanced, which replaces everything rather than adding to it.'
            : 'That is not a SillyNPC character file.');
    }
    if (!Array.isArray(data.characters) || data.characters.length === 0) {
        throw new Error('That character file has nobody in it.');
    }
    if (Number(data.version) > TRANSFER_VERSION) {
        throw new Error(`That file was written by a newer version of SillyNPC (${data.version}).`);
    }

    return data;
}

/** A name nobody is using yet: "Vesper", then "Vesper (2)", "Vesper (3)". */
function freeName(wanted) {
    const taken = new Set((getSettings().characters || [])
        .map(c => String(c.name || '').toLowerCase()));
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; ; n++) {
        const candidate = `${wanted} (${n})`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
}

/** Writes the record's fields onto a card, leaving its id and its place alone. */
function applyRecord(char, record, name) {
    char.name = name;
    char.color = String(record.color || char.color || '');
    char.imageFit = String(record.imageFit || '');
    char.aliases = Array.isArray(record.aliases) ? structuredClone(record.aliases) : [];
    char.statusOverrides = record.statusOverrides && typeof record.statusOverrides === 'object'
        ? structuredClone(record.statusOverrides)
        : {};

    // Field by field, for the same reason normalizeSettings does it that way: a file
    // written before a field existed should gain it blank, not replace the set.
    char.profile = blankProfile();
    for (const field of PROFILE_FIELDS) {
        const value = record.profile?.[field.id];
        if (typeof value === 'string') char.profile[field.id] = value;
    }

    // The category name comes along; registering it is normalizeSettings' job, which the
    // import runs at the end. It already adopts any category a card names but the register
    // does not list, so creating it here would be the same work done twice.
    char.category = String(record.category || '');
}

/** Writes the inlined portraits back to disk and points the card at the right one. */
async function restoreImages(char, record) {
    char.images = [];
    char.imageUrl = '';

    const wanted = Number(record.portrait);
    const stored = [];
    for (const dataUri of Array.isArray(record.images) ? record.images : []) {
        if (typeof dataUri !== 'string' || !dataUri.startsWith('data:')) continue;
        // Writes the file, adds it to the list and points imageUrl at it - the same path a
        // portrait chosen from disk takes, so an imported one behaves like any other.
        stored.push(await adoptImageForCharacter(char, dataUri));
    }

    if (stored.length) {
        char.imageUrl = stored[wanted >= 0 && wanted < stored.length ? wanted : 0];
    }
}

/**
 * Gives the imported card its lore.
 *
 * An entry the recipient already keeps for this name wins, and the file's words are
 * dropped - the same rule fillLore follows, and for the same reason: a lorebook curated
 * by hand is better than anything arriving in a file, and writing a second entry for one
 * person is how a lorebook fills with duplicates.
 *
 * @returns {Promise<string>} What happened, for the report.
 */
async function restoreLore(char, record) {
    if (!record.lore || !String(record.lore.content || '').trim()) return '';

    if (await tryAutoSyncLorebook(char, { silent: true })) {
        return 'kept your existing lore entry';
    }

    const world = getSettings().defaultLorebook || getChatLorebookName();
    if (!world) return 'no lorebook to write the lore into';

    try {
        const { uid } = await createLoreEntry(char, world, char.name);
        await saveLoreContent(char, world, uid, (record.lore.keys || []).join(', '), record.lore.content);
        return `wrote its lore into "${world}"`;
    } catch (err) {
        debugLog('Could not write the imported lore entry', err);
        return 'could not write its lore entry';
    }
}

/**
 * Brings the characters in a file into the collection, alongside what is there.
 *
 * `onCollision` is asked what to do about a name already in use and answers 'rename',
 * 'overwrite' or 'skip'. With no handler the answer is rename: an import must not destroy
 * anything without being told to, and a duplicate can be deleted afterwards while an
 * overwritten character cannot be brought back.
 *
 * @param {object} payload From parseTransferFile.
 * @param {{ onCollision?: (name: string) => Promise<string> }} [options]
 * @returns {Promise<{ added: string[], overwritten: string[], skipped: string[], notes: string[] }>}
 */
export async function importCharacters(payload, { onCollision } = {}) {
    const result = { added: [], overwritten: [], skipped: [], notes: [] };

    for (const record of payload.characters) {
        const wanted = String(record?.name || '').trim();
        if (!wanted) { result.skipped.push('(unnamed)'); continue; }

        const existing = (getSettings().characters || [])
            .find(c => String(c.name || '').toLowerCase() === wanted.toLowerCase());

        let choice = 'rename';
        if (existing) choice = onCollision ? await onCollision(wanted) : 'rename';
        if (existing && choice === 'skip') { result.skipped.push(wanted); continue; }

        const overwriting = Boolean(existing) && choice === 'overwrite';

        // Named before the card exists, not after. createCharacter adds one under this
        // name straight away, so asking afterwards what names are free finds the card it
        // is about to name and renames around it - every import arrived as "(2)".
        const name = overwriting ? wanted : freeName(wanted);

        // Overwriting keeps the card that is already there - its id and its position -
        // and replaces what is on it. A fresh card would take the name while cast
        // decisions and anything else pointing at the old id kept pointing at a ghost.
        const char = overwriting ? existing : createCharacter(name);

        applyRecord(char, record, name);
        await restoreImages(char, record);
        const loreNote = await restoreLore(char, record);
        if (loreNote) result.notes.push(`${name}: ${loreNote}`);

        (overwriting ? result.overwritten : result.added).push(name);
    }

    // The same repair pass settings loaded at startup go through, for the same reason:
    // a file written by an older version is missing whatever has been added since.
    normalizeSettings(getSettings());
    saveSettings();
    return result;
}
