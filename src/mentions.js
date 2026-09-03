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
        const pattern = new RegExp(
            `(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`,
            caseInsensitive ? 'ui' : 'u',
        );
        if (pattern.test(body)) found.set(char, true);
    }

    return [...found.keys()];
}
