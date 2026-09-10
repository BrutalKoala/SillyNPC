/**
 * Which CSS rule is doing that to this element.
 *
 * Written for a bug that took five rounds to corner: the HUD portrait was loading
 * perfectly - the right file, decoded, 864 pixels wide - and rendering nothing, because
 * something had set `display: none` on it. Nothing in this extension, in SillyTavern's
 * stylesheets or in the installed theme had a selector that could match it, and there was
 * no way to find out which rule was responsible without devtools.
 *
 * The browser knows. This asks it: every stylesheet, every rule that sets the property,
 * and whether the element matches its selector - which is what the devtools style panel
 * shows in a glance, for somebody who cannot open one.
 *
 * Imports nothing, so the test harness can exercise it against real stylesheets in a real
 * browser. A diagnostic that lies costs more than the bug it was meant to find.
 */

/** Where a rule came from, short enough to read in a data attribute. */
function sheetName(sheet) {
    const href = sheet?.href;
    if (!href) return 'a <style> tag';
    return href.split('/').slice(-2).join('/');
}

/**
 * Every rule that gives `property` the value `value` and matches `el`.
 *
 * @param {Element} el
 * @param {string} property A camelCase CSSStyleDeclaration name, e.g. 'display'.
 * @param {string} value
 * @returns {string[]} Selectors, each with the stylesheet it came from.
 */
export function rulesSetting(el, property, value) {
    const found = [];
    if (!el) return found;

    const scan = (rules, sheet) => {
        for (const rule of rules ?? []) {
            /* Both, never either-or.
             *
             * The first version treated any rule with a `cssRules` property as a
             * container and skipped it - and since CSS nesting arrived, an ordinary
             * style rule *has* a cssRules list. It is empty, and it is truthy, so every
             * plain rule was stepped over and the finder confidently reported "no rule
             * found" for a selector sitting right there. Caught by the harness on its
             * first run, which is the entire reason this module imports nothing. */
            if (rule.selectorText && rule.style?.[property] === value) {
                try {
                    if (el.matches(rule.selectorText)) {
                        found.push(`${rule.selectorText} @ ${sheetName(sheet)}`);
                    }
                } catch { /* a selector this browser will not parse */ }
            }

            /* And into whatever it contains: a media query, a layer, a supports block,
               or a rule nested inside another. A HUD is exactly the sort of thing
               somebody hides at a narrow width. */
            if (rule.cssRules?.length) scan(rule.cssRules, sheet);
        }
    };

    for (const sheet of document.styleSheets) {
        // Reading cssRules on a cross-origin sheet throws; it is not ours anyway.
        try { scan(sheet.cssRules, sheet); } catch { /* cross-origin */ }
    }

    return found;
}

/**
 * A one-line answer to "why can I not see this".
 *
 * The inline style comes first when there is one, because that says JavaScript did it
 * rather than a stylesheet - a different search entirely.
 *
 * @param {HTMLElement} el
 * @returns {string}
 */
export function whyHidden(el) {
    if (!el) return 'no element';

    const found = [];
    if (el.style.display) found.push(`inline:${el.style.display}`);
    if (el.style.visibility) found.push(`inline-vis:${el.style.visibility}`);

    found.push(...rulesSetting(el, 'display', 'none'));
    found.push(...rulesSetting(el, 'visibility', 'hidden'));

    return found.join(' ; ') || 'no rule found';
}
