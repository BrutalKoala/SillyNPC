import { substituteParamsExtended } from '../../../../../script.js';
import { debugLog } from './constants.js';
import { escapeRegExp } from './utils.js';

/**
 * Macros in the prompts you can edit.
 *
 * Two things were true and neither was obvious. SillyTavern's macros - {{user}}, {{char}},
 * {{persona}}, {{time}}, {{roll:d20}}, {{getvar::x}} and the rest - worked in the dialogue
 * format and the narrator rules, because those go out through SillyTavern's own injection
 * and it runs substituteParams over anything it sends. They worked nowhere else, because
 * every other prompt here is sent straight to a model by the extension and SillyTavern
 * never sees it. And the extension's own placeholders - [NAME], [LORE], [CONTEXT] and
 * friends - were plain String.replace calls in two functions, so they worked in exactly
 * the two boxes those functions read.
 *
 * One mechanism now. Every editable prompt goes through applyMacros before it is sent, so
 * SillyTavern's macros work everywhere, and the extension's own values are handed over as
 * dynamic macros in the same {{...}} spelling. [NAME] still works: the old spelling is
 * rewritten to the new one first, which is also what keeps the substitution to one pass.
 *
 * What a prompt can offer depends on what it knows. A profile hint has one subject and can
 * offer {{name}}; the extraction instructions describe a whole scene and cannot. A macro
 * with no value in a given box is left standing rather than blanked - that is
 * SillyTavern's own behaviour for a name it does not recognise, and it means a template
 * pasted into the wrong box shows you what went missing instead of quietly losing it.
 */

/**
 * Rewrites the extension's old [TAG] spelling into SillyTavern's {{tag}}.
 *
 * Done to the template before anything is substituted, so both spellings are resolved in
 * the same pass. That is not tidiness: a [NAME] inside a value being pasted in - a chat
 * excerpt, a lore entry - must not be treated as a placeholder, and running the two passes
 * separately is precisely how it would be.
 *
 * @param {string} text
 * @param {string[]} names The macro names this prompt offers, lowercase.
 * @returns {string}
 */
export function modernisePlaceholders(text, names) {
    let out = String(text ?? '');
    for (const name of names) {
        /* Escaped, because a name goes straight into a pattern here. Every key passed today
           is a hardcoded literal - name, lore, items, context, world, facts - so this has
           never mattered; it is guarded because offering a stat name as a macro is an
           obvious next step, and a stat called "HP (max)" would make new RegExp throw.
           applyMacros is wrapped in try/catch precisely so a bad macro cannot take the
           request with it, and this function is not - the throw would escape fillTemplate
           and reach the caller. */
        out = out.replace(new RegExp(`\\[${escapeRegExp(name.toUpperCase())}\\]`, 'g'), `{{${name}}}`);
    }
    return out;
}

/**
 * Resolves every macro in one piece of text the user wrote.
 *
 * @param {string} text
 * @param {Record<string, string>} [own] This prompt's own values, offered as {{key}}.
 *   A macro SillyTavern has registered under the same name wins - populateEnv writes over
 *   the passed-in environment - so these are additions, not overrides.
 * @returns {string}
 */
export function applyMacros(text, own = {}) {
    const body = String(text ?? '');
    // Nothing to resolve, and no reason to walk several dozen regexes over a long prompt.
    if (!body.includes('{{')) return body;

    try {
        return substituteParamsExtended(body, own);
    } catch (err) {
        // A macro that throws must not take the request with it. Sending the text as
        // written is wrong in one place; sending nothing is wrong everywhere.
        debugLog('A macro could not be resolved - sending the text as written', err);
        return body;
    }
}

/**
 * Both steps, for a prompt that has placeholders of its own.
 *
 * @param {string} text
 * @param {Record<string, string>} own
 * @returns {string}
 */
export function fillTemplate(text, own) {
    return applyMacros(modernisePlaceholders(text, Object.keys(own)), own);
}
