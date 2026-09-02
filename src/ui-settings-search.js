import { getSettings } from './settings.js';

/**
 * Finding a setting without knowing which page it is on.
 *
 * Eighty-one of them across ten pages. Knowing what you want to change is the easy part;
 * remembering whether it lives under Tracker or Writing Rules is not, and reorganising the
 * menu - however much better the new arrangement is - moved every one of them at least
 * once.
 *
 * The index is built by drawing each page into a container that is never shown and reading
 * back what appeared, rather than from a list written by hand beside the real one. A hand
 * list is the same setting described twice, and the two disagree the first time anybody
 * adds a control without noticing there was a second place to add it.
 */

/** A control's own label, taken from the wrap that carries its key. */
function labelWithin(wrap) {
    for (const el of walk(wrap)) {
        const cls = String(el?.className || '');
        // Most controls name themselves on a label; a text area does it on the row.
        if (cls.includes('sillynpc-setting-label') || cls === 'sillynpc-setting-row') {
            const text = String(el.textContent || '').trim();
            if (text) return text;
        }
    }
    return '';
}

/** Every element under one, itself included. */
function* walk(node) {
    if (!node || typeof node !== 'object') return;
    yield node;
    for (const kid of node.children || []) yield* walk(kid);
}

/**
 * What is on each page, as a flat list.
 *
 * @param {Array<{ id: string, label: string, render: (view: HTMLElement) => void }>} tabs
 * @returns {Array<{ key: string, label: string, tab: string, tabLabel: string, advanced: boolean }>}
 */
export function buildSettingsIndex(tabs) {
    const found = [];
    const seen = new Set();

    for (const tab of tabs) {
        const view = document.createElement('div');
        try {
            tab.render(view);
        } catch {
            // A page that cannot be drawn offscreen is one the search cannot list. Better
            // a shorter list than no search at all.
            continue;
        }

        for (const el of walk(view)) {
            const key = el?.dataset?.setting;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            found.push({
                key,
                label: labelWithin(el) || key,
                tab: tab.id,
                tabLabel: tab.label,
                advanced: el.dataset?.advanced === 'true',
            });
        }
    }

    return found;
}

/**
 * The entries worth offering for what has been typed.
 *
 * Matched on the label first and the key second: you search for what the control is
 * called, but the key is what a bug report or a comment names it by.
 *
 * A setting hidden behind dev mode is left out while dev mode is off. Offering to jump to
 * a control that is not on the page would be worse than not finding it.
 *
 * @param {Array<object>} index From buildSettingsIndex.
 * @param {string} query
 * @param {{ limit?: number, devMode?: boolean }} [options]
 */
export function searchSettings(index, query, { limit = 8, devMode } = {}) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (needle.length < 2) return [];

    const showAdvanced = devMode ?? !!getSettings().devMode;

    const scored = [];
    for (const entry of index) {
        if (entry.advanced && !showAdvanced) continue;

        const label = entry.label.toLowerCase();
        const key = entry.key.toLowerCase();
        // A label starting with what you typed is what you meant more often than one
        // merely containing it, so it goes first.
        if (label.startsWith(needle)) scored.push([0, entry]);
        else if (label.includes(needle)) scored.push([1, entry]);
        else if (key.includes(needle)) scored.push([2, entry]);
    }

    return scored
        .sort((a, b) => a[0] - b[0] || a[1].label.localeCompare(b[1].label))
        .slice(0, limit)
        .map(([, entry]) => entry);
}

/**
 * The box, and the list of answers under it.
 *
 * @param {object} options
 * @param {() => Array<object>} options.index Built lazily: drawing ten pages to answer a
 *   search nobody has typed yet is work for nothing.
 * @param {(entry: object) => void} options.onPick
 * @returns {HTMLElement}
 */
export function buildSettingsSearch({ index, onPick }) {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-settings-search';

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'text_pole sillynpc-settings-search-input';
    input.placeholder = 'Find a setting…';
    input.title = 'Searches every page by what a control is called.';

    const results = document.createElement('div');
    results.className = 'sillynpc-settings-search-results';
    results.style.display = 'none';

    let cached = null;

    const close = () => { results.replaceChildren(); results.style.display = 'none'; };

    const run = () => {
        const query = input.value;
        if (String(query ?? '').trim().length < 2) { close(); return; }

        if (!cached) cached = index();
        const hits = searchSettings(cached, query);

        results.replaceChildren();
        if (!hits.length) {
            const none = document.createElement('div');
            none.className = 'sillynpc-settings-search-none notes';
            none.textContent = getSettings().devMode
                ? 'No setting by that name.'
                : 'No setting by that name. Some are hidden until Show Every Setting is on.';
            results.append(none);
        }

        for (const entry of hits) {
            const hit = document.createElement('button');
            hit.type = 'button';
            hit.className = 'sillynpc-settings-search-hit';

            const label = document.createElement('span');
            label.className = 'sillynpc-settings-search-label';
            label.textContent = entry.label;

            // Which page, because half of what makes this useful is learning where things
            // are rather than being taken there blind every time.
            const where = document.createElement('span');
            where.className = 'sillynpc-settings-search-where';
            where.textContent = entry.tabLabel;

            hit.append(label, where);
            hit.addEventListener('click', () => { close(); input.value = ''; onPick(entry); });
            results.append(hit);
        }
        results.style.display = '';
    };

    input.addEventListener('input', run);
    input.addEventListener('search', run);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; close(); } });

    wrap.append(input, results);
    return wrap;
}
