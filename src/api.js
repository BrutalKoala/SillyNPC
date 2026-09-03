import { chat, getRequestHeaders } from '../../../../../script.js';
import { getContext } from '../../../../st-context.js';
import { loadWorldInfo, saveWorldInfo, createWorldInfoEntry } from '../../../../world-info.js';
import { executeSlashCommandsOnChatInput } from '../../../../slash-commands.js';
import { saveBase64AsFile } from '../../../../utils.js';
import { LOG_PREFIX, debugLog, PORTRAIT_SHAPES, DEFAULT_PORTRAIT_SHAPE, PROFILE_FIELDS } from './constants.js';
// The chat draws this picture beside every line the character speaks, so changing it
// leaves the chat stale. reprocess.js holds the handle so any module can ask.
import { triggerReprocess } from './reprocess.js';
import { getSettings, saveSettings, defaultSettings, resolveImagePrompt } from './settings.js';
import { recordUsage } from './usage.js';
import { escapeRegExp, describeConnection, resolveImageFolder } from './utils.js';
import { loadStateFromMetadata } from './status-logic.js';
import { charactersMentionedIn } from './mentions.js';

/**
 * Creates a new entry in a lorebook.
 * @param {object} char Character object
 * @param {string} targetWorld Lorebook name
 * @param {string} entryName Name for the entry
 * @returns {Promise<{world: string, uid: number}>}
 */
export async function createLoreEntry(char, targetWorld, entryName) {
    debugLog('Creating lore entry', { targetWorld, entryName });
    if (!targetWorld) throw new Error('No lorebook selected.');

    const worldData = await loadWorldInfo(targetWorld);
    if (!worldData || !worldData.entries) throw new Error(`Could not load lorebook "${targetWorld}".`);

    // SillyTavern's own constructor, rather than a hand-written object.
    //
    // A world-info entry carries 39 fields from the template. The version written here
    // set ten of them and
    // invented two that do not exist - `weight` and `recursive`, where the real fields
    // are `groupWeight` and excludeRecursion/preventRecursion - and set `depth` without
    // setting the `position` that gives depth its meaning. Everything now comes from
    // newWorldInfoEntryTemplate, and only the three fields we actually mean to fill are
    // touched afterwards.
    const entry = createWorldInfoEntry(targetWorld, worldData);
    if (!entry) throw new Error('SillyTavern could not allocate a new entry.');

    entry.comment = entryName;
    entry.key = [entryName];
    entry.content = '';

    await saveWorldInfo(targetWorld, worldData);

    char.lorebook = { world: targetWorld, uid: entry.uid };
    saveSettings();

    return { world: targetWorld, uid: entry.uid };
}

/**
 * What the tracker already knows about this character, as lines for the lore prompt.
 *
 * The prompt used to see a name, whatever lore existed, and raw chat. Meanwhile the
 * extension was separately tracking this character's inventory, spells, skills and stats
 * and telling the model none of it - so generated lore re-inferred abilities from prose,
 * and contradicted the sheet it sits beside.
 *
 * Reads the scene first and falls back to the card, since a character who is not in the
 * room right now still has everything they own recorded there.
 *
 * @param {object} char The SillyNPC character card.
 * @returns {string} Empty when nothing is known, so the caller can substitute a note.
 */
/**
 * The character's profile fields, as lines for a prompt.
 *
 * Leads the established facts rather than sitting under them: who somebody is comes before
 * what they are currently carrying, and the lore writer is being told not to describe
 * these - which only works if it can see them.
 *
 * @param {object} char
 * @returns {string} Empty when nothing is filled in, so a caller can leave it out.
 */
export function describeProfile(char) {
    const profile = char?.profile || {};
    return PROFILE_FIELDS
        .map(field => {
            const value = String(profile[field.id] ?? '').trim();
            return value ? `${field.label}: ${value}` : null;
        })
        .filter(Boolean)
        .join('\n');
}

/**
 * The stats and collections a character actually has right now.
 *
 * The player is not one of the scene cast - that is what "this is me" means - so looking
 * them up by name in state.characters finds nothing, and both prompt builders quietly
 * fell back to the card's stored fields, which for the player are the master copy rather
 * than this chat. Their live facts are at state.player, and this is the one place that
 * says so.
 *
 * @param {object} char
 * Exported for the character page, which shows these and must not show the card's copy
 * for somebody currently on stage - those are what they last walked in carrying.
 *
 * @returns {{ stats: object, collections: object }}
 */
export function liveFactsFor(char) {
    let state = null;
    try { state = loadStateFromMetadata(); } catch { /* no chat open */ }

    if (char?.isPlayer) {
        return {
            stats: state?.player?.stats || char.stats || {},
            collections: state?.player?.collections || char.collections || {},
        };
    }

    const wanted = String(char?.name ?? '').toLowerCase();
    const actor = (state?.characters || []).find(c => String(c.name).toLowerCase() === wanted) || null;
    return {
        stats: actor?.stats || char?.statusOverrides || {},
        collections: actor?.collections || char?.statusCollections || {},
    };
}

