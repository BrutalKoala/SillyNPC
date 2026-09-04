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
export function namesFor(char) {
    const names = [String(char.name ?? '').trim()].filter(Boolean);
    for (const alias of char.aliases || []) {
        // A regex alias is a matching rule, not a name an entry could be titled with.
        if (!alias?.pattern || alias.isRegex) continue;
        names.push(String(alias.pattern).trim());
    }
    return names;
}

/**
 * Adds generated keywords to the ones an entry already has.
 *
 * Replacing them was quietly destructive in two ways. Keywords curated by hand in
 * SillyTavern were thrown away on every regeneration - and when the model omitted its
 * "Tags:" line the result was an empty list, which on an entry that is not `constant`
 * means it is never injected again. The entry still looks right in the editor and simply
 * stops working.
 *
 * Lived in api.js until syncEntryIdentity needed it. api.js imports this file now, so it
 * had to move rather than be imported back the other way.
 *
 * @param {string[]|string|undefined} existing
 * @param {string} generated Comma-separated.
 * @returns {string[]}
 */
export function mergeKeywords(existing, generated) {
    const start = Array.isArray(existing) ? existing : (existing ? [existing] : []);
    const merged = start.map(k => String(k).trim()).filter(Boolean);
    const seen = new Set(merged.map(k => k.toLowerCase()));

    for (const raw of String(generated ?? '').split(',')) {
        const keyword = raw.trim();
        if (!keyword) continue;
        const key = keyword.toLowerCase();
        if (seen.has(key)) continue;      // "Knight" and "knight" are one keyword
        seen.add(key);
        merged.push(keyword);
    }

    return merged;
}

/**
 * The line that says whose entry this is.
 *
 * SillyTavern sends an entry's `content` and nothing else - the title is editor furniture
 * and the keywords only decide whether it fires - so an entry that does not name its own
 * subject reaches the model anonymous. Several of them, joined with a bare newline and no
 * separator, arrive as one run-on wall in which "She actively monitors the player" belongs
 * to nobody in particular.
 *
 * A heading rather than a bare name, because it has to break this entry from the one
 * before it as well as name it. Aliases in the parenthetical because nothing else in the
 * prompt carries them: the tracker collapses a nickname to the canonical name before it
 * records anything, so without this the model has no way to tell that the "Niki" in the
 * prose is the "Nikolett" in the lore.
 */
export function identityHeader(char) {
    const [name, ...aliases] = namesFor(char);
    if (!name) return '';
    return aliases.length ? `### ${name} (also: ${aliases.join(', ')})` : `### ${name}`;
}

/** Matches a heading on the FIRST line only, so a "###" inside the body survives. */
const HEADER_LINE = /^###[^\n]*\n?/;

/** The entry body with any heading this has written before removed. */
export function stripIdentityHeader(content) {
    return String(content ?? '').replace(HEADER_LINE, '');
}

/**
 * Writes a character's identity onto their entry: title, keywords and heading.
 *
 * All three drifted independently before this. The heading was never written at all; the
 * keywords were the name as it stood the day the entry was created, so configured aliases
 * never became triggers; and renaming a character changed neither, which meant the entry
 * silently stopped firing because the only name it answered to was the old one.
 *
 * Keywords merge rather than replace, so a rename leaves the old name behind as a trigger.
 * That is deliberate: the chat above still says it.
 *
 * Does not save. The caller owns the write, so a pass over many entries costs one.
 *
 * @returns {boolean} Whether anything changed - false lets a bulk pass skip the write
 *   entirely rather than rewriting a lorebook file on every chat switch.
 */
export function syncEntryIdentity(char, entry) {
    const names = namesFor(char);
    if (!entry || !names.length) return false;

    const before = { comment: entry.comment, key: entry.key, content: entry.content };

    entry.comment = names[0];
    entry.key = mergeKeywords(entry.key, names.join(','));

    // An empty entry is left empty: a heading with nothing under it is worse than nothing,
    // and createLoreEntry makes the entry before there is anything to put in it.
    const body = stripIdentityHeader(entry.content);
    entry.content = body.trim() ? `${identityHeader(char)}\n${body}` : body;

    return before.comment !== entry.comment
        || before.content !== entry.content
        || String(before.key) !== String(entry.key);
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

/**
 * Puts a character's current name onto their entry, if they have one.
 *
 * Called when the name field is done being edited. Silent and harmless when the character
 * has no entry, which is the common case.
 *
 * @returns {Promise<boolean>} Whether anything was written.
 */
export async function renameLorebookEntry(char) {
    const world = char?.lorebook?.world;
    if (!world || !char.name) return false;

    const data = await loadWorldInfo(world);
    const entry = data?.entries?.[char.lorebook.uid];
    if (!entry) return false;

    if (!syncEntryIdentity(char, entry)) return false;
    await saveWorldInfo(world, data);
    debugLog(`Lorebook entry now filed under "${char.name}"`);
    return true;
}

/**
 * Brings already-linked entries up to date with the characters they belong to.
 *
 * Entries written before syncEntryIdentity existed carry no heading, and their keywords are
 * the name as it stood the day they were created. Regenerating each one by hand to fix that
 * is work nobody should have to do, so it is done once on load.
 *
 * Writes only when something actually differs. syncEntryIdentity says so, and without that
 * this would rewrite every lorebook file on every chat switch - which is somebody's data,
 * possibly under version control, and a diff they never asked for.
 *
 * One save per world, not per entry.
 *
 * @returns {Promise<{ updated: number, checked: number }>}
 */
export async function repairEntryIdentities() {
    const linked = getActiveCharacters().filter(c => c.name && c.lorebook?.world);

    const byWorld = new Map();
    for (const char of linked) {
        if (!byWorld.has(char.lorebook.world)) byWorld.set(char.lorebook.world, []);
        byWorld.get(char.lorebook.world).push(char);
    }

    let updated = 0;
    for (const [world, chars] of byWorld) {
        let worldData;
        try {
            worldData = await loadWorldInfo(world);
        } catch (err) {
            debugLog(`Could not open "${world}" to check its entries`, err);
            continue;
        }
        if (!worldData?.entries) continue;

        let dirty = false;
        for (const char of chars) {
            const entry = worldData.entries[char.lorebook.uid];
            // A missing entry is left to tryAutoSyncLorebook rather than repaired into
            // existence: the user may have deleted it on purpose.
            if (entry && syncEntryIdentity(char, entry)) {
                dirty = true;
                updated += 1;
            }
        }

        if (dirty) await saveWorldInfo(world, worldData);
    }

    if (updated) debugLog(`Named ${updated} lorebook entr(ies) after their characters`);
    return { updated, checked: linked.length };
}
