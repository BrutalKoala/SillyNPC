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
 * Catches whoever sets `display` inline on an element, and remembers where they were.
 *
 * The last unknown in a bug that has taken six rounds: the HUD portrait ends up with an
 * inline `display: none` that no stylesheet accounts for, so some JavaScript is doing it -
 * and neither this extension, SillyTavern nor the installed theme has a line that
 * obviously would. A MutationObserver can say the attribute changed but not who changed
 * it; the callback runs later, on its own stack.
 *
 * An own property on the element's style object shadows the prototype's accessor, so the
 * assignment can be caught synchronously - and `new Error().stack` inside the setter is
 * the caller's stack, which is the entire question.
 *
 * The value is always applied. This watches; it does not defend.
 *
 * @param {HTMLElement} el
 * @param {(value: string, stack: string) => void} report
 */
export function trapInlineDisplay(el, report) {
    if (!el || el.dataset.displayTrapped === 'true') return;
    el.dataset.displayTrapped = 'true';

    Object.defineProperty(el.style, 'display', {
        configurable: true,
        get() { return this.getPropertyValue('display'); },
        set(value) {
            // setProperty rather than the shadowed accessor, or this calls itself.
            this.setProperty('display', value);
            try { report(String(value), new Error().stack ?? ''); } catch { /* never break a write */ }
        },
    });
}

/**
 * The frames of a stack that are not this trap, shortened to something readable.
 *
 * Everything is one long file path in a browser, and a data attribute has to stay a line
 * somebody can look at.
 *
 * The **first frame outside a library comes first**, because it is the answer and the
 * frames above it are not. The first reading of this reported three frames and all three
 * were jQuery's own `hide` machinery - true, and useless: what nobody could see was which
 * line called it. Anything under a lib/ directory is somebody else's plumbing.
 *
 * The library frames are kept after it rather than dropped, since "jQuery hide" and
 * "jQuery fadeOut's completion" are different answers and the chain is what tells them
 * apart.
 */
export function shortenStack(stack, frames = 10) {
    const lines = String(stack ?? '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('at ') && !line.includes('css-origin.js'))
        .map(line => line.replace(/^at\s+/, '').replace(/https?:\/\/[^/]+\//, ''));

    if (!lines.length) return 'no stack';

    const isLibrary = (line) => line.includes('lib/') || line.includes('node_modules');
    const caller = lines.findIndex(line => !isLibrary(line));

    const ordered = caller > 0
        ? [`CALLER: ${lines[caller]}`, ...lines.slice(0, caller), ...lines.slice(caller + 1)]
        : lines;

    return ordered.slice(0, frames).join(' <- ');
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
