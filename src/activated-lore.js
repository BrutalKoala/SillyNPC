import { getSettings } from './settings.js';

/**
 * Which lorebook entries SillyTavern fired for the turn being generated.
 *
 * Lived in status-extractor.js, where only the reader could reach it. The scene block needs
 * the same answer now - a character whose entry just fired is one the narrator may be about
 * to write in, and sending their lore without their stats or their profile is how the model
 * ends up inventing both - and status-logic.js cannot import status-extractor.js, because
 * status-extractor.js already imports status-logic.js.
 *
 * The same reasoning that moved the speaker labels, the reprocess handle and the mention
 * matcher out. Nothing here touches the DOM or the chat, so it can be imported from
 * anywhere.
 */

/** @type {Array<object>} */
let activatedEntries = [];

/**
 * Records which entries the last generation activated.
 *
 * A character can be linked to a lorebook entry, so an entry firing is a strong signal that
 * the narrator is about to write that character in - which is precisely when both the reader
 * and the narrator need to know they already have a card.
 *
 * @param {Array<object>} entries
 */
export function noteActivatedLore(entries) {
    activatedEntries = Array.isArray(entries) ? entries : [];
}

/**
 * Characters whose linked entry fired this turn.
 *
 * Only cards that point at an entry. Anything written by hand in SillyTavern's own editor
 * belongs to nobody here and is left alone.
 *
 * @returns {object[]}
 */
export function charactersFromActivatedLore() {
    if (!activatedEntries.length) return [];
    const characters = getSettings().characters || [];
    return characters.filter(char => char.lorebook && activatedEntries.some(entry =>
        String(entry?.world ?? entry?.book ?? '') === String(char.lorebook.world)
        && String(entry?.uid) === String(char.lorebook.uid)));
}
