import { getSettings, defaultSettings, recommendedImagePrompt } from './settings.js';
import { SYSTEM_PROMPT, DIALOGUE_FORMAT_PROMPT, NARRATOR_RULES_PROMPT } from './constants.js';

/**
 * Every prompt the user can edit, in one list.
 *
 * The Prompts tab shows all of them together; each also stays where it has always been,
 * beside the settings it belongs with. Both render from this list rather than from two
 * copies of the same wording, so a help text corrected in one place is corrected in the
 * other - which is the failure a "just copy it over" mirror would have introduced on the
 * first edit.
 *
 * `available` decides whether an entry applies to the current setup at all: the negative
 * prompt is Stable Diffusion's, the reference instruction is Gemini's, and the system
 * rules only reach a model in inline mode. An entry that cannot be sent is not shown as
 * one that can.
 *
 * @type {Array<{
 *   id: string, key: string, label: string, help: string, home: string,
 *   recommended?: () => string, emptyNote?: string, available?: () => boolean,
 *   budget?: { key: string, label: string, help: string, kind: 'number'|'slider',
 *              min?: number, max?: number, step?: number, suffix?: string },
 * }>}
 */
export const PROMPTS = [
    {
        id: 'dialogueFormat',
        key: 'dialogueFormatPrompt',
        label: 'Dialogue Format',
        home: 'Settings',
        help: 'Sent with every message, telling the story model how to lay dialogue out. '
            + 'Avatars, speech blocks and character colours all read a speaker line - a '
            + 'name in bold followed by a colon - so this is what makes them work. It asks '
            + 'for no colour tags on purpose: the extension colours dialogue itself, and a '
            + 'colour written into the reply would override the one you chose.',
        recommended: () => DIALOGUE_FORMAT_PROMPT,
        emptyNote: 'The built-in format is sent.',
        available: () => getSettings().dialogueFormatEnabled,
    },
    {
        id: 'narratorRules',
        key: 'narratorRulesPrompt',
        label: 'Narrator Rules',
        home: 'Settings',
        help: 'Sent with every message, at the depth you choose. This is for the rules a '
            + 'narrator keeps breaking - speaking or acting for you, recapping, wrapping '
            + 'the scene up, summarising instead of writing it. In a character card those '
            + 'sit at the top of the prompt with the whole chat between them and the moment '
            + 'they apply; rewording one does not help, moving it does. Empty means nothing '
            + 'is sent.',
        recommended: () => NARRATOR_RULES_PROMPT,
        emptyNote: 'Nothing is sent.',
        available: () => getSettings().narratorRulesEnabled,
    },
    {
        id: 'lore',
        key: 'generationPrompt',
        label: 'Lore Prompt Template',
        home: 'Generation',
        help: 'Placeholders: [NAME], [LORE] for the existing entry, [FACTS] for what the '
            + 'tracker already records about them, [CONTEXT] for recent chat, [WORLD] for '
            + 'what the Data Bank search found.',
        recommended: () => defaultSettings.generationPrompt,
        budget: {
            key: 'loreMaxTokens',
            label: 'Lore Reply Budget',
            suffix: 'tokens',
            kind: 'number',
            help: 'Maximum tokens the lore writer may reply with. The default prompt asks for six '
                + 'sections, which 500 tokens could not hold. No ceiling - set it to whatever '
                + 'your model and your patience allow.',
        },
    },
    {
        id: 'extraction',
        key: 'statusTracker.extractionPrompt',
        label: 'Extraction Instructions',
        home: 'Tracker',
        help: 'What the reader is told before it is shown the current state and the '
            + 'message. Your collections and their fields are sent separately and are '
            + 'added whatever you write here, so rewriting this cannot cost the reply '
            + 'its field list.',
        recommended: () => SYSTEM_PROMPT,
        emptyNote: 'The built-in instructions are sent.',
        available: () => getSettings().statusTracker.extractionMode === 'extract',
        budget: {
            key: 'statusTracker.extractionMaxTokens',
            label: 'Extraction Reply Budget',
            kind: 'slider',
            min: 300, max: 4000, step: 100,
            help: 'Raise this if updates come back truncated while tracking many stats.',
        },
    },
    {
        id: 'systemRules',
        key: 'statusTracker.systemRules',
        label: 'System Rules & Logic',
        home: 'Tracker',
        help: 'Added to the story prompt, telling the narrator how your system works. '
            + 'Only used by the inline mode - the separate pass reads events rather '
            + 'than being told rules.',
        recommended: () => defaultSettings.statusTracker.systemRules,
        available: () => getSettings().statusTracker.extractionMode !== 'extract',
    },
    {
        id: 'image',
        key: 'imgGenPrompt',
        label: 'Image Prompt Template',
        home: 'Generation',
        help: 'Placeholders: [NAME], [LORE] for the entry text, [ITEMS] for what they '
            + 'carry, [CONTEXT] for recent chat. Leave empty to use the template that '
            + 'suits your backend - description for Gemini, tags for Stable Diffusion.',
        recommended: () => recommendedImagePrompt(),
        emptyNote: "Your backend's own template is sent.",
    },
    {
        id: 'imageReference',
        key: 'imgGenReferencePreamble',
        label: 'Reference Instruction',
        home: 'Generation',
        help: 'Sent only when you generate with a reference image, and always placed '
            + 'BEFORE the template above - so write it pointing forward, at "the '
            + 'description below". Wording that sends the model looking the other way is '
            + 'a good way to get an answer in words instead of a picture, which is the '
            + 'very thing this exists to prevent: without it the model sees a picture '
            + 'beside a description of that picture and asks what you would like changed. '
            + 'Clear it to send the template alone.',
        recommended: () => defaultSettings.imgGenReferencePreamble,
        available: () => getSettings().imageBackend === 'gemini',
    },
    {
        id: 'imageNegative',
        key: 'imgGenNegativePrompt',
        label: 'Negative Prompt',
        home: 'Generation',
        help: 'What the image must not contain. Stable Diffusion only - Gemini takes '
            + 'these as instructions in the prompt itself instead.',
        recommended: () => defaultSettings.imgGenNegativePrompt,
        available: () => getSettings().imageBackend !== 'gemini',
    },
];

/**
 * @param {string} id
 * @returns {object} The entry, or throws - a typo naming a prompt that does not exist
 *   would otherwise render an empty box bound to nothing, which looks like a working
 *   setting that quietly discards what you type into it.
 */
export function promptById(id) {
    const found = PROMPTS.find(p => p.id === id);
    if (!found) throw new Error(`Unknown prompt: ${id}`);
    return found;
}

/** The entries that apply to the current setup. */
export function availablePrompts() {
    return PROMPTS.filter(p => !p.available || p.available());
}
