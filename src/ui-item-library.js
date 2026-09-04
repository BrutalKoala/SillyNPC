import { POPUP_TYPE, Popup } from '../../../../popup.js';
import { isStaticField } from './constants.js';
import { getSettings, saveSettings } from './settings.js';
import { escapeHtml } from './utils.js';
import { updateExtensionTheme, repositionCloseButton } from './ui-shared.js';
import { buildBulkBar, buildBulkCheckbox } from './ui-bulk-select.js';
import {
    loadStateFromMetadata,
    saveStateToMetadata,
    updateMasterItem,
    renameMasterItem,
    deleteMasterItem,
} from './status-logic.js';
import { eventSource } from '../../../../events.js';
import {
    getItemRules, clearItemRule, DISMISSED_KEY, PROTECTED_KEY, PLAYER_ACTOR,
} from './status-review.js';

/**
 * The Entry Library — a view onto settings.master_items.
 *
 * The Master Database silently remembers the static fields of every item the AI has
 * ever mentioned, so a "Gold Coin" keeps its description across chats. Until now
 * nothing could display it, which meant near-duplicates ("The Eldritch Bloodline
 * Curse", "... (Innate)", "... (Harmonized)") accumulated invisibly and could not be
 * merged or removed.
 *
 * Also surfaces tombstones: state.recently_deleted suppresses a dropped item for a few
 * messages so the model cannot immediately re-add it, which is otherwise indistinguishable
 * from the item simply failing to come back.
 */

/** Fields the Master Database actually stores. Shares its rule with updateMasterItem. */
function staticFieldsOf(colDef) {
    return (colDef?.fields || []).filter(isStaticField);
}

function primaryFieldName(colDef) {
    return (colDef?.fields || []).find(f => f.isPrimary)?.name || 'name';
}

/**
 * Item names (lowercased) currently held by any actor in the active chat, per collection.
 * @returns {Record<string, Set<string>>}
 */
function referencedItemNames() {
    const out = {};
    let state;
    try { state = loadStateFromMetadata(); } catch { return out; }
    if (!state) return out;

    const settings = getSettings().statusTracker;
    const actors = [state.player, ...(state.characters || [])].filter(Boolean);
    for (const actor of actors) {
        for (const [colId, items] of Object.entries(actor.collections || {})) {
            const colDef = (settings.collections || []).find(c => c.id === colId);
            const primary = primaryFieldName(colDef);
            out[colId] ||= new Set();
            for (const item of items || []) {
                const name = item?.[primary] ?? item?.name;
                if (name) out[colId].add(String(name).toLowerCase());
            }
        }
    }
    return out;
}

function countItems(master) {
    return Object.values(master).reduce((n, items) => n + Object.keys(items || {}).length, 0);
}

/**
 * The id a remembered item is selected by.
 *
 * A pair, because a key is only unique within its collection. Joined with a unit
 * separator rather than a space: item names contain spaces, so splitting on one tore
 * "gold coin" in half and the delete then looked for an item that did not exist.
 *
 * The constant is the actual fix. The join and the split had drifted to different
 * characters and nothing could tell - the id looked right in every message about it.
 */
// Character 31, the ASCII unit separator - it cannot appear in a collection id or an
// item name. Built with fromCharCode rather than written literally: the first version of
// this line held a raw control byte, which made the whole file read as binary to grep and
// diff, and that is what let the mismatched split sit there unnoticed.
const ID_SEPARATOR = String.fromCharCode(31);
export const itemId = (colId, key) => `${colId}${ID_SEPARATOR}${key}`;

/** The collection and key an id was built from, or empty strings if it was not one. */
export function splitItemId(id) {
    const at = String(id ?? '').indexOf(ID_SEPARATOR);
    if (at < 0) return { colId: '', key: '' };
    return { colId: String(id).slice(0, at), key: String(id).slice(at + ID_SEPARATOR.length) };
}

