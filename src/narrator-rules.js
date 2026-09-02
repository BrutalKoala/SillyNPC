import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../../script.js';
import { getSettings } from './settings.js';
import { debugLog } from './constants.js';

/** The key SillyTavern files this injection under. */
export const NARRATOR_RULES_KEY = 'sillynpc-narrator-rules';

/**
 * How the narrator should behave, put where the model will still be reading it.
 *
 * A rule written into a character card or a persona sits at the top of the prompt, and by
 * the time a long chat has been appended underneath it there are thousands of tokens
 * between the instruction and the moment it applies. Rewriting the wording does not fix
 * that; the wording was never the problem. This is the same slot the dialogue format uses
 * for the same reason - depth 0 puts it after the newest message, the last thing read
 * before answering.
 *
 * Nothing is shipped in the box. What the narrator should do is yours to say; the
 * placement is the part this owns. The recommended text in the prompt editor is a
 * starting shape, not a default that gets sent when the box is empty - an empty box here
 * means send nothing, unlike the dialogue format, where empty means the built-in. The
 * difference is that a layout the extension depends on has a right answer and a narrator
 * does not.
 */
export function narratorRulesText() {
    return String(getSettings().narratorRulesPrompt ?? '').trim();
}

/** Puts the narrator rules in front of the model, or takes them away. */
export function applyNarratorRulesPrompt() {
    const settings = getSettings();
    const text = narratorRulesText();
    // No guard for empty text: sending an empty string is already sending nothing, and a
    // condition that changes nothing observable is decoration rather than a safeguard.
    const off = !settings.enabled || !settings.narratorRulesEnabled;

    if (off) {
        setExtensionPrompt(NARRATOR_RULES_KEY, '', extension_prompt_types.IN_CHAT, 0, false);
        return;
    }

    const depth = Number(settings.narratorRulesDepth ?? 0);
    setExtensionPrompt(
        NARRATOR_RULES_KEY,
        text,
        extension_prompt_types.IN_CHAT,
        Number.isFinite(depth) ? depth : 0,
        false,
        extension_prompt_roles.SYSTEM,
    );
    if (text) debugLog(`Narrator rules sent at depth ${depth}`);
}