export function describeTrackedFacts(char) {
    if (!char?.name) return '';

    const { stats, collections } = liveFactsFor(char);
    const lines = [];

    // Who they are comes before what they are carrying.
    const profile = describeProfile(char);
    if (profile) lines.push(profile);

    const statLine = Object.entries(stats)
        .filter(([, value]) => String(value ?? '').trim() !== '')
        .map(([name, value]) => `${name}: ${value}`)
        .join(', ');
    if (statLine) lines.push(statLine);

    for (const [colId, items] of Object.entries(collections)) {
        const named = (items || [])
            .map(item => {
                const name = String(item?.name ?? '').trim();
                if (!name) return null;
                // A one-line description is worth carrying; a paragraph is not.
                const detail = String(item?.description ?? '').trim().split('\n')[0];
                return detail && detail.length <= 120 ? `${name} (${detail})` : name;
            })
            .filter(Boolean);
        if (named.length) lines.push(`${colId}: ${named.join(', ')}`);
    }

    return lines.join('\n');
}

/**
 * Substitutes the portrait template's placeholders.
 *
 * Separate from the request so it can be checked without one. Name, lore and items each
 * get a readable stand-in rather than being dropped: an image model given "Carrying or
 * wearing:" with nothing after it will invent something to put there.
 *
 * Context is the exception, because it is the one a setting can deliberately turn off.
 * Image Context Length set to Lore Only means no recent chat was asked for, and writing
 * "Recent scene: (No recent context)" spends tokens saying nothing - Stable Diffusion in
 * particular reads those words as tags and draws them. So an empty context takes with it
 * whatever introduced it: the caption in front of it, and the comma holding it in a tag
 * list. The caption must not reach across a colon or a line break, or an empty context
 * would swallow the prompt above it.
 *
 * @param {string} template
 * @param {{ name?: string, lore?: string, items?: string, context?: string }} parts
 * @returns {string}
 */
export function fillImagePrompt(template, { name, lore, items, context } = {}) {
    let out = String(template ?? '');

    if (context) {
        out = out.replace(/\[CONTEXT\]/g, context);
    } else {
        // The caption introducing it, if there is one on the same line.
        out = out.replace(/(?:[^\n:]*:[^\S\n]*)?\[CONTEXT\]/g, '');
        // The comma holding it in a list, but only the one that now leads nowhere.
        out = out.replace(/,[^\S\n]*(?=,|[^\S\n]*(?:\r?\n|$))/g, '');
        // And the hole a whole removed line leaves in between two others.
        out = out.replace(/\n{3,}/g, '\n\n');
    }

    return out
        .replace(/\[NAME\]/g, name || 'a character')
        .replace(/\[LORE\]/g, lore || 'a mysterious person')
        .replace(/\[ITEMS\]/g, items || 'nothing notable');
}

/**
 * What this character is carrying, for a picture prompt.
 *
 * Deliberately not describeTrackedFacts: that carries stats and item descriptions, which
 * a portrait model does not want and Stable Diffusion in particular will render as
 * literal words. Names only, comma separated, in the order they are held.
 *
 * @param {object} char
 * @returns {string} Empty when nothing is recorded, so the caller can substitute.
 */
export function describeCarriedItems(char) {
    if (!char?.name) return '';

    const { collections } = liveFactsFor(char);
    const names = [];
    const seen = new Set();

    for (const items of Object.values(collections)) {
        for (const item of items || []) {
            const name = String(item?.name ?? '').trim();
            if (!name) continue;
            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            names.push(name);
        }
    }

    return names.join(', ');
}

/** How much retrieved reference text the prompt will take. */
const WORLD_FACTS_CAP = 8000;

/**
 * What your Data Bank has to say about this character.
 *
 * SillyTavern's Vector Storage skips quiet prompts by design - `rearrangeChat` returns
 * immediately on type 'quiet' - so lore generation has never seen the Data Bank, before
 * or after it stopped using the story pipeline. This asks for it outright instead.
 *
 * Searched by name alone: predictable, and it finds the material that actually mentions
 * them rather than everything their inventory happens to resemble. No count argument, so
 * SillyTavern's own chunk-count setting decides and this does not compete with it.
 *
 * @param {string} name
 * @returns {Promise<string>} Empty when switched off, unavailable, or nothing matched.
 */
