import { getSettings, saveSettings } from './settings.js';
import { makeId } from './utils.js';
import { SPEAKER_PALETTE, paletteColorFor, blankProfile } from './constants.js';
import { getContext } from '../../../../st-context.js';

/**
 * A colour no other card is already using.
 *
 * Cards used to be created with no colour at all, and nothing ever filled one in, so a
 * character only had an accent if you set it by hand - which is why some speakers were
 * coloured and others were not.
 *
 * @param {string} [seed] The character's name, so the same name lands on the same colour.
 * @returns {string} A hex colour.
 */
export function pickCharacterColor(seed = '') {
    const taken = new Set(
        (getSettings().characters || [])
            .map(c => String(c.color || '').trim().toLowerCase())
            .filter(Boolean),
    );

    // Start from the name so a card keeps its colour across a delete and re-create, then
    // walk the palette for the first shade nobody else has.
    const start = SPEAKER_PALETTE.indexOf(paletteColorFor(seed));


    for (let i = 0; i < SPEAKER_PALETTE.length; i++) {
        const candidate = SPEAKER_PALETTE[(start + i) % SPEAKER_PALETTE.length];
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    // More cards than colours: reuse rather than leave one blank.
    return SPEAKER_PALETTE[start];
}

/**
 * @param {string} [name] Used to seed the accent colour; the caller may still rename.
 */
export function createCharacter(name = '') {
    const char = {
        id: makeId(),
        name: String(name || ''),
        imageUrl: '',
        /**
         * Every portrait kept for this character, oldest first; imageUrl names whichever
         * is in use. Held here rather than found by filename on disk: the name field
         * saves on every keystroke, so anything keyed to the character's name would have
         * to be rebuilt six times while "Vesper" is typed.
         */
        images: [],
        color: pickCharacterColor(name),
        category: '',
        imageFit: '',
        aliases: [],
        lorebook: null,
        statusOverrides: {},
        /** Who they are, as opposed to what is happening to them. See PROFILE_FIELDS. */
        profile: blankProfile(),
    };
    getSettings().characters.push(char);
    saveSettings();
    return char;
}

export function deleteCategory(category) {
    if (!category) return;
    const settings = getSettings();
    // The register too, or an emptied category would come straight back the next time
    // the panel drew - and one with no members would be undeletable.
    settings.categories = settings.categories.filter(c => c !== category);
    for (const char of settings.characters) {
        if (char.category === category) char.category = '';
    }
    saveSettings();
}

/**
 * Adds a category with nobody in it yet.
 *
 * @param {string} name
 * @returns {boolean} False if the name is blank or already taken.
 */
export function createCategory(name) {
    const clean = String(name ?? '').trim();
    if (!clean) return false;
    const settings = getSettings();
    if (settings.categories.includes(clean)) return false;
    settings.categories.push(clean);
    saveSettings();
    return true;
}

/**
 * Renames a category, taking its members and its scoping with it.
 *
 * Renaming onto a name already in use merges the two - the caller is expected to have
 * said so, because renaming back does not separate them again.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean} False if there was nothing to do.
 */
export function renameCategory(from, to) {
    const clean = String(to ?? '').trim();
    if (!from || !clean || from === clean) return false;

    const settings = getSettings();
    const at = settings.categories.indexOf(from);
    if (settings.categories.includes(clean)) {
        // Merging: the surviving entry keeps its own place in the order.
        if (at >= 0) settings.categories.splice(at, 1);
    } else if (at >= 0) {
        settings.categories[at] = clean;
    } else {
        settings.categories.push(clean);
    }

    for (const char of settings.characters) {
        if (char.category === from) char.category = clean;
    }

    // Every chat but the open one keeps the old name in its own file, so the map is what
    // makes those resolve. Anything already pointing at `from` is moved on with it, which
    // is what keeps this one hop deep instead of a chain to walk.
    for (const [was, now] of Object.entries(settings.categoryRenames)) {
        if (now === from) settings.categoryRenames[was] = clean;
    }
    settings.categoryRenames[from] = clean;
    // A name that has come back around to itself is not a rename.
    if (settings.categoryRenames[clean] === clean) delete settings.categoryRenames[clean];

    saveSettings();

    // The open chat can be written to, so it is - the map is the fallback for the rest.
    const cast = getChatCast();
    if (cast.categories !== null && cast.categories.includes(from)) {
        setChatCast({
            categories: [...new Set(cast.categories.map(c => (c === from ? clean : c)))],
            include: cast.include,
            exclude: cast.exclude,
        });
    }
    return true;
}

/**
 * Moves a category to sit where another one currently does.
 *
 * @param {string} moving
 * @param {string} target
 * @returns {boolean} False if either is unknown or they are the same.
 */
export function moveCategory(moving, target) {
    if (!moving || !target || moving === target) return false;
    const settings = getSettings();
    const from = settings.categories.indexOf(moving);
    const to = settings.categories.indexOf(target);
    if (from < 0 || to < 0) return false;

    settings.categories.splice(from, 1);
    settings.categories.splice(settings.categories.indexOf(target) + (from < to ? 1 : 0), 0, moving);
    saveSettings();
    return true;
}

/**
 * Every category, in the order they are shown.
 *
 * The register first, then any name a character carries that is missing from it. That
 * second half is not redundant: it is what stops a category disappearing if the two ever
 * fall out of step, which is the failure the register was introduced to end.
 */
export function getAllCategories() {
    const settings = getSettings();
    const register = (settings.categories || []).filter(Boolean);
    const known = new Set(register);
    const strays = [...new Set((settings.characters || [])
        .map(c => c.category)
        .filter(name => name && !known.has(name)))].sort();
    return [...register, ...strays];
}

/**
 * What a category recorded in a chat is called now.
 *
 * @param {string} name
 * @returns {string}
 */
export function resolveCategoryName(name) {
    const renames = getSettings().categoryRenames || {};
    return Object.prototype.hasOwnProperty.call(renames, name) ? renames[name] : name;
}

/** Where a chat records which of the system's characters belong in it. */
export const CAST_KEY = 'sillynpc_cast';

/** The category value an uncategorised character carries, so it can be named like any other. */
export const UNCATEGORISED = '';

/**
 * Which characters this chat is for.
 *
 * `categories: null` means all of them, which is what every chat written before this
 * reads as - so nothing needs configuring to keep working, and scoping is something you
 * opt a chat into when you start a new story rather than a chore imposed on old ones.
 *
 * @returns {{ categories: string[]|null, include: string[], exclude: string[] }}
 */
export function getChatCast() {
    const raw = getContext()?.chatMetadata?.[CAST_KEY];
    if (!raw || typeof raw !== 'object') return { categories: null, include: [], exclude: [] };
    return {
        categories: Array.isArray(raw.categories) ? raw.categories : null,
        include: Array.isArray(raw.include) ? raw.include : [],
        exclude: Array.isArray(raw.exclude) ? raw.exclude : [],
    };
}

/** Stored on the chat, so it travels with the chat file and dies with it. */
export function setChatCast(cast) {
    const context = getContext();
    const metadata = context?.chatMetadata;
    if (!metadata) return false;
    metadata[CAST_KEY] = {
        categories: Array.isArray(cast?.categories) ? [...cast.categories] : null,
        include: [...new Set(cast?.include || [])],
        exclude: [...new Set(cast?.exclude || [])],
    };
    context?.saveMetadataDebounced?.();
    return true;
}

/**
 * Whether a character belongs in the open chat.
 *
 * A decision about the individual outranks the one about their category, in both
 * directions: a category can be in the chat with one of its members kept out, or out of
 * it with one member let in.
 */
export function isCharacterInChat(char, cast = getChatCast()) {
    if (!char) return false;
    if (cast.exclude.includes(char.id)) return false;
    if (cast.include.includes(char.id)) return true;
    if (cast.categories === null) return true;
    // Through the rename map, because this chat's file may still name a category by what
    // it was called when the chat was set up - only the open one gets rewritten.
    const wanted = char.category || UNCATEGORISED;
    return cast.categories.some(name => resolveCategoryName(name) === wanted);
}

/**
 * The characters that exist as far as this chat is concerned.
 *
 * Everything that decorates a message, populates the scene cast or injects lore reads
 * this rather than the full list, which is how a new story stops inheriting the last
 * one's twenty-five people. The manage grid deliberately does not - you have to be able
 * to see somebody in order to put them back.
 */
export function getActiveCharacters() {
    const cast = getChatCast();
    return (getSettings().characters || []).filter(c => isCharacterInChat(c, cast));
}

/** Puts one character in this chat regardless of category. */
export function addCharacterToChat(id) {
    if (!id) return false;
    const cast = getChatCast();
    if (cast.categories === null && !cast.exclude.includes(id)) return false;  // already in
    return setChatCast({
        categories: cast.categories,
        include: [...cast.include, id],
        exclude: cast.exclude.filter(x => x !== id),
    });
}

export function deleteCharacter(id) {
    const characters = getSettings().characters;
    const i = characters.findIndex(c => c.id === id);
    if (i === -1) return;
    characters.splice(i, 1);
    saveSettings();
}

export function findCharacter(id) {
    return getSettings().characters.find(c => c.id === id) ?? null;
}

/**
 * Records another name for a character.
 *
 * The narrator introducing "Varga Elza" for a character carded as "Elza" is the ordinary
 * case, not an exception - a full name at a formal moment, a title in front of it - and
 * the only way to connect the two used to be opening the card and typing the alias in.
 *
 * Matching happens on the plain pattern, so an alias that only differs by case is already
 * covered by Lenient Name Matching and is not worth a second entry.
 *
 * @param {string} id
 * @param {string} pattern The name as the story writes it.
 * @returns {boolean} False when there was nothing to add.
 */
export function addAlias(id, pattern) {
    const char = findCharacter(id);
    const name = String(pattern ?? '').trim();
    if (!char || !name) return false;
    if (!Array.isArray(char.aliases)) char.aliases = [];

    const lower = name.toLowerCase();
    if (String(char.name || '').toLowerCase() === lower) return false;
    if (char.aliases.some(a => String(a?.pattern || '').toLowerCase() === lower)) return false;

    char.aliases.push({ pattern: name, isRegex: false });
    saveSettings();
    return true;
}

/**
 * Move the character 'fromId' to the position of 'toId' in the settings array.
 * Also syncs category if they differ.
 */
export function reorderCharacters(fromId, toId) {
    const chars = getSettings().characters;
    const fromIdx = chars.findIndex(c => c.id === fromId);
    if (fromIdx === -1) return;

    const [char] = chars.splice(fromIdx, 1);

    // Find the target index AFTER the splice.
    const newToIdx = chars.findIndex(c => c.id === toId);
    if (newToIdx === -1) {
        // Fallback: put it back where it was if the target disappeared.
        chars.splice(fromIdx, 0, char);
        return;
    }

    // Apply category of target card to dragged card.
    char.category = chars[newToIdx].category;

    chars.splice(newToIdx, 0, char);
    saveSettings();
}

/**
 * Move the character 'fromId' to the end of 'category'.
 */
export function moveCharacterToCategory(fromId, category) {
    const chars = getSettings().characters;
    const fromIdx = chars.findIndex(c => c.id === fromId);
    if (fromIdx === -1) return;

    const [char] = chars.splice(fromIdx, 1);
    char.category = category;
    
    // Find last character in that category
    let lastIdx = -1;
    for (let i = chars.length - 1; i >= 0; i--) {
        if ((chars[i].category || '') === (category || '')) {
            lastIdx = i;
            break;
        }
    }

    if (lastIdx === -1) {
        chars.push(char);
    } else {
        chars.splice(lastIdx + 1, 0, char);
    }
    
    saveSettings();
}
