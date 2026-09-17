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

/** SillyTavern's media type flags for /api/images/list: pictures and videos. */
const IMAGES_AND_VIDEOS = 0b011;

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
 * Pictures only unless asked. A character's gallery is drawn with `img`, where a video
 * would be a broken frame; a location's background can be a video, so it asks for both.
 *
 * @param {object} char
 * @param {{ videos?: boolean }} [options]
 * @returns {Promise<string[]>} Paths, ready to use as an `img` (or `video`) src.
 */
export async function listCharacterImages(char, { videos = false } = {}) {
    const folder = folderFor(char);
    if (!folder) return [];

    try {
        const response = await fetch('/api/images/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ folder, type: videos ? IMAGES_AND_VIDEOS : 0b001, sortField: 'name', sortOrder: 'asc' }),
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
 * @param {{ videos?: boolean }} [options] See listCharacterImages.
 * @returns {Promise<{ changed: boolean, images: string[] }>}
 */
export async function refreshCharacterImages(char, options = {}) {
    if (!char) return { changed: false, images: [] };

    const found = await listCharacterImages(char, options);
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

/* ─── Moving what is already on disk ──────────────────────────────────────── */

/**
 * Every path that belongs to something other than a character.
 *
 * The fallback portrait pool and the personas share the flat folder, and a file can be in
 * two places at once - a character's gallery and the pool both pointing at one picture.
 * Moving such a file would fix one and break the other, so it is left exactly where it is
 * and the character keeps pointing at it there.
 *
 * Personas are left alone wholesale: a persona record has no name to make a folder from,
 * and the player has one avatar rather than forty.
 *
 * @returns {Set<string>}
 */
function pathsSpokenForElsewhere() {
    const settings = getSettings();
    const held = new Set();

    for (const entry of settings.defaultImages || []) {
        if (entry?.src) held.add(entry.src);
    }
    for (const persona of Object.values(settings.personaData || {})) {
        if (persona?.imageUrl) held.add(persona.imageUrl);
        for (const path of persona?.images || []) held.add(path);
    }
    return held;
}

/** A file already on disk, as the base64 the upload endpoint wants. */
async function readAsBase64(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const blob = await response.blob();
    const dataUri = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
        reader.readAsDataURL(blob);
    });

    const comma = dataUri.indexOf(',');
    if (comma < 0) throw new Error('not a data URI');
    return dataUri.slice(comma + 1);
}

/**
 * Whether a file is really there and really a picture or a video, before the original is
 * deleted. Video because a location's background can be one, and moving a folder moves
 * everything in it.
 */
async function copyLanded(path) {
    try {
        const response = await fetch(path, { cache: 'no-store' });
        if (!response.ok) return false;
        const blob = await response.blob();
        const type = String(blob.type || '');
        return blob.size > 0 && (type.startsWith('image/') || type.startsWith('video/'));
    } catch {
        return false;
    }
}


/** The file names in a folder, pictures and videos both. */
async function listFolder(folder) {
    const response = await fetch('/api/images/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ folder, type: IMAGES_AND_VIDEOS, sortField: 'name', sortOrder: 'asc' }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} listing ${folder}`);
    const files = await response.json();
    return Array.isArray(files) ? files : [];
}

/**
 * Moves everything in a card's folder to the folder for a new name, and re-points the card.
 *
 * SillyTavern has no move or rename for folders, so this is the migration's own sequence
 * file by file: **copy, confirm the copy reads back, re-point, then delete the original.**
 * An interruption never leaves a card pointing at a file that is not there. The old folder
 * itself stays behind, empty - SillyTavern cannot delete a folder.
 *
 * It refuses, and changes nothing, when moving would take somebody else's pictures or
 * pour these into somebody else's:
 * - another card uses the old folder too (two characters that once shared a name);
 * - another card already uses the new folder;
 * - the new folder already has files in it.
 *
 * Works on anything shaped like a card - `imageFolder`, `images`, `imageUrl`, `imageTags` -
 * so a location moves the same way a character does.
 *
 * @param {object} owner
 * @param {string} name The name the folder should now follow.
 * @param {object} [options]
 * @param {string} [options.from] The folder before the rename, when the card's name has
 *   already changed and it never stored one - otherwise it would be read from the new name.
 * @param {string} [options.prefix] Put before the name, as locations do.
 * @param {object[]} [options.others] Every other card with a folder. Characters by default.
 * @param {() => void} [options.save] Saves whatever the owner lives in.
 * @returns {Promise<{ folder: string, moved: number, left: string[], refused: string }>}
 */
export async function moveFolder(owner, name, options = {}) {
    const save = options.save ?? saveSettings;
    const target = folderNameFor(`${options.prefix ?? ''}${name ?? ''}`);
    const from = folderNameFor(options.from) || folderFor(owner);
    const result = { folder: from, moved: 0, left: [], refused: '' };
    if (!owner || !target) return { ...result, refused: 'no usable name' };

    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    // Windows folder names ignore case, so "elza" and "Elza" are already the same folder.
    if (!from || same(from, target)) {
        owner.imageFolder = target;
        save();
        return { ...result, folder: target };
    }

    const others = (options.others ?? getSettings().characters ?? []).filter(o => o && o !== owner);
    if (others.some(o => same(folderFor(o), from))) {
        return { ...result, refused: `"${from}" is also used by someone else, so it stays where it is` };
    }
    if (others.some(o => same(folderFor(o), target))) {
        return { ...result, refused: `"${target}" already belongs to someone else` };
    }
    if ((await listFolder(target)).length > 0) {
        return { ...result, refused: `"${target}" already has files in it` };
    }

    const files = await listFolder(from);
    for (const file of files) {
        try {
            if (await moveOne(owner, `/user/images/${from}/${file}`, target)) result.moved++;
        } catch (err) {
            debugLog(`Could not move ${file} to ${target}`, err);
            result.left.push(file);
        }
    }

    /* The new folder from here on, even if a file stayed behind: the name has changed, and
       new pictures belong under it. What was left is reported, so it can be moved by hand. */
    owner.imageFolder = target;
    save();
    return { ...result, folder: target };
}

/**
 * Moves one picture into its character's folder, and re-points everything that named it.
 *
 * **Copy, confirm, re-point, and only then delete.** In that order, and the order is the
 * whole safety of this: an interruption at any point leaves a picture that exists in at
 * least one place and a card that points at one that exists. The worst outcome is a file
 * left behind in the old folder, which costs disk and nothing else.
 *
 * @returns {Promise<string>} The new path, or '' when nothing moved.
 */
async function moveOne(char, oldPath, folder) {
    const file = oldPath.split('/').pop();
    if (!file) return '';

    const dot = file.lastIndexOf('.');
    const stem = dot > 0 ? file.slice(0, dot) : file;
    const format = dot > 0 ? file.slice(dot + 1).toLowerCase() : 'png';

    const base64 = await readAsBase64(oldPath);

    /* The endpoint directly rather than SillyTavern's saveBase64AsFile wrapper.
     *
     * That wrapper rewrites dots in the name into underscores, which is right for a name
     * it is about to append an extension to and wrong for one that already survived a
     * rename by hand - and a picture called `wounded.rain.png` is exactly the shape this
     * whole feature encourages. Moving a file must not quietly rename it. */
    const upload = await fetch('/api/images/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ image: base64, format, ch_name: folder, filename: stem }),
    });
    if (!upload.ok) throw new Error(`HTTP ${upload.status} writing ${file}`);
    const newPath = (await upload.json())?.path;

    if (!newPath || !(await copyLanded(newPath))) {
        throw new Error(`the copy of ${file} could not be read back`);
    }

    // Every record that named the old path, including the tag map keyed by it.
    char.images = (char.images || []).map(p => (p === oldPath ? newPath : p));
    if (char.imageUrl === oldPath) char.imageUrl = newPath;
    if (char.imageTags?.[oldPath]) {
        char.imageTags[newPath] = char.imageTags[oldPath];
        delete char.imageTags[oldPath];
    }

    try {
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: oldPath.replace(/^\//, '') }),
        });
    } catch (err) {
        // The move succeeded; the tidying did not. Nothing points at the old file now.
        debugLog(`Could not remove ${oldPath} after copying it`, err);
    }

    return newPath;
}

/**
 * Puts every character's pictures into their own folder, once.
 *
 * Runs on load rather than behind a button, which was asked for with the risk stated. What
 * makes that survivable is that it is **resumable and never destructive in the wrong
 * order**: each picture is copied, read back, re-pointed and only then deleted, and the
 * settings are saved after each character. A failure stops the pass with everything before
 * it done and everything after it untouched, and the next load carries on. Nothing is ever
 * in a state where a card points at a file that is not there.
 *
 * Filenames are kept exactly as they are. Tidier names would be nice and are one more
 * thing to go wrong in a pass that is already moving every picture in the library; the
 * point of the folders is that a *new* name can now say what a picture is for.
 *
 * @returns {Promise<{ moved: number, characters: number, failed: string }>}
 */
export async function migrateImagesToFolders() {
    const settings = getSettings();
    if (settings.imagesFoldered) return { moved: 0, characters: 0, failed: '' };

    const from = `/user/images/${sharedFolder()}/`;
    const held = pathsSpokenForElsewhere();
    let moved = 0;
    let characters = 0;
    let failed = '';

    for (const char of settings.characters || []) {
        const mine = (char.images || []).filter(p => p.startsWith(from) && !held.has(p));
        if (mine.length === 0) continue;

        const folder = claimFolder(char);
        if (!folder) continue;

        let any = false;
        try {
            for (const oldPath of mine) {
                if (await moveOne(char, oldPath, folder)) { moved++; any = true; }
            }
        } catch (err) {
            failed = `${char.name}: ${err?.message ?? err}`;
            debugLog('Stopped moving pictures into folders', err);
        }

        if (any) { characters++; saveSettings(); }
        // Stop the whole pass, so a server that has started refusing is not hammered
        // nineteen more times. The next load resumes from where this one stopped.
        if (failed) return { moved, characters, failed };
    }

    /* Only once everything got through. Set on a partial pass, the pictures left behind
       would never be looked at again. */
    settings.imagesFoldered = true;
    saveSettings();
    return { moved, characters, failed };
}
