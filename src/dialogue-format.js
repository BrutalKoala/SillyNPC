import { placeWritingPrompt } from './prompt-slot.js';
import { getSettings } from './settings.js';
import { DIALOGUE_FORMAT_PROMPT, debugLog } from './constants.js';

/** The key SillyTavern files this injection under. */
export const DIALOGUE_FORMAT_KEY = 'sillynpc-dialogue-format';

/**
 * What is actually sent: the user's text if they have written any, the built-in if not.
 *
 * Empty means the built-in rather than "send nothing", which is the same rule the
 * extraction instructions follow. Someone who wants none of it turns the setting off;
 * clearing the box is how you ask for the default back.
 *
 * @returns {string}
 */
export function dialogueFormatText() {
    const settings = getSettings();
    return String(settings.dialogueFormatPrompt ?? '').trim() || DIALOGUE_FORMAT_PROMPT;
}

/**
 * Puts the dialogue format in front of the model, or takes it away.
 *
 * Deliberately not part of the tracker's own generation handler: that one returns early
 * when the tracker is off, and the chat is still decorated then. The formatting the
 * decorator depends on must not be conditional on a feature that has nothing to do with
 * it - which is the whole fault being fixed here, one layer up. It used to depend on the
 * user's persona.
 *
 * Depth 0 puts it after the newest message, the last thing the model reads before
 * answering, because a layout rule is weakest when it is furthest away. Handing the block to
 * SillyTavern's prompt list gives that decision away in exchange for being able to make it
 * anywhere else; see placeWritingPrompt.
 */
export function applyDialogueFormatPrompt() {
    const settings = getSettings();
    const off = !settings.enabled || !settings.dialogueFormatEnabled;

    placeWritingPrompt(DIALOGUE_FORMAT_KEY, off ? '' : dialogueFormatText(), {
        inList: settings.dialogueFormatInPromptList === true,
        depth: Number(settings.dialogueFormatDepth ?? 0),
    });

    if (off) return;
    debugLog(settings.dialogueFormatInPromptList === true
        ? "Dialogue format handed to SillyTavern's prompt list"
        : `Dialogue format sent at depth ${Number(settings.dialogueFormatDepth ?? 0)}`);
}
