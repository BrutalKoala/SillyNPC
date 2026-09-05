import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles, main_api } from '../../../../../script.js';

/**
 * Which of SillyTavern's two injection slots a writing prompt goes into.
 *
 * The choice is not about position for its own sake, it is about whether the block appears in
 * AI Response Configuration -> Prompts, where it can be reordered and re-depthed alongside
 * everything else. SillyTavern lists an extension prompt there automatically, but only from
 * two positions (openai.js, preparePromptsForChatCompletion):
 *
 *     if (![BEFORE_PROMPT, IN_PROMPT].includes(prompt.position)) continue;
 *
 * IN_CHAT is skipped, which is the entire reason the dialogue format and the narrator rules
 * were invisible there while the ban list, which uses IN_PROMPT, was not.
 *
 * Once listed the entry is fully editable - isPromptEditAllowed refuses only markers - and
 * SillyTavern reads back whatever position, depth, order and role the user sets and applies
 * them over the extension's own. So handing a block over means handing over its placement
 * too, which is the point.
 *
 * Both slots are written on every call, one of them with nothing. setExtensionPrompt is keyed
 * by name and position together, so moving a block between slots without emptying the one it
 * came from leaves it in the prompt twice - once where it used to be and once where it now
 * is, saying the same thing.
 */

/** The slots a writing prompt can occupy. */
const IN_CHAT = extension_prompt_types.IN_CHAT;
const IN_PROMPT = extension_prompt_types.IN_PROMPT;

/**
 * Whether SillyTavern's prompt list exists at all right now.
 *
 * It is a Chat Completion feature. On Text Completion there is no list to appear in, and
 * IN_PROMPT lands somewhere else entirely with no way to correct it - so the offer is only
 * made where it can be kept.
 *
 * @returns {boolean}
 */
export function promptListAvailable() {
    return main_api === 'openai';
}

/**
 * Sends a writing prompt, or takes it away.
 *
 * @param {string} key The extension prompt key.
 * @param {string} text What to send. Empty removes it from both slots.
 * @param {{ inList?: boolean, depth?: number }} [options]
 *   `inList` hands placement to SillyTavern's prompt list; `depth` is used only when it does
 *   not, since the list owns depth once it owns the entry.
 */
export function placeWritingPrompt(key, text, { inList = false, depth = 0 } = {}) {
    const body = String(text ?? '');
    // The list is Chat Completion's. Asking for it elsewhere would move the block somewhere
    // worse and offer nothing in return.
    const listed = inList && promptListAvailable();

    const wanted = listed ? IN_PROMPT : IN_CHAT;
    const other = listed ? IN_CHAT : IN_PROMPT;

    // The slot being vacated, first and always - including when there is nothing to send,
    // which is how turning a block off leaves nothing behind wherever it used to be.
    setExtensionPrompt(key, '', other, 0, false);

    if (!body.trim()) {
        setExtensionPrompt(key, '', wanted, 0, false);
        return;
    }

    const at = Number(depth);
    setExtensionPrompt(
        key,
        body,
        wanted,
        // Depth means nothing to IN_PROMPT, and passing the extension's own would be a
        // number with no effect sitting where a reader expects one that matters.
        listed ? 0 : (Number.isFinite(at) ? at : 0),
        false,
        extension_prompt_roles.SYSTEM,
    );
}
