import { getTokenCountAsync, guesstimate } from '../../../../tokenizers.js';
import { debugLog } from './constants.js';

/**
 * How many tokens a piece of text costs.
 *
 * SillyTavern's counter asks the backend, which is exact but can be unavailable - no
 * tokenizer for the selected API, a server that is not answering, a model it does not
 * know. Rather than show nothing in that case, it falls back to the same rough
 * bytes-per-token estimate SillyTavern itself uses, and says which one you are looking at.
 * A number with a "roughly" next to it is more use than an empty space.
 *
 * @param {string} text
 * @returns {Promise<{ count: number, estimated: boolean }>}
 */
export async function countTokens(text) {
    const body = String(text ?? '');
    if (!body) return { count: 0, estimated: false };

    try {
        const count = await getTokenCountAsync(body);
        // A tokenizer that answers with nothing usable is not an answer. Guarded because
        // a zero here would read as "this prompt is free", which is the one number that
        // is certainly wrong for a non-empty prompt.
        if (Number.isFinite(count) && count > 0) return { count, estimated: false };
    } catch (err) {
        debugLog('Token count unavailable, estimating instead', err);
    }

    return { count: Math.max(1, Math.round(guesstimate(body))), estimated: true };
}

/**
 * The token line under a prompt editor.
 *
 * Counting asks the server, so it is debounced and the last answer is left on screen
 * while the next one is in flight - a number that blanks on every keystroke is harder to
 * read than one that lags a moment behind.
 *
 * @param {() => string} readText What is currently in the box.
 * @param {{ note?: string }} [options] `note` is appended when the box is empty and empty
 *   means something other than "send nothing".
 * @returns {{ element: HTMLElement, refresh: () => void }}
 */
export function buildTokenReadout(readText, { note = '' } = {}) {
    const element = document.createElement('small');
    element.className = 'notes sillynpc-token-count';
    element.textContent = 'Counting tokens...';

    let timer = null;
    let generation = 0;

    const run = async () => {
        const mine = ++generation;
        const text = String(readText() ?? '');
        const { count, estimated } = await countTokens(text);
        // An answer that arrived after a newer request started is stale, and writing it
        // would show a count for text that is no longer in the box.
        if (mine !== generation) return;

        const number = count.toLocaleString();
        const prefix = estimated ? `Roughly ${number} tokens` : `${number} tokens`;
        element.textContent = (!text.trim() && note) ? `Empty. ${note}` : prefix;
        element.classList.toggle('is-estimate', estimated);
    };

    const refresh = () => {
        clearTimeout(timer);
        timer = setTimeout(run, 300);
    };

    run();
    return { element, refresh };
}
