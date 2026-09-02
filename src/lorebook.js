import { world_names, loadWorldInfo, saveWorldInfo, deleteWorldInfoEntry, METADATA_KEY } from '../../../../world-info.js';
import { getContext } from '../../../../st-context.js';
import { LOG_PREFIX, debugLog } from './constants.js';
import { getSettings, saveSettings } from './settings.js';
import { getActiveCharacters, getChatCast, isCharacterInChat } from './characters.js';

/**
 * SillyTavern declares `export let world_names;` and only assigns it once its own
 * initialisation has run, so it is undefined until then. Every read here goes through
 * this rather than assuming an array.
 */
function knownWorlds() {
    return Array.isArray(world_names) ? world_names : [];
}

/**
 * Updates an existing lorebook entry.
 */
export async function updateLorebookEntry(world, uid, { comment, content }) {
    const data = await loadWorldInfo(world);
    const entry = data?.entries?.[uid];
    if (!entry) throw new Error(`Entry UID ${uid} not found in world "${world}"`);

    if (comment !== undefined) entry.comment = comment;
    if (content !== undefined) entry.content = content;

    await saveWorldInfo(world, data);
    return entry;
}

/**
 * Removes an entry from its lorebook for good.
 *
 * Distinct from ejecting, which only forgets the link and leaves the entry behind. There
 * was no way to do this at all: entries created by the extension accumulated in the world
 * and could only be removed from SillyTavern's own editor.
 *
 * @param {string} world
 * @param {number} uid
 * @returns {Promise<boolean>} False when there was nothing there to delete.
 */
export async function deleteLorebookEntry(world, uid) {
    const data = await loadWorldInfo(world);
    if (!data?.entries) throw new Error(`Could not load lorebook "${world}"`);

    const removed = await deleteWorldInfoEntry(data, uid, { silent: true });
    if (removed === false) return false;

    await saveWorldInfo(world, data);
    debugLog(`Deleted entry ${uid} from "${world}"`);
    return true;
}

/**
 * Returns the lorebook bound to the current chat, if any.
 *
 * The old code read chat?.world_name, but `chat` is SillyTavern's message *array* --
 * it has no world_name. The chat-bound world lives in chat metadata under
 * METADATA_KEY ('world_info'), so that lookup silently always returned undefined and
 * every caller fell through to world_names[0].
 *
 * @returns {string} The world name, or '' when the chat has none.
 */
export function getChatLorebookName() {
    const name = getContext()?.chatMetadata?.[METADATA_KEY];
    return (typeof name === 'string' && knownWorlds().includes(name)) ? name : '';
}

/** Every name this character answers to: their own, plus their aliases. */
function namesFor(char) {
    const names = [String(char.name ?? '').trim()].filter(Boolean);
    for (const alias of char.aliases || []) {
        // A regex alias is a matching rule, not a name an entry could be titled with.
        if (!alias?.pattern || alias.isRegex) continue;
        names.push(String(alias.pattern).trim());
    }
    return names;
}

/** Does this entry belong to this character? Title first, then its own keywords. */
function entryMatches(entry, names) {
    const wanted = new Set(names.map(n => n.toLowerCase()));

    const title = String(entry.comment ?? '').trim().toLowerCase();
    if (title && wanted.has(title)) return 'title';

    for (const key of entry.key || []) {
        if (wanted.has(String(key).trim().toLowerCase())) return 'keyword';
    }
    return null;
}

/**
 * Links the character to a matching lorebook entry, if one exists.
 *
 * Matching used to be the entry title against the character's name, exactly - so an
 * entry titled "Instructor Kovács" never matched the card "Mr. Kovács", although the
 * extension has had an alias system throughout. Aliases count now, and so do the entry's
 * own keywords, which is where a name usually ends up.
 *
 * @param {object} char
 * @param {{ silent?: boolean }} [options] silent suppresses the toast, for bulk syncing.
 * @returns {Promise<boolean>} Whether a link was made.
 */