/**
 * The items a filter leaves on screen, in the order they are shown.
 *
 * Shared by the drawing and by Select all, so "all" can only ever mean what is visible.
 * Ticking rows the filter is hiding is how somebody deletes something they never saw.
 *
 * @returns {Array<{colId: string, key: string}>}
 */
function visibleItems(master, collections, needle) {
    const out = [];
    for (const colDef of collections || []) {
        const items = master[colDef.id] || {};
        const keys = Object.keys(items)
            .filter(k => !needle || k.includes(needle) || JSON.stringify(items[k]).toLowerCase().includes(needle))
            .sort();
        for (const key of keys) out.push({ colId: colDef.id, key });
    }
    return out;
}

/**
 * The library's bulk-select handle, and the filter Select all has to respect.
 *
 * Module-level because render() rebuilds the whole panel on every change - including the
 * change of entering bulk mode - so a handle owned by render would forget the selection
 * the moment the first box was ticked.
 */
let libraryBulk = null;
let libraryFilter = '';

export async function openItemLibrary() {
    const container = document.createElement('div');
    container.className = 'sillynpc sillynpc-manage sillynpc-item-library';
    container.style.padding = '20px';
    container.style.height = '100%';
    container.style.overflowY = 'auto';

    // Everything is drawn into a child, and the popup's close button is put on the parent.
    //
    // repositionCloseButton does not style the X where it sits - it moves the node into
    // whatever element it is given. This panel redraws itself constantly (a delete, a
    // purge, a rename, every keystroke in the filter box) and each redraw starts with
    // replaceChildren, so with the X inside that element the first delete destroyed the
    // only visible way out. Escape still worked, which is why it read as a trap rather
    // than looking like one.
    const content = document.createElement('div');
    container.appendChild(content);

    libraryFilter = '';
    libraryBulk = buildBulkBar({
        noun: 'entry',
        plural: 'entries',
        verb: 'Forget',
        allIds: () => visibleItems(
            getSettings().master_items || {},
            getSettings().statusTracker.collections,
            libraryFilter.trim().toLowerCase(),
        ).map(({ colId, key }) => itemId(colId, key)),
        onDelete: (ids) => {
            const master = getSettings().master_items || {};
            let forgotten = 0;
            for (const id of ids) {
                const { colId, key } = splitItemId(id);
                if (!master[colId]?.[key]) continue;
                deleteMasterItem(colId, key);
                forgotten++;
            }
            // What happened, not what was asked for. Reporting the size of the selection
            // is how a delete that quietly matched nothing still claimed to have worked.
            if (forgotten === ids.length) {
                toastr.success(`Forgot ${forgotten} entr${forgotten === 1 ? 'y' : 'ies'}.`, 'SillyNPC');
            } else {
                toastr.warning(
                    `Forgot ${forgotten} of ${ids.length} selected - the rest were no longer there.`,
                    'SillyNPC');
            }
        },
        onRefresh: () => render(content, libraryFilter),
    });

    render(content);

    const settings = getSettings();
    const isMobile = window.innerWidth <= 768;
    const width = isMobile ? 95 : (settings.popupWidth ?? 80);
    const height = isMobile ? 90 : (settings.popupHeight ?? 80);

    const popup = new Popup(container, POPUP_TYPE.DISPLAY, '', {
        allowVerticalScrolling: true,
        onOpen: (p) => {
            if (p.dlg) {
                p.dlg.style.setProperty('width', `${width}vw`, 'important');
                p.dlg.style.setProperty('max-width', '98vw', 'important');
                p.dlg.style.setProperty('height', `${height}vh`, 'important');
                p.dlg.style.setProperty('max-height', '98vh', 'important');
                if (isMobile) p.dlg.style.setProperty('margin', '2vh auto', 'important');
            }
            updateExtensionTheme(container, p);
            repositionCloseButton(p, container);
        },
    });
    await popup.show();
}

