/**
 * Where one character's pictures live, and what is in there.
 *
 * Every picture for a character used to land in one flat folder shared by everybody, named
 * after them - `Varga_Elza_1787665547660.png` - which is unmanageable at the forty images
 * a generator produces in an afternoon, and lossy besides: the prefix is sanitised with
 * `\w`, so an accented cast ends up on disk as `Moln_r_Krist_f_` and `Agent_K_roly_`.
 *
 * A folder per character fixes both. `sanitize-filename` keeps spaces and accents, so the
 * folder is `user/images/Varga Elza/` and the filename is free to say what the picture is
 * *for* rather than who it belongs to.
 *
 * **One level, and that is SillyTavern's limit rather than a choice.** Both
 * `/api/images/upload` and `/api/images/list` put the folder through `sanitize-filename`,
 * which deletes slashes - `sillynpc/Elza` arrives as `sillynpcElza` - so a character folder
 * cannot sit inside the configured image folder and cannot hold a subfolder of its own.
 * Only `/api/sprites/get` splits on `/` before sanitising, and that one is rooted in the
 * character-card directory rather than here.
 *
 * Imports settings and nothing else, so it runs in the Node harness.
 */

import { getRequestHeaders } from '../../../../../script.js';
import { debugLog } from './constants.js';
import { getSettings, saveSettings } from './settings.js';

/**
 * A character name, as the folder the server will actually create.
 *
 * This has to agree with `sanitize-filename` **exactly**, because the two never meet: this
 * side asks for a folder by name and the server creates one by name, and a rule that
 * differs by a single character produces a listing of an empty folder rather than an
 * error. So it is copied from that package rather than reasoned out - the first attempt
 * was reasoned out and disagreed on three cases out of twelve, each of which would have
 * been a character whose pictures silently went missing.
 *
 * A check runs both against the real package and asserts they agree.
 */
const ILLEGAL = /[/?<>\\:*|"]/g;
const CONTROL = /[\x00-\x1f\x80-\x9f]/g;
/** "." and ".." mean something to a filesystem, so a name of nothing but dots is dropped. */
const DOTS_ONLY = /^\.+$/;
/** CON, PRN, NUL and friends cannot be filenames on Windows, with or without a suffix. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** Windows silently drops a trailing dot or space, so a folder ending in one is unfindable. */
const WINDOWS_TRAILING = /[\. ]+$/;

/** Bytes, not characters: the cap is a filesystem limit and accents cost two apiece. */
function truncateUtf8(text, max) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length <= max) return text;
    // Cut on a character boundary, never mid-sequence.
    return new TextDecoder('utf-8', { fatal: false })
        .decode(bytes.slice(0, max)).replace(/\uFFFD+$/, '');
}

/**
 * A character's name as a folder, or '' when nothing usable is left of it.
 *
 * @param {string} name
 * @returns {string}
 */
export function folderNameFor(name) {
    if (typeof name !== 'string') return '';
    const clean = name
        .replace(ILLEGAL, '')
        .replace(CONTROL, '')
        .replace(DOTS_ONLY, '')
        .replace(WINDOWS_RESERVED, '')
        .replace(WINDOWS_TRAILING, '');
    return truncateUtf8(clean, 255);
}

/**
 * The folder this character's pictures live in.
 *
 * **Stored on the card, not derived from the name.** SillyTavern has no rename or move
 * endpoint, so a folder derived from the name would orphan itself silently the moment a
 * character was renamed: new pictures would go somewhere new and the old ones would still
 * be on disk under a name nothing asks about any more. So the name seeds it once and is
 * never consulted again.
 *
 * Two characters given the same name share a folder. Said here rather than guarded
 * against: they are the same name, the pictures are in one place, and anything cleverer
 * would put an id in a folder name nobody could point a generator at.
 *
 * @param {object} char
 * @returns {string} '' when the character has no usable name at all.
 */
export function folderFor(char) {
    if (!char) return '';
    const stored = folderNameFor(char.imageFolder);
    if (stored) return stored;
    return folderNameFor(char.name);
}

/**
 * Fixes a character's folder so it stops depending on their name.
 *
 * Called before anything is written for them. Separate from `folderFor` because reading
 * where the pictures are must not have the side effect of deciding where they will be -
 * that decision belongs to the first write, and a getter that saves settings would make
 * merely drawing the character page dirty the file.
 *
 * @param {object} char
 * @returns {string} The folder, now stored.
 */
export function claimFolder(char) {
    if (!char) return '';
    const stored = folderNameFor(char.imageFolder);
    if (stored) return stored;

    const folder = folderNameFor(char.name);
    if (!folder) return '';

    char.imageFolder = folder;
    saveSettings();
    return folder;
}

/** The URL a file in a character's folder is served at. */
export function imagePathFor(char, file) {
    const folder = folderFor(char);
    if (!folder || !file) return '';
    return `/user/images/${folder}/${file}`;
}

/**
 * What is actually in a character's folder, newest naming rules and all.
 *
 * The listing rather than a stored list, which is what makes dropping files in from a
 * generator work: the folder is the record, so a file added outside appears and a file
 * deleted outside stops appearing. `char.images` becomes a cache of this rather than the
 * truth about it.
 *
 * Sorted by **name**, not date. Name order is what somebody looking at the folder sees, and
 * it is what decides between two pictures that carry the same tag - an order the reader can
 * predict is worth more here than the order things happened to be written in.
 *
 * `/api/images/list` creates the folder when it is missing, which is deliberate rather than
 * merely tolerated: looking at a character's page is what brings their folder into being, so
 * there is somewhere to drop files before there is anything to drop.
 *
 * @param {object} char
 * @returns {Promise<string[]>} Paths, ready to use as an `img` src.
 */
export async function listCharacterImages(char) {
    const folder = folderFor(char);
    if (!folder) return [];

    try {
        const response = await fetch('/api/images/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ folder, sortField: 'name', sortOrder: 'asc' }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const files = await response.json();
        if (!Array.isArray(files)) return [];
        return files.map(file => `/user/images/${folder}/${file}`);
    } catch (err) {
        debugLog(`Could not read user/images/${folder}`, err);
        return [];
    }
}

/**
 * Brings `char.images` into line with what is on disk, and says whether anything moved.
 *
 * The cache is kept rather than dropped because a great deal reads it synchronously - the
 * portrait carousel, the gallery, the orphan scan - and making every one of those wait on a
 * network call to draw a row would be a far larger change than this one.
 *
 * `imageUrl` is repaired only when the file it names has gone. A picture chosen as *the*
 * portrait is a decision, and a decision survives a refresh that finds new neighbours.
 *
 * @param {object} char
 * @returns {Promise<{ changed: boolean, images: string[] }>}
 */
export async function refreshCharacterImages(char) {
    if (!char) return { changed: false, images: [] };

    const found = await listCharacterImages(char);
    const before = Array.isArray(char.images) ? char.images : [];

    const same = before.length === found.length && before.every((p, i) => p === found[i]);
    if (same) return { changed: false, images: found };

    char.images = found;
    if (char.imageUrl && !found.includes(char.imageUrl)) {
        char.imageUrl = found[0] || '';
    }
    saveSettings();
    return { changed: true, images: found };
}

/**
 * Where a picture that belongs to nobody goes.
 *
 * The fallback portrait pool has no character, so it keeps the configured route - which is
 * what that setting now means: the home for pictures with no card of their own, rather than
 * the home for everything.
 *
 * @returns {string}
 */
export function sharedFolder() {
    return String(getSettings().imageSaveRoute || 'sillynpc');
}
