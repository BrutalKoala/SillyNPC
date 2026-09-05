import {
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    main_api,
    saveSettingsDebounced,
} from '../../../../../script.js';
import { promptManager } from '../../../../openai.js';
import { INJECTION_POSITION } from '../../../../PromptManager.js';

/**
 * Where a writing prompt lives: in SillyTavern's own prompt list, or in the extension's
 * injection slot.
 *
 * The first version of this module got the mechanism wrong, and the mistake is worth
 * recording because the code that misled it is still there. openai.js does pick up
 * extension prompts registered at IN_PROMPT, in preparePromptsForChatCompletion:
 *
 *     if (![BEFORE_PROMPT, IN_PROMPT].includes(prompt.position)) continue;
 *     systemPrompts.push({ identifier: ..., extension: true });
 *
 * but systemPrompts is a local array, used for that one generation and dropped. The list
 * under AI Response Configuration is rendered from somewhere else entirely - prompt_order
 * and serviceSettings.prompts, in PromptManager.renderPromptManagerListItems - and nothing
 * in SillyTavern ever writes an extension prompt into those. So no extension prompt has
 * ever appeared in that list, and no choice of position can make one appear.
 *
 * What that code does give an extension is an override: if an entry with a matching
 * identifier is already in the list, its position, depth, order and role are copied onto
 * the extension prompt. It reads placement from the list; it never adds to it.
 *
 * Being listed therefore means being a real prompt. This module writes one - into the
 * prompt manager's settings and its order - and stops injecting that block through
 * setExtensionPrompt, because doing both sends it twice: an extension prompt set to In-Chat
 * matches the absolute-injection filter and the extension loop in populateChatCompletion,
 * and is inserted by each.
 *
 * The entry is created In-Chat at depth 0, which is exactly where the extension slot puts
 * it, so switching this on moves nothing until the user drags it. From then on the list
 * owns placement and the on/off toggle; the extension still owns the text, and rewrites the
 * entry's content on every send.
 *
 * The cost, which the setting's help text states: the entry lives in the user's chat
 * completion preset. It is saved with it, exported with it, and replaced when another one
 * is loaded - so whatever calls this has to call it again on OAI_PRESET_CHANGED_AFTER.
 */

const IN_CHAT = extension_prompt_types.IN_CHAT;
const IN_PROMPT = extension_prompt_types.IN_PROMPT;

/** What SillyTavern would have called this key, had its own listing worked. */
function identifierFor(key) {
    return String(key).replace(/\W/g, '_');
}

/**
 * Whether SillyTavern's prompt list exists at all right now.
 *
 * It is a Chat Completion feature. On Text Completion there is no list, no prompt manager
 * and no way to place anything through one, so the offer is only made where it can be kept.
 *
 * @returns {boolean}
 */
export function promptListAvailable() {
    return main_api === 'openai';
}

/**
 * The prompt manager, if it is far enough along to be written to.
 *
 * It is built on the first Chat Completion settings load and its prompt order is filled in
 * by sanitizeServiceSettings, so early in a session either can be missing. Nothing is
 * written when they are - the block falls back to the extension slot for that send, and is
 * picked up on the next one.
 *
 * @returns {object|null}
 */
function readyManager() {
    const pm = promptManager;
    if (!pm || !Array.isArray(pm.serviceSettings?.prompts)) return null;
    if (!pm.activeCharacter || !Array.isArray(pm.serviceSettings?.prompt_order)) return null;
    return pm;
}

/** The order list for whichever character the manager is showing - global, in practice. */
function orderFor(pm) {
    const id = String(pm.activeCharacter.id);
    return pm.serviceSettings.prompt_order
        .find(list => String(list.character_id) === id)?.order ?? null;
}

/**
 * Puts the block in the list, or brings its text up to date if it is already there.
 *
 * @param {string} key The extension prompt key, which the identifier is derived from.
 * @param {string} text What the block says now.
 * @param {string} name What the list should call it.
 * @param {number} depth Where to start it. Used only when the entry is created.
 * @returns {boolean} Whether the list now holds the block.
 */