function render(root, filter = '') {
    root.replaceChildren();
    libraryFilter = filter;

    const settings = getSettings();
    const master = settings.master_items || {};
    const trackerSettings = settings.statusTracker;
    const total = countItems(master);

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = `Entry Library (${total})`;
    root.appendChild(title);

    const blurb = document.createElement('small');
    blurb.className = 'notes';
    blurb.style.display = 'block';
    blurb.style.marginBottom = '12px';
    blurb.textContent = 'Static details the extension remembers for everything your '
        + 'collections hold - items, skills, spells - reused whenever that entry reappears. '
        + 'Editing here changes what future mentions inherit; it does not alter what anyone '
        + 'is carrying in the current chat.';
    root.appendChild(blurb);

    /* ── controls ─────────────────────────────────────────────────────────── */
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:15px;';

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'text_pole';
    search.placeholder = 'Filter entries…';
    search.value = filter;
    search.style.flex = '1';
    search.style.minWidth = '160px';
    let searchTimer = null;
    search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            const caret = search.selectionStart;
            render(root, search.value);
            const again = root.querySelector('input[placeholder="Filter entries…"]');
            if (again) { again.focus(); again.setSelectionRange(caret, caret); }
        }, 250);
    });

    const purgeBtn = document.createElement('button');
    purgeBtn.type = 'button';
    purgeBtn.className = 'menu_button';
    purgeBtn.style.whiteSpace = 'nowrap';
    purgeBtn.innerHTML = '<i class="fa-solid fa-broom"></i> Purge unreferenced';
    purgeBtn.title = 'Forget remembered entries that nobody is currently carrying in this chat';
    purgeBtn.addEventListener('click', async () => {
        const referenced = referencedItemNames();
        const doomed = [];
        for (const [colId, items] of Object.entries(master)) {
            for (const key of Object.keys(items || {})) {
                if (!referenced[colId]?.has(key)) doomed.push({ colId, key });
            }
        }
        if (doomed.length === 0) {
            toastr.info('Every remembered entry is currently held by someone.', 'SillyNPC');
            return;
        }
        const ok = await Popup.show.confirm(
            `Forget ${doomed.length} entr${doomed.length === 1 ? 'y' : 'ies'}?`,
            'These are not held by anyone in this chat. Their remembered descriptions will be '
            + 'lost, though the AI can describe them again if they reappear.');
        if (!ok) return;
        for (const { colId, key } of doomed) delete master[colId][key];
        saveSettings();
        toastr.success(`Forgot ${doomed.length} unreferenced entr${doomed.length === 1 ? 'y' : 'ies'}.`, 'SillyNPC');
        render(root, search.value);
    });

    controls.append(search, purgeBtn);
    if (libraryBulk) controls.appendChild(libraryBulk.bar);
    root.appendChild(controls);

    /* ── per-collection lists ─────────────────────────────────────────────── */
    const needle = filter.trim().toLowerCase();
    let shown = 0;

    for (const colDef of trackerSettings.collections || []) {
        const items = master[colDef.id] || {};
        const keys = Object.keys(items)
            .filter(k => !needle || k.includes(needle) || JSON.stringify(items[k]).toLowerCase().includes(needle))
            .sort();
        if (keys.length === 0) continue;
        shown += keys.length;

        const section = document.createElement('div');
        section.style.marginBottom = '20px';

        const heading = document.createElement('div');
        heading.className = 'sillynpc-category-heading';
        heading.innerHTML = `<span class="sillynpc-category-label">${escapeHtml(colDef.name || colDef.id)} (${keys.length})</span>`;
        section.appendChild(heading);

        const fields = staticFieldsOf(colDef);
        const primary = primaryFieldName(colDef);

        for (const key of keys) {
            section.appendChild(buildItemRow({ root, search, master, colDef, fields, primary, key }));
        }
        root.appendChild(section);
    }

    if (shown === 0) {
        const empty = document.createElement('p');
        empty.className = 'notes';
        empty.style.opacity = '0.6';
        empty.textContent = total === 0
            ? 'Nothing remembered yet. Entries are added automatically as the AI mentions them.'
            : 'No entries match that filter.';
        root.appendChild(empty);
    }

    root.appendChild(buildTombstoneSection(root, search));
    root.appendChild(buildRuleSection(root, search, DISMISSED_KEY, {
        title: 'Never Suggest Adding',
        note: 'Entries you have told the tracker to stop proposing. Unlike the suppressed '
            + 'entries above, these never expire, so a scan of the whole history will not '
            + 'raise them again. Clear one to make it findable once more.',
        undo: 'Allow this entry to be proposed again',
    }));
    root.appendChild(buildRuleSection(root, search, PROTECTED_KEY, {
        title: 'Never Suggest Removing',
        note: 'Entries you have protected. Nothing will propose taking these away, however '
            + 'long the story goes without mentioning them. Clear one to let it be '
            + 'proposed for removal again.',
        undo: 'Allow this entry to be proposed for removal again',
    }));
}

