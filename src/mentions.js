import { getSettings } from './settings.js';
import { getActiveCharacters } from './characters.js';
import { escapeRegExp } from './utils.js';

/**
 * Who a piece of text names.
 *
 * Lived in chat.js, where only the chat could reach it. Fill needs the same question
 * answered - is this character actually in the story, or am I about to describe somebody
 * from a page about somebody else - and character-fill.js cannot import chat.js: chat.js
 * reaches it through status-ui, the cast panel, ui-shared, the HUD, the player modal and
 * ui-manage, and a cycle that only bites when a module is evaluated in the wrong order is
 * the worst kind to leave lying around.
 *
 * The same reasoning that moved the speaker labels and the reprocess handle out. Nothing
 * here touches the DOM or the chat, so it can be imported from anywhere.
 */

/**
 * Whether a piece of text names somebody, as a whole word.
 *
 * The boundaries are the whole point, and they are letter-and-digit rather than \b: \b
 * treats an accented letter as a boundary, so "Kristof" would match inside "Kristofnak"
 * and every Hungarian name would match its own inflections. Extracted so the two other
 * callers cannot drift from it - the thread toucher asks this of a thread's `who`, and the
 * extractor asks it of the latest message.
 *
 * @param {string} text
 * @param {string} name
 * @param {boolean} [caseInsensitive] Defaults to true, which is right for anything a model
 *   wrote. Only the chat decorator has a reason to say otherwise.
 * @returns {boolean}
 */
export function mentionsName(text, name, caseInsensitive = true) {
    const body = String(text || '');
    const needle = String(name || '').trim();
    if (!body || !needle) return false;
    const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{N}_])`,
        caseInsensitive ? 'ui' : 'u',
    );
    return pattern.test(body);
}

/**
 * Characters this text names, whether or not they speak.
 *
 * The decorator's matcher is not reusable here: it requires a trailing colon, because it
 * is looking for speaker lines to put an avatar against. "Joe walks in from the rain"
 * names Joe without him saying anything, and that is exactly the case that matters - the
 * reader needs to know Joe already has a card before it decides he is a new character with
 * nothing to his name.
 *
 * Longest name first, so "The Fae Queen" is not matched as "The Fae". Word boundaries on
 * both sides, so "Ann" does not match inside "Announcement".
 *
 * @param {string} text
 * @param {Array<object>} [characters] Defaults to the ones active in this chat.
 * @returns {object[]} The matched character records, each at most once.
 */
export function charactersMentionedIn(text, characters = null) {
    const body = String(text || '');
    if (!body.trim()) return [];

    const cast = characters || getActiveCharacters();
    const caseInsensitive = getSettings().caseInsensitive;
    const found = new Map();

    const candidates = [];
    for (const char of cast) {
        const names = [
            char.name,
            ...(char.aliases || []).filter(a => !a.isRegex && a.pattern).map(a => a.pattern),
        ].filter(Boolean);
        for (const name of names) candidates.push({ name, char });
    }
    candidates.sort((a, b) => b.name.length - a.name.length);

    for (const { name, char } of candidates) {
        if (found.has(char)) continue;
        if (mentionsName(body, name, caseInsensitive)) found.set(char, true);
    }

    return [...found.keys()];
}