function writeListEntry(key, text, name, depth) {
    const pm = readyManager();
    if (!pm) return false;

    const order = orderFor(pm);
    if (!order) return false;

    const identifier = identifierFor(key);
    let entry = pm.serviceSettings.prompts.find(p => p && p.identifier === identifier) ?? null;
    let added = false;
    let changed = false;

    if (!entry) {
        entry = {
            identifier,
            name,
            role: 'system',
            content: text,
            // Not a system prompt, so it can be detached or deleted like the user's own.
            system_prompt: false,
            marker: false,
            // In-Chat at the depth the extension slot was using, so nothing moves on the
            // way in. Everything below this line is the user's from here on.
            injection_position: INJECTION_POSITION.ABSOLUTE,
            injection_depth: Number.isFinite(depth) ? depth : 0,
            // The bucket extension prompts are joined in, so a block that is listed and one
            // that is not still land together at the same depth.
            injection_order: 100,
            injection_trigger: [],
            forbid_overrides: false,
        };
        pm.serviceSettings.prompts.push(entry);
        added = true;
    } else if (entry.content !== text) {
        // The text is the extension's; the placement is not. Only this is written back.
        entry.content = text;
        changed = true;
    }

    if (!order.some(item => item && item.identifier === identifier)) {
        // At the end rather than the top: an In-Chat block is read last anyway, and a list
        // that opens with somebody else's entry is a worse first impression than a true one.
        order.push({ identifier, enabled: true });
        added = true;
    }

    if (added || changed) saveSettingsDebounced();
    // Only a structural change is worth a redraw - the content is rewritten on every send.
    if (added) pm.render(false);
    return true;
}

/**
 * Takes the block back out of the list.
 *
 * Called only when the setting is switched off, never when the block is merely disabled or
 * empty: a feature turned off and on again should come back where the user put it, so a
 * silent block keeps its entry and empties its text instead. An empty one is skipped by
 * populationInjectionPrompts, which filters on prompt.content.
 *
 * @param {string} key
 * @returns {void}
 */
function removeListEntry(key) {
    const pm = readyManager();
    if (!pm) return;

    const identifier = identifierFor(key);
    let removed = false;

    const at = pm.serviceSettings.prompts.findIndex(p => p && p.identifier === identifier);
    if (at !== -1) {
        pm.serviceSettings.prompts.splice(at, 1);
        removed = true;
    }

    const order = orderFor(pm);
    const orderAt = order
        ? order.findIndex(item => item && item.identifier === identifier)
        : -1;
    if (orderAt !== -1) {
        order.splice(orderAt, 1);
        removed = true;
    }

    if (!removed) return;
    saveSettingsDebounced();
    pm.render(false);
}

/**
 * Sends a writing prompt, or takes it away.
 *
 * @param {string} key The extension prompt key.
 * @param {string} text What to send. Empty sends nothing.
 * @param {{ inList?: boolean, depth?: number, name?: string }} [options]
 *   `inList` hands placement to SillyTavern's prompt list; `depth` is used when it does not,
 *   and as the starting depth of a list entry being created; `name` is what the list calls
 *   it.
 */
export function placeWritingPrompt(key, text, { inList = false, depth = 0, name = key } = {}) {
    const body = String(text ?? '');
    const at = Number(depth);
    const start = Number.isFinite(at) ? at : 0;

    // An earlier build put the block here, which turned out to inject it straight after the
    // main prompt rather than list it. Cleared unconditionally, so no session that ran that
    // version keeps a copy up there.
    setExtensionPrompt(key, '', IN_PROMPT, 0, false);

    const wantsList = inList === true;
    // Only an explicit switch-off deletes the entry. Moving to a backend that has no prompt
    // list must not throw the user's placement away on the way past.
    if (!wantsList) removeListEntry(key);

    if (wantsList && promptListAvailable() && writeListEntry(key, body, name, start)) {
        // The list holds it now. Injecting as well would send it twice.
        setExtensionPrompt(key, '', IN_CHAT, 0, false);
        return;
    }

    if (!body.trim()) {
        setExtensionPrompt(key, '', IN_CHAT, 0, false);
        return;
    }

    setExtensionPrompt(key, body, IN_CHAT, start, false, extension_prompt_roles.SYSTEM);
}
