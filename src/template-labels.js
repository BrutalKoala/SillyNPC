/**
 * Finding labels that were written into the display template by hand.
 *
 * A template says `HP [{{Health}}]`. The braces are the hole the value goes in; `HP [` and
 * `]` are characters either side of it. So the tracker reads "HP" while the field, the
 * character page and everything else read "Health", and no amount of renaming fixes it -
 * a rename moves references, and this is prose.
 *
 * Deliberately free of imports so it can be tested as what it is: string surgery.
 */

/** Letters, digits and underscore, for the lookaround that stops a match mid-word. */
const WORD = '\\p{L}\\p{N}_';

/** What may appear in a label: a word, possibly several, possibly with a slash. */
const LABEL = '[\\p{L}\\p{N}][\\p{L}\\p{N} /]{0,24}?';

/** Escapes a field name for use inside a pattern. */
function escapeForPattern(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every hand-written label sitting against a field reference.
 *
 * The label has to be *adjacent* to the reference - only whitespace, a colon or an opening
 * bracket may come between. That is what keeps this away from things that merely look
 * similar: `<b>Location:</b> {{Location}}` has a closing tag in the way and is left alone,
 * which is right, because a global whose Format is `{{value}}` would otherwise lose its
 * only label.
 *
 * Section tags are never touched. `{{#Condition}}` and `{{/Condition}}` are structure, and
 * the text before them is usually a separator rather than a caption.
 *
 * @param {string} template
 * @param {string[]} fieldNames The stat names actually configured.
 * @returns {{ start: number, end: number, field: string, label: string, before: string,
 *   after: string, replacement: string, likely: boolean }[]} In document order.
 */
export function findTemplateLabels(template, fieldNames) {
    const text = String(template ?? '');
    const names = [...new Set((fieldNames || []).map(n => String(n ?? '').trim()).filter(Boolean))];

    const found = [];
    for (const field of names) {
        const reference = `\\{\\{${escapeForPattern(field)}\\}\\}`;
        const pattern = new RegExp(
            `(?<![${WORD}])(${LABEL})(\\s*\\[\\s*|\\s*:\\s*|\\s+)${reference}`,
            'gu');

        for (const match of text.matchAll(pattern)) {
            const [whole, label, separator] = match;
            const opened = separator.includes('[');
            let end = match.index + whole.length;

            if (opened) {
                // A bracket that is opened has to be closed right here, or it belongs to
                // something else - an attribute, a link, an array - and the text is not
                // the shape it looks like.
                if (text[end] !== ']') continue;
                end += 1;
            }
            // Only a bracket this match opened is taken. A stray `]` after `HP: {{X}}`
            // belongs to whatever came before, and swallowing it would delete a character
            // the replacement does not put back.

            found.push({
                start: match.index,
                end,
                field,
                label: label.trim(),
                before: text.slice(match.index, end),
                after: `{{${field}}}`,
                replacement: `{{${field}}}`,
                // A colon or a bracket is punctuation somebody chose to caption a value
                // with. A bare word before a reference might just as easily be a sentence,
                // so it is offered without being assumed.
                likely: opened || separator.includes(':'),
            });
        }
    }

    found.sort((a, b) => a.start - b.start);

    // Two fields can in principle claim overlapping text. Keeping the first and dropping
    // the rest means an apply can never splice halfway through another match.
    const kept = [];
    for (const item of found) {
        if (kept.length && item.start < kept[kept.length - 1].end) continue;
        kept.push(item);
    }
    return kept;
}

/**
 * Removes the chosen labels, leaving the reference behind.
 *
 * Applied from the end backwards so that every offset still describes the string it was
 * measured against.
 *
 * @param {string} template
 * @param {{ start: number, end: number, replacement: string }[]} fixes
 * @returns {string}
 */
export function applyLabelFixes(template, fixes) {
    let out = String(template ?? '');
    const ordered = [...(fixes || [])].sort((a, b) => b.start - a.start);
    for (const fix of ordered) {
        out = out.slice(0, fix.start) + fix.replacement + out.slice(fix.end);
    }
    return out;
}