export async function tryAutoSyncLorebook(char, { silent = false } = {}) {
    if (!char.name) return false;

    // Worlds to scan: user selection -> current chat world -> first world name in list.
    let worlds = getSettings().scanLorebooks || [];
    if (worlds.length === 0) {
        const chatWorld = getChatLorebookName();
        if (chatWorld) worlds = [chatWorld];
        else if (knownWorlds().length > 0) worlds = [knownWorlds()[0]];
    }

    if (worlds.length === 0) return false;

    const names = namesFor(char);
    if (!names.length) return false;

    for (const worldName of worlds) {
        try {
            const data = await loadWorldInfo(worldName);
            const entries = Object.values(data?.entries ?? {});

            // Title beats keyword: an entry named for the character is a better match
            // than one that merely mentions them.
            const byTitle = entries.find(e => entryMatches(e, names) === 'title');
            const match = byTitle || entries.find(e => entryMatches(e, names) === 'keyword');

            if (match) {
                char.lorebook = { world: worldName, uid: match.uid };
                saveSettings();
                if (!silent) {
                    toastr.info(`Auto-linked Lorebook entry: "${match.comment || match.uid}" from "${worldName}"`, 'SillyNPC');
                }
                return true;
            }
        } catch (err) {
            console.error(LOG_PREFIX, `Auto-sync lorebook failed for ${worldName}`, err);
        }
    }
    return false;
}

/**
 * Turns the lore entries this extension owns on or off to match the chat's cast.
 *
 * Filtering stops SillyNPC injecting an out-of-chat character, but it cannot stop
 * SillyTavern firing their entry on its own when a keyword happens to match. Only entries
 * a character card actually points at are touched - anything you wrote by hand is left
 * exactly as you set it, including its own disable state.
 *
 * Each world is loaded once and written only if something changed, because this runs on
 * every chat switch and a world file is not small.
 *
 * @returns {Promise<number>} How many entries were flipped.
 */
export async function syncLorebookScope() {
    const characters = (getSettings().characters || []).filter(c => c.lorebook?.world);
    if (!characters.length) return 0;

    const byWorld = new Map();
    for (const char of characters) {
        if (!byWorld.has(char.lorebook.world)) byWorld.set(char.lorebook.world, []);
        byWorld.get(char.lorebook.world).push(char);
    }

    const cast = getChatCast();
    let flipped = 0;

    for (const [worldName, members] of byWorld) {
        let data;
        try { data = await loadWorldInfo(worldName); } catch { continue; }
        if (!data?.entries) continue;

        let changed = false;
        for (const char of members) {
            const entry = data.entries[char.lorebook.uid];
            if (!entry) continue;                      // deleted in SillyTavern's editor
            const shouldBeOff = !isCharacterInChat(char, cast);
            if (!!entry.disable === shouldBeOff) continue;
            entry.disable = shouldBeOff;
            changed = true;
            flipped++;
        }
        if (changed) await saveWorldInfo(worldName, data);
    }

    if (flipped) debugLog(`Lore entries switched for this chat: ${flipped}`);
    return flipped;
}

/**
 * Runs the sync for every character that has no lorebook yet.
 *
 * Auto-sync only ever ran when a character was created from a detected speaker, so
 * characters made any other way, or made before their entry existed, stayed unlinked
 * with no way to fix it but opening each one.
 *
 * @returns {Promise<{ linked: number, checked: number }>}
 */
export async function syncAllLorebooks() {
    // Only the characters this chat is for: linking lore for somebody who belongs to
    // another story is work nobody asked for, and injects them into a scene they are
    // not in.
    const characters = getActiveCharacters();
    const candidates = characters.filter(c => c.name && !c.lorebook);

    let linked = 0;
    for (const char of candidates) {
        if (await tryAutoSyncLorebook(char, { silent: true })) linked++;
    }

    if (linked) saveSettings();
    return { linked, checked: candidates.length };
}