function buildItemRow({ root, search, master, colDef, fields, primary, key }) {
    const data = master[colDef.id][key] || {};

    const card = document.createElement('div');
    card.className = 'sillynpc-item-card';
    card.style.cssText = 'margin-bottom:8px; padding:10px; border:1px solid var(--sillynpc-border); border-radius:6px;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';

    // Primary field doubles as the storage key, so editing it is a rename.
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'text_pole';
    nameInput.style.cssText = 'flex:1; min-width:160px; font-weight:bold;';
    nameInput.value = data[primary] ?? key;
    nameInput.addEventListener('change', () => {
        const newName = nameInput.value.trim();
        if (!newName || newName.toLowerCase() === key) return;
        const updated = { ...data, [primary]: newName };
        renameMasterItem(colDef.id, key, newName, updated);
        render(root, search.value);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'menu_button';
    del.style.color = 'var(--sillynpc-danger)';
    del.innerHTML = '<i class="fa-solid fa-trash"></i>';
    del.title = 'Forget this entry';
    del.addEventListener('click', async () => {
        const ok = await Popup.show.confirm('Forget entry?', `"${data[primary] ?? key}" will no longer be remembered.`);
        if (!ok) return;
        deleteMasterItem(colDef.id, key);
        render(root, search.value);
    });

    // In bulk mode the per-item trash goes: two ways to delete on one row, one of them
    // asking a different question, is how somebody means to tick and instead deletes.
    if (libraryBulk?.isActive()) {
        header.append(buildBulkCheckbox(libraryBulk, itemId(colDef.id, key)), nameInput);
    } else {
        header.append(nameInput, del);
    }
    card.appendChild(header);

    // Remaining static fields.
    for (const field of fields) {
        if (field.name === primary) continue;
        const wrap = document.createElement('div');
        wrap.style.marginTop = '6px';

        const label = document.createElement('div');
        label.className = 'field-label';
        label.textContent = field.label || field.name;
        wrap.appendChild(label);

        const input = field.isMultiline
            ? document.createElement('textarea')
            : document.createElement('input');
        input.className = 'text_pole';
        input.style.width = '100%';
        if (field.isMultiline) {
            input.rows = Math.min(8, Math.max(2, String(data[field.name] ?? '').split('\n').length));
            input.style.resize = 'vertical';
        } else {
            input.type = 'text';
        }
        input.value = data[field.name] ?? '';
        input.addEventListener('change', () => {
            const merged = { ...master[colDef.id][key], [primary]: nameInput.value.trim(), [field.name]: input.value };
            updateMasterItem(colDef.id, nameInput.value.trim() || key, merged);
        });

        wrap.appendChild(input);
        card.appendChild(wrap);
    }

    return card;
}

/**
 * One of the two standing-decision lists, and the way back out of it.
 *
 * Distinct from the tombstones above, which expire on their own after a few messages.
 * These do not expire - that is the point of them, since a scan reads hundreds of
 * messages and would otherwise re-propose something settled long ago. Which makes them
 * exactly the sort of list that has to be visible and reversible: while one list served
 * both directions, ticking the box on a removal recorded the opposite of what it read
 * as, and items people still owned quietly stopped being proposable.
 */
function buildRuleSection(root, search, key, { title, note: noteText, undo }) {
    const section = document.createElement('div');
    section.style.marginTop = '20px';

    const playerName = (() => {
        try { return loadStateFromMetadata()?.player?.name || 'Player'; } catch { return 'Player'; }
    })();

    const entries = Object.entries(getItemRules(key))
        .flatMap(([slot, collections]) => Object.entries(collections || {})
            .flatMap(([colId, names]) => (names || []).map(name => ({
                slot, colId, name,
                who: slot === PLAYER_ACTOR ? playerName : slot,
            }))))
        .filter(e => !search
            || `${e.name} ${e.colId} ${e.who}`.toLowerCase().includes(search.toLowerCase()));

    const heading = document.createElement('h3');
    heading.className = 'sillynpc-section-title';
    heading.textContent = `${title} (${entries.length})`;
    section.appendChild(heading);

    const note = document.createElement('small');
    note.className = 'notes';
    note.style.cssText = 'display:block; margin-bottom:10px;';
    note.textContent = noteText;
    section.appendChild(note);

    if (entries.length === 0) {
        const none = document.createElement('p');
        none.className = 'notes';
        none.style.opacity = '0.6';
        none.textContent = 'Nothing on this list.';
        section.appendChild(none);
        return section;
    }

    for (const { slot, colId, name, who } of entries) {
        const row = document.createElement('div');
        row.className = 'flex-container';
        row.style.cssText = 'margin:4px 0; gap:10px;';

        const label = document.createElement('span');
        label.style.flex = '1';
        label.textContent = `${name}  (${who} - ${colId})`;

        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'menu_button';
        clear.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
        clear.title = undo;
        clear.addEventListener('click', () => {
            clearItemRule(key, slot, colId, name);
            render(root, search);
        });

        row.append(label, clear);
        section.appendChild(row);
    }

    return section;
}

function buildTombstoneSection(root, search) {
    const section = document.createElement('div');
    section.style.marginTop = '25px';

    let state = null;
    try { state = loadStateFromMetadata(); } catch { /* no chat */ }
    const tombstones = state?.recently_deleted || {};
    const entries = Object.entries(tombstones)
        .flatMap(([colId, items]) => Object.entries(items || {}).map(([name, ttl]) => ({ colId, name, ttl })));

    const heading = document.createElement('h3');
    heading.className = 'sillynpc-section-title';
    heading.textContent = `Suppressed Entries (${entries.length})`;
    section.appendChild(heading);

    const note = document.createElement('small');
    note.className = 'notes';
    note.style.display = 'block';
    note.style.marginBottom = '10px';
    note.textContent = 'Entries you dropped recently. The AI is prevented from re-adding them for '
        + 'a few messages, so they do not reappear the moment you discard them.';
    section.appendChild(note);

    if (entries.length === 0) {
        const none = document.createElement('p');
        none.className = 'notes';
        none.style.opacity = '0.6';
        none.textContent = 'Nothing is currently suppressed.';
        section.appendChild(none);
        return section;
    }

    for (const { colId, name, ttl } of entries) {
        const row = document.createElement('div');
        row.className = 'sillynpc-setting-row';
        row.style.cssText = 'margin:4px 0; gap:10px;';

        const label = document.createElement('span');
        label.style.flex = '1';
        label.textContent = `${name}  (${colId})`;

        const remaining = document.createElement('small');
        remaining.style.opacity = '0.7';
        remaining.textContent = `${ttl} message${ttl === 1 ? '' : 's'} left`;

        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'menu_button';
        clear.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        clear.title = 'Allow this entry to come back immediately';
        clear.addEventListener('click', () => {
            const live = loadStateFromMetadata();
            if (live?.recently_deleted?.[colId]) {
                delete live.recently_deleted[colId][name];
                if (Object.keys(live.recently_deleted[colId]).length === 0) delete live.recently_deleted[colId];
                saveStateToMetadata(live, { label: 'Tombstone cleared' });
                eventSource.emit('sillynpc-status-updated', live);
            }
            render(root, search.value);
        });

        row.append(label, remaining, clear);
        section.appendChild(row);
    }

    return section;
}