export async function retrieveWorldFacts(name) {
    if (!getSettings().loreUseDataBank) return '';

    // The parser splits on newlines and pipes and reads quotes, so a name carrying any of
    // them would take the rest of the command with it. Same treatment as the /sd prompt.
    const query = String(name ?? '')
        .replace(/\r?\n/g, ' ')
        .replace(/\|/g, ' ')
        .replace(/"/g, '\\"')
        .trim();
    if (!query) return '';

    try {
        const result = await executeSlashCommandsOnChatInput(
            `/db-search return=chunks ${query}`, { clearChatInput: false });
        const text = typeof result === 'string' ? result : (result?.pipe ?? '');
        const trimmed = String(text ?? '').trim();
        if (!trimmed) return '';

        debugLog('Data Bank chunks for lore', { name, chars: trimmed.length });
        // Chunk size is configurable, so three of them need not be small.
        return trimmed.length > WORLD_FACTS_CAP
            ? trimmed.slice(0, WORLD_FACTS_CAP)
            : trimmed;
    } catch (err) {
        // No index, no command, no Vector Storage. None of it should stop an entry being
        // written from what the extension already knows.
        console.warn(LOG_PREFIX, 'Data Bank search unavailable, writing without it', err);
        return '';
    }
}

/** What the lore writer is told it is, since it no longer inherits a character card. */
const LORE_SYSTEM_PROMPT =
    'You write reference entries for a roleplaying setting\'s world information. '
    + 'Follow the requested format exactly. Reply with the entry and nothing else - no '
    + 'preamble, no commentary, and never dialogue or narration.';

/**
 * The slice of story the lore writer is shown.
 *
 * Bounded by characters as well as by message count. "Whole chat" meant literally the
 * whole chat: on a long story that is megabytes in a single prompt, and SillyTavern could
 * not build the request at all - it reported "Mandatory prompts exceed the context size",
 * then generated from whatever fitted, which was never the instruction.
 *
 * Whole messages only, newest first, so the excerpt never starts mid-sentence.
 *
 * @param {Array<object>} messages
 * @returns {{ text: string, used: number, available: number, trimmed: boolean }}
 */
export function buildLoreExcerpt(messages) {
    const settings = getSettings();
    // 0 means the whole chat, the same convention the history scan's depth uses. Read
    // with `|| 15` this would be silently impossible: zero is falsy, so choosing "whole
    // chat" would quietly have given fifteen messages.
    const configured = Number(settings.contextMessages);
    const count = Number.isFinite(configured) ? configured : 15;
    const wanted = count > 0 ? messages.slice(-count) : messages.slice();
    const budget = Math.max(1000, Number(settings.loreCharBudget) || 40000);

    const lines = [];
    let chars = 0;
    for (let i = wanted.length - 1; i >= 0; i--) {
        const m = wanted[i];
        const line = `${m.is_user ? 'User' : (m.name || 'Assistant')}: ${m.mes}`;
        if (chars + line.length > budget && lines.length) break;
        lines.unshift(line);
        chars += line.length + 1;
    }

    return {
        text: lines.join('\n'),
        used: lines.length,
        available: wanted.length,
        trimmed: lines.length < wanted.length,
    };
}

/**
 * Sends the lore request.
 *
 * Deliberately not generateQuietPrompt. That runs SillyTavern's story pipeline, so the
 * character card, your persona, world info and the chat all travel as *mandatory* prompts
 * with the instruction on top - and when they did not fit, SillyTavern dropped the
 * instruction, generated in character anyway, and offered that as lore.
 *
 * The same shape as requestExtraction: a chosen profile if there is one, otherwise
 * generateRawData, which sends only what it is given and works across backends.
 */
/**
 * Which connection served the last lore request, for the settings panel to display.
 *
 * A user reported that generating lore had changed the API their chat was using. It had
 * not - sendRequest passes a profile into one request and never writes selectedProfile -
 * but there was no way to establish that after the fact, only to reason about it. So
 * record what actually ran, including the fall back to the main API, which is the case
 * most likely to look like something went wrong.
 *
 * @type {{ label: string, when: number } | null}
 */
let lastLoreConnection = null;

/** @returns {{ label: string, when: number } | null} */
export function getLastLoreConnection() {
    return lastLoreConnection;
}

async function requestLore(prompt) {
    const context = getContext();
    const settings = getSettings();
    const profileId = settings.loreProfileId;
    const maxTokens = Number(settings.loreMaxTokens) || 1200;

    debugLog(`Lore -> ${describeConnection(profileId)}, reply budget ${maxTokens}`);

    if (profileId) {
        // Connection Manager can be disabled and a profile can be deleted; either throws,
        // so fall through to the main API rather than failing the generation.
        try {
            const result = await context.ConnectionManagerRequestService.sendRequest(
                profileId,
                [
                    { role: 'system', content: LORE_SYSTEM_PROMPT },
                    { role: 'user', content: prompt },
                ],
                maxTokens,
                { extractData: true, includePreset: false },
            );
            const profile = context.extensionSettings?.connectionManager?.profiles
                ?.find(p => p.id === profileId);
            lastLoreConnection = {
                label: profile
                    ? `${profile.name || profileId}${profile.model ? ` (${profile.model})` : ''}`
                    : profileId,
                when: Date.now(),
            };
            const text = (typeof result === 'string' ? result : (result?.content ?? '')) || '';
            recordUsage('lore', { prompt: LORE_SYSTEM_PROMPT + prompt, reply: text });
            return text;
        } catch (err) {
            console.warn(LOG_PREFIX, 'Lore connection unavailable, using the main API:', err);
        }
    }

    lastLoreConnection = {
        label: profileId
            ? 'Main API (the chosen connection was unavailable)'
            : 'Main API (same as chat)',
        when: Date.now(),
    };
    const raw = await context.generateRawData({
        prompt,
        systemPrompt: LORE_SYSTEM_PROMPT,
        responseLength: maxTokens,
    });
    const text = (typeof raw === 'string' ? raw : (raw?.content ?? '')) || '';
    // Not awaited on purpose: counting asks the tokenizer, and a counter is not worth
    // making anyone wait for, nor worth failing a generation over.
    recordUsage('lore', { prompt: LORE_SYSTEM_PROMPT + prompt, reply: text });
    return text;
}

/**
 * The ask sent to the lore writer.
 *
 * Separated from the request so the one rule worth checking - which of the story reaches
 * the writer - can be checked without asking a model anything.
 *
 * @param {object} char
 * @param {object} [options]
 * @param {string} [options.existingLore] The entry's current contents, when rewriting one.
 * @param {string} [options.worldFacts] What the Data Bank holds about them.
 * @returns {string}
 */
export function buildLorePrompt(char, { existingLore = '', worldFacts = '' } = {}) {
    const excerpt = buildLoreExcerpt(chat || []);

    /* The story goes in only when this character is actually in it.

       It went in unconditionally, and an excerpt is mostly the reader's own messages and
       their persona's narration - so asking for an entry about somebody who has not
       appeared yet handed the writer a page about one person and the name of another. It
       wrote about the person it could see. The profile had the same fault and the same
       fix; this is the other half of it, and without it a profile filled from a fresh
       entry would be filled from that mistake instead of refusing.

       Done here rather than in the prompt text because generationPrompt is a template the
       reader can rewrite: wording added to the shipped one would never reach anybody who
       has customised theirs, which is how [CONTEXT] was lost from the image template. */
    const inStory = excerpt.text
        ? charactersMentionedIn(excerpt.text, [char]).length > 0
        : false;
    const recentMessages = inStory ? excerpt.text : '';

    const template = getSettings().generationPrompt;
    let prompt = template
        .replace(/\[NAME\]/g, char.name)
        .replace(/\[LORE\]/g, existingLore || '(No existing lore yet)')
        .replace(/\[CONTEXT\]/g, recentMessages)
        .replace(/\[WORLD\]/g, worldFacts || '(Nothing found in the Data Bank)')
        .replace(/\[FACTS\]/g, describeTrackedFacts(char) || '(Nothing tracked yet)');

    // A template written before [WORLD] existed - which is most of them, including any you
    // have customised - would otherwise leave the setting doing nothing at all. Appended
    // only when there is something to append, so an unindexed character gains no empty
    // heading.
    if (worldFacts && !template.includes('[WORLD]')) {
        prompt += `\n\nFrom the setting's reference material:\n${worldFacts}`;
    }

    return prompt;
}

/**
 * Generates lore tags and content using an LLM.
 *
 * @param {object} char Character object
 * @param {string} world Lorebook name
 * @param {number} uid Entry UID
 * @returns {Promise<{ tags: string, content: string, followedFormat: boolean, excerpt: object }>}
 */
export async function generateLoreContent(char, world, uid, { worldFacts = null } = {}) {
    let existingLore = '';
    try {
        const worldData = await loadWorldInfo(world);
        const entries = worldData.entries;
        const entry = Array.isArray(entries) ? entries.find(e => Number(e.uid) === Number(uid)) : entries[uid];
        if (entry) existingLore = entry.content || '';
    } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to load existing lore for generation', e);
    }

    const facts = worldFacts ?? await retrieveWorldFacts(char.name);
    const prompt = buildLorePrompt(char, { existingLore, worldFacts: facts });

    const text = await requestLore(prompt);

    let tags = '';
    let content = text;

    const tagsMatch = text.match(/Tags:\s*([^\n\r]+)/i);
    const contentMatch = text.match(/Content:\s*([\s\S]+)/i);

    if (tagsMatch) {
        tags = tagsMatch[1].trim();
    }
    
    if (contentMatch) {
        content = contentMatch[1].trim();
    } else if (tagsMatch) {
        content = text.slice(tagsMatch.index + tagsMatch[0].length).trim();
    }
    
    if (tags) {
        const escapedTags = escapeRegExp(tags);
        const tagsPattern = new RegExp(`^\\s*Tags:\\s*${escapedTags}\\s*\\n?`, 'i');
        content = content.replace(tagsPattern, '').trim();
    }

    const namePattern = new RegExp(`^#*\\s*${escapeRegExp(char.name)}\\s*[:\\-]?\\s*\\n?`, 'i');
    content = content.replace(namePattern, '').trim();

    // The prompt asks for "Tags:" and "Content:". A reply with neither did not follow the
    // instruction, and the usual reason is that the instruction never arrived - the reply
    // is then the story model answering in character. Reported rather than hidden, so a
    // usable answer can still be salvaged.
    const followedFormat = Boolean(tagsMatch || contentMatch);

    return { tags, content, followedFormat, excerpt };
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
 * Saves tags and content to a lorebook entry.
 * @param {object} char Character object
 * @param {string} world Lorebook name
 * @param {number} uid Entry UID
 * @param {string} tags Tags string
 * @param {string} content Lore content
 * @returns {Promise<void>}
 */
export async function saveLoreContent(char, world, uid, tags, content) {
    const worldData = await loadWorldInfo(world);
    if (!worldData || !worldData.entries) throw new Error('Lorebook not found or entries missing');
    
    const entries = worldData.entries;
    let entry;
    if (Array.isArray(entries)) {
        entry = entries.find(e => Number(e.uid) === Number(uid));
    } else {
        entry = entries[uid];
    }

    if (!entry) throw new Error(`Entry UID ${uid} not found in Lorebook`);

    entry.key = mergeKeywords(entry.key, tags);
    entry.content = content.trim();
    
    await saveWorldInfo(world, worldData);
    char.lorebook = { world, uid: Number(uid) };
    saveSettings();
}

/**
 * Writes a freshly generated image to disk and returns its served path.
 *
 * Generated images used to be stored as data: URIs directly in
 * extension_settings, so settings.json grew by the size of every portrait and was
 * rewritten on every save. This also makes the previously write-only
 * imageSaveRoute setting do something.
 *
 * Falls back to the original data URI if the upload fails, so image generation
 * never breaks just because the file could not be written.
 *
 * @param {string} dataUri
 * @param {string} charName
 * @returns {Promise<string>}
 */
export async function persistGeneratedImage(dataUri, charName) {
    const match = /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i.exec(dataUri);
    if (!match) return dataUri;

    const [, rawFormat, base64] = match;
    const format = rawFormat.toLowerCase() === 'jpeg' ? 'jpg' : rawFormat.toLowerCase();

    const folder = resolveImageFolder(getSettings().imageSaveRoute);
    const fileName = `${characterImagePrefix(charName)}${Date.now()}`;

    try {
        return await saveBase64AsFile(base64, folder, fileName, format);
    } catch (err) {
        console.warn(LOG_PREFIX, 'Could not write generated image to disk; keeping inline data URI', err);
        return dataUri;
    }
}

/**
 * The filename prefix a character's generated images carry.
 *
 * One rule, used by both the writer and the scanner, because they have to agree exactly:
 * \w is [A-Za-z0-9_], so "Varga Elza" becomes "Varga_Elza" and accented letters are lost
 * too - "Dávid" is written as "D_vid" and "Agent Károly" as "Agent_K_roly". A scanner
 * that sanitised even slightly differently would match nothing for those characters and
 * report an honest-looking zero.
 *
 * @param {string} name
 * @returns {string}
 */
export function characterImagePrefix(name) {
    return `${(name || 'character').replace(/[^\w.-]+/g, '_')}_`;
}

/**
 * Adds images already on disk to the characters they belong to.
 *
 * Portraits were written to disk long before the extension kept a list of them, so a
 * character could have six pictures in the folder and know about one. This walks the
 * configured folder and hands each file to the character whose prefix it carries.
 *
 * Only finds what SillyNPC itself wrote. Images generated through SillyTavern's own
 * gallery are named after the character *card* - "The Dungeon Master_2026-05-28@...jpg" -
 * so they carry no clue about which SillyNPC character uses them, and are left alone
 * rather than guessed at.
 *
 * @returns {Promise<{ scanned: number, added: number, characters: number }>}
 */
export async function scanFolderForCharacterImages() {
    const folder = resolveImageFolder(getSettings().imageSaveRoute);

    let files = [];
    try {
        const response = await fetch('/api/images/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ folder, sortField: 'date', sortOrder: 'asc' }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        files = await response.json();
    } catch (err) {
        debugLog('Could not list the save folder', err);
        throw new Error(
            `Could not read user/images/${folder}. The folder may not exist yet, or no `
            + 'images have been generated into it.',
        );
    }

    if (!Array.isArray(files)) return { scanned: 0, added: 0, characters: 0 };

    const characters = getSettings().characters || [];
    // Longest prefix first, so "The Fae" cannot swallow a file belonging to "The Fae Queen".
    const byPrefix = characters
        .filter(char => char && char.name)
        .map(char => ({ char, prefix: characterImagePrefix(char.name) }))
        .sort((a, b) => b.prefix.length - a.prefix.length);

    let added = 0;
    const touched = new Set();

    for (const file of files) {
        if (typeof file !== 'string') continue;
        const match = byPrefix.find(entry => file.startsWith(entry.prefix));
        if (!match) continue;

        const path = `/user/images/${folder}/${file}`;
        const char = match.char;
        if (!Array.isArray(char.images)) char.images = [];
        if (char.images.includes(path)) continue;

        char.images.push(path);
        added++;
        touched.add(char.name);
    }

    if (added) saveSettings();
    return { scanned: files.length, added, characters: touched.size };
}

/**
 * Stores an image the user chose from disk, so it behaves like a generated one.
 *
 * Browsing used to assign the data URI straight to the character, which put the whole
 * image inside settings.json - the bloat writing to disk exists to avoid - and left it
 * out of the image list, so the arrows would step straight past it and it vanished.
 *
 * @param {object} char
 * @param {string} dataUri
 * @returns {Promise<string>} The stored path, or the original data URI if writing failed.
 */
export async function adoptImageForCharacter(char, dataUri) {
    const stored = await persistGeneratedImage(dataUri, char.name);
    if (!Array.isArray(char.images)) char.images = [];
    if (!char.images.includes(stored)) char.images.push(stored);
    char.imageUrl = stored;
    saveSettings();
    // The picture on every line this character speaks has just changed.
    triggerReprocess();
    return stored;
}

/**
 * Removes one image from a character, and from disk when nothing else uses it.
 *
 * The file is only unlinked when no other character points at it: sharing a portrait is
 * unusual but deleting one out from under a second character would be unrecoverable, and
 * an orphaned file costs nothing by comparison.
 *
 * @param {object} char
 * @param {string} path
 * @param {object} [options]
 * @param {boolean} [options.deleteFile=false] Erase the file too. Off by default so the
 *   destructive reading is never the one that happens by omission.
 * @returns {Promise<{ removed: boolean, deletedFile: boolean }>}
 */
export async function removeCharacterImage(char, path, { deleteFile = false } = {}) {
    if (!path || !Array.isArray(char.images)) return { removed: false, deletedFile: false };

    const at = char.images.indexOf(path);
    if (at >= 0) char.images.splice(at, 1);

    // Step to whatever is left rather than leaving the character pointing at a gap.
    if (char.imageUrl === path) {
        char.imageUrl = char.images[Math.min(at, char.images.length - 1)] || '';
    }

    // The player's card holds images the same way a character's does, so it has to be
    // counted here too - otherwise erasing a portrait from a character could take the
    // file the player is using with it.
    const holders = [...(getSettings().characters || []), ...Object.values(getSettings().personaData || {})];
    const stillUsed = holders.some(
        other => other !== char && (other?.imageUrl === path || (other?.images || []).includes(path)),
    );

    let deletedFile = false;
    if (deleteFile && !stillUsed && !path.startsWith('data:')) {
        try {
            const response = await fetch('/api/images/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                // The endpoint joins this to the user root, which is where the leading
                // slash the stored paths carry would take it somewhere else entirely.
                body: JSON.stringify({ path: path.replace(/^\//, '') }),
            });
            deletedFile = response.ok;
        } catch (err) {
            debugLog('Could not delete the image file', path, err);
        }
    }

    saveSettings();
    triggerReprocess();
    return { removed: at >= 0, deletedFile };
}

/**
 * Generates a portrait with a Google Gemini image model ("Nano Banana").
 *
 * This bypasses the Stable Diffusion extension deliberately. Its Google source only
 * offers imagen-* and veo-* models, so an account entitled to the Gemini image models
 * cannot generate images through it at all. The Chat Completion backend does support
 * them, behind a request_images flag.
 *
 * The Google API key is read server-side from SillyTavern secrets, so nothing here
 * sends or even reads a credential.
 *
 * @param {string} fullPrompt
 * @returns {Promise<string>} A data: URI for the generated image.
 */
/**
 * The provider's own explanation, wherever it ended up in the body.
 *
 * SillyTavern forwards Google's error JSON largely untouched, so the useful sentence is
 * usually at `error.message` - but `error` is sometimes a bare string, sometimes the
 * literal `true` with nothing else, and a failure that never reached Google at all puts
 * its own text at the top level.
 *
 * @returns {string} Empty when the body carries no readable explanation.
 */
function messageFromErrorBody(body) {
    if (!body || typeof body !== 'object') return '';
    const { error, message } = body;

    if (error && typeof error === 'object' && typeof error.message === 'string') {
        return error.message.trim();
    }
    // `error: true` is a flag, not an explanation.
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (typeof message === 'string' && message.trim()) return message.trim();
    return '';
}

/**
 * The requested portrait shape, or the default if the stored key is unknown.
 *
 * @returns {{ label: string, gemini: string, pixels: { width: number, height: number } | null }}
 */
export function resolvePortraitShape() {
    const key = getSettings().portraitShape;
    return PORTRAIT_SHAPES[key] || PORTRAIT_SHAPES[DEFAULT_PORTRAIT_SHAPE];
}

/**
 * The secret id a chosen connection profile pins, or '' for the active key.
 *
 * Kept separate from the request so a deleted or renamed profile degrades to today's
 * behaviour rather than throwing - the same courtesy requestLore extends to its own
 * profile going missing.
 *
 * @returns {string}
 */
export function resolveImageSecretId() {
    const profileId = getSettings().imageProfileId;
    if (!profileId) return '';
    const profiles = getContext()?.extensionSettings?.connectionManager?.profiles;
    const profile = Array.isArray(profiles) ? profiles.find(p => p?.id === profileId) : null;
    return profile?.['secret-id'] || '';
}

/**
 * Reads an image into a data: URL, which is the only form the API accepts.
 *
 * Portraits are written to disk and remembered by path, but SillyTavern's Google converter
 * only turns a content part into inlineData when the URL starts with "data:" - a path is
 * dropped in silence. Anything already inline is passed straight back.
 *
 * Returns null rather than throwing: a reference that cannot be read should cost you the
 * reference, not the generation.
 *
 * @param {string} src
 * @returns {Promise<string|null>}
 */
export async function toDataUrl(src) {
    if (!src) return null;
    if (src.startsWith('data:')) return src;
    try {
        const response = await fetch(src.startsWith('/') || /^https?:/.test(src) ? src : `/${src}`);
        if (!response.ok) return null;
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const mime = response.headers?.get?.('content-type') || 'image/png';
        return `data:${mime};base64,${btoa(binary)}`;
    } catch (err) {
        debugLog('Could not read reference image', src, err);
        return null;
    }
}

async function generateViaGeminiImage(fullPrompt, referenceImages = []) {
    const settings = getSettings();
    const model = settings.geminiImageModel || defaultSettings.geminiImageModel;
    // Omitted entirely when empty. Sending secret_id: '' is not the same as sending
    // nothing: the server reads the active secret only when the field is absent.
    const secretId = resolveImageSecretId();

    debugLog(
        `Portrait -> Google AI Studio / ${model}, `
        + `${settings.imageProfileId
            ? describeConnection(settings.imageProfileId, { includeModel: false })
            : 'key: whichever is active'}`,
    );

    // A plain string when there is nothing to reference, so the request is byte-for-byte
    // what it always was; the parts form only appears once an image is actually attached.
    const usable = referenceImages.filter(Boolean);
    // A reference with no instruction is what made the model reply "what would you like to
    // modify?" instead of drawing: the template is a description, and a description next
    // to a picture reads as conversation rather than a brief.
    const preamble = settings.imgGenReferencePreamble ?? defaultSettings.imgGenReferencePreamble;
    const withReference = preamble ? `${preamble}

${fullPrompt}` : fullPrompt;
    const messageContent = usable.length
        ? [
            { type: 'text', text: withReference },
            ...usable.map(url => ({ type: 'image_url', image_url: { url } })),
        ]
        : fullPrompt;

    // What actually went to the model, not what was meant to. The failure this is for -
    // a text reply where a picture was asked for - is decided entirely by the assembled
    // prompt and whether the pictures really arrived, and neither was visible afterwards.
    debugLog('Portrait request', {
        model,
        references: usable.length,
        // Base64 length, since that is what is sent and what a size limit counts.
        referenceKB: usable.map(url => Math.round(String(url).length / 1024)),
        preamble: preamble ? `${preamble.length} chars, sent first` : 'none - template alone',
        prompt: withReference,
    });

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: 'makersuite',
            model,
            messages: [{ role: 'user', content: messageContent }],
            request_images: true,
            request_image_aspect_ratio: resolvePortraitShape().gemini,
            ...(secretId ? { secret_id: secretId } : {}),
            max_tokens: 8192,
            stream: false,
        }),
    });

    // Read the body before deciding anything. When Google refuses - a quota spent, a model
    // the key cannot use - SillyTavern logs the real text to its own console and forwards
    // the parsed error to us as an HTTP 500 body. This used to report "HTTP 500" and throw
    // that explanation away, which is why the only way to learn the actual reason was to
    // go and read the server terminal.
    const data = await response.json().catch(() => null);
    const providerMessage = messageFromErrorBody(data);

    if (!response.ok) {
        if (providerMessage) throw new Error(`Google refused the request: ${providerMessage}`);
        // A 400 carrying nothing at all is what a missing key looks like.
        if (response.status === 400) {
            throw new Error(
                'SillyTavern has no Google AI Studio API key saved. Add one under '
                + 'API Connections (Chat Completion -> Google AI Studio); the key is read '
                + 'server-side and is never handled by SillyNPC.',
            );
        }
        throw new Error(
            `Gemini image request failed (HTTP ${response.status}). The provider's reason is `
            + 'printed in the SillyTavern server console - the terminal running it, not the '
            + 'browser.',
        );
    }
    // An error can also arrive with a 200, so the same reading applies on the way through.
    if (data?.error) {
        throw new Error(`Gemini refused the request: ${providerMessage || JSON.stringify(data.error)}`);
    }

    const parts = data?.responseContent?.parts;
    const imagePart = Array.isArray(parts) ? parts.find(p => p?.inlineData?.data) : null;

    if (!imagePart) {
        // A text-only reply almost always means the model declined the prompt, or the
        // selected model is not image-capable. Surface whatever it said.
        const said = (Array.isArray(parts) ? parts.map(p => p?.text).filter(Boolean).join(' ') : '')
            || data?.choices?.[0]?.message?.content
            || '';
        const detail = said ? ` It replied: "${String(said).slice(0, 300)}"` : '';
        throw new Error(
            `The model "${model}" returned text instead of an image.${detail}`
            + ' Check that the selected model can generate images and that the prompt was not refused.',
        );
    }

    const mimeType = imagePart.inlineData.mimeType || 'image/png';
    return `data:${mimeType};base64,${imagePart.inlineData.data}`;
}

/**
 * Logic for generating a character image.
 * @param {object} char Character object
 * @returns {Promise<string>} Image URL or base64
 */
export async function generateCharacterImageLogic(char, { referenceImages = [] } = {}) {
    let loreContext = '';
    if (char.lorebook) {
        const worldData = await loadWorldInfo(char.lorebook.world);
        const entries = worldData.entries;
        const entry = Array.isArray(entries) ? entries.find(e => Number(e.uid) === Number(char.lorebook.uid)) : entries[char.lorebook.uid];
        if (entry) {
            loreContext = entry.content || '';
        }
    }

    const msgCount = Number(getSettings().imgGenContextMessages) || 0;
    // Attributed, like the lore path. Message bodies run together with no speaker is
    // mostly noise in a picture prompt - half of it is someone else talking.
    //
    // Empty rather than a stand-in when Lore Only is chosen: fillImagePrompt takes the
    // whole "Recent scene:" line out on empty, which is what that setting means.
    const recentMessages = msgCount > 0
        ? chat.slice(-msgCount).map(m => `[${m.is_user ? 'User' : (m.name || 'Narrator')}] ${m.mes}`).join('\n')
        : '';

    const fullPrompt = fillImagePrompt(resolveImagePrompt(), {
        name: char.name,
        // Appearance rides in on [LORE] rather than a placeholder of its own: a custom
        // image template replaces the shipped one outright and would never contain a tag
        // invented after it was written.
        lore: [String(char?.profile?.appearance ?? '').trim(), loreContext]
            .filter(Boolean).join('\n\n'),
        items: describeCarriedItems(char),
        context: recentMessages,
    });

    debugLog('Image prompt', fullPrompt);

    // Gemini backend: skip the SD extension entirely and go straight to the Chat
    // Completion endpoint, which is the only path that reaches the Gemini image models.
    if (getSettings().imageBackend === 'gemini') {
        // References resolved here rather than at the call site, so a path, a data URL or
        // a mix all arrive in the one form the API takes.
        const resolved = await Promise.all(referenceImages.map(src => toDataUrl(src)));

        // A reference that could not be read used to be filtered out further down, and
        // the portrait was drawn without it - so asking for a likeness and getting a
        // stranger looked exactly like the model ignoring the reference. If a picture was
        // asked for and cannot be sent, that is worth stopping for.
        const unreadable = referenceImages.filter((_, i) => !resolved[i]);
        if (unreadable.length) {
            throw new Error(
                `Could not read ${unreadable.length} of ${referenceImages.length} reference `
                + `image(s), so the portrait was not generated - it would have been drawn `
                + `without them. First one: ${unreadable[0]}`,
            );
        }

        let geminiUrl = await generateViaGeminiImage(fullPrompt, resolved);
        geminiUrl = await persistGeneratedImage(geminiUrl, char.name);
        recordUsage('image', { prompt: fullPrompt });
        // Deliberately not assigned: the result is offered as use, keep or discard, so
        // deciding here would make "discard" mean undoing something already done.
        return geminiUrl;
    }

    debugLog('Attempting image generation via slash command /sd');
    
    const negativePrompt = getSettings().imgGenNegativePrompt || defaultSettings.imgGenNegativePrompt;
    
    // Some SD extensions handle multi-line prompts via safe replacement.
    // For the slash command, we must ensure it stays on one line to avoid being split by the parser.
    // We also escape double quotes within the prompt to prevent breaking the slash command.
    const safePrompt = fullPrompt.trim().replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
    const safeNegative = negativePrompt.trim().replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
    
    // Some SD extensions fail if 'prompt=' is explicitly used.
    // We use positional prompt (at the end) for maximum compatibility.
    // Size is a setting now, not a literal. The pixels here are only half the story on
    // Google, which discards them and snaps to the nearest ratio it accepts - see
    // PORTRAIT_SHAPES for why each pair is the pair it is. When the user has asked to keep
    // SillyTavern's own Resolution, we send no dimensions at all rather than a value that
    // would quietly beat it.
    const { pixels } = resolvePortraitShape();
    const size = pixels ? `width=${pixels.width} height=${pixels.height} ` : '';
    const command = `/sd quiet=true ${size}negative="${safeNegative}" ${safePrompt}`;
    console.info(LOG_PREFIX, 'Sending SD command:', command);
    
    const result = await executeSlashCommandsOnChatInput(command, { clearChatInput: false });
    recordUsage('image', { prompt: `${fullPrompt} ${negativePrompt}` });

    const extractImageUrl = (res) => {
        if (!res) return null;
        if (typeof res === 'string') {
            const clean = res.trim();
            if (clean.startsWith('http') || clean.startsWith('data:') || clean.startsWith('/') || clean.startsWith('cache/') || /\.(png|jpg|jpeg|webp)$/i.test(clean)) {
                return clean;
            }
            return null;
        }
        if (typeof res === 'object') {
            const url = res.pipe || res.output || res.image || res.url || res.result;
            if (url && typeof url === 'string') {
                const clean = url.trim();
                if (clean.startsWith('http') || clean.startsWith('data:') || clean.startsWith('/') || clean.startsWith('cache/') || /\.(png|jpg|jpeg|webp)$/i.test(clean)) {
                    return clean;
                }
            }
        }
        return null;
    };

    let imageUrl = extractImageUrl(result);
    
    if (!imageUrl) {
        // The /sd command swallows provider errors: generatePicture() catches them,
        // shows its own toast and returns undefined, which the parser then coerces to
        // an empty string. So reaching here means the provider refused the request.
        //
        // There used to be four fallback endpoints tried at this point
        // (/api/extensions/image-generation/generate and friends). None of them exist
        // in SillyTavern, so they only added four failed round-trips before this
        // error. Removed.
        //
        // The message deliberately points at the SERVER console: for the Google
        // backend, SillyTavern's own endpoint logs the provider's real rejection with
        // console.warn and then returns only a generic 'Image generation request
        // failed' to the browser, so DevTools can never show the actual reason.
        throw new Error(
            'The image provider refused the request. '
            + 'The real reason is only printed in the SillyTavern server console '
            + '(the terminal running ST) - not in the browser DevTools. '
            + 'Check that Image Generation is configured and that your provider '
            + 'accepts the request (API tier, region restrictions and safety filters '
            + 'are the usual causes).',
        );
    }

    if (typeof imageUrl === 'string' && imageUrl.length > 100 && !imageUrl.startsWith('data:') && !imageUrl.startsWith('http') && !imageUrl.startsWith('cache/') && !/\.(png|jpg|jpeg|webp)$/i.test(imageUrl)) {
        imageUrl = `data:image/png;base64,${imageUrl}`;
    }

    if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) {
        imageUrl = await persistGeneratedImage(imageUrl, char.name);
    }

    // Not assigned here either - both backends hand the result back for the caller to
    // use, keep or discard.
    return imageUrl;
}
