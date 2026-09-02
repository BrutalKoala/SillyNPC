import { getPendingChanges, resolvePendingChanges, getLooseNotes } from './status-review.js';
import { getSettings } from './settings.js';

/**
 * The inline review panel.
 *
 * Rendered under the message that proposed the changes, so it is obvious which message
 * wanted to delete an item. Nothing here interrupts reading: unreviewed rows simply sit
 * unapplied until a decision is made.
 *
 * Rows are editable rather than merely acceptable. "It says 5 but it should be 4" is the
 * common case, and rejecting outright would leave the state wrong in a different way.
 */

const KIND_LABEL = {
    'stat': 'changed',
    'stat-max': 'maximum',
    'item-add': 'gained',
    'item-remove': 'lost',
    'item-change': 'changed',
};

const KIND_ICON = {
    'stat': 'fa-arrow-right-arrow-left',
    'stat-max': 'fa-arrows-up-down',
    'item-add': 'fa-plus',
    'item-remove': 'fa-minus',
    'item-change': 'fa-pen',
};

/** Who a row belongs to, for grouping. */
function ownerOf(change) {
    if (change.scope === 'global') return 'World';
    if (change.scope === 'player') return 'You';
    return change.actor || 'Character';
}

/**
 * Draws the panel for one message, or nothing when there is nothing to review.
 *
 * @param {Element} mesEl The `.mes` element.
 * @param {string|number} messageId
 * @returns {HTMLElement|null}
 */
function buildReviewPanel(mesEl, messageId) {
    const pending = getPendingChanges(messageId);
    if (!pending.length) return null;

    // Working copy: edits and toggles live here until the user commits.
    const rows = pending.map((change, index) => ({
        index,
        change,
        accepted: change.kind !== 'item-remove',   // deletions default to "no"
        dismiss: false,                            // never off by default: see buildRow
        value: String(change.after ?? ''),
        // Where it lands, editable before it does.
        scope: change.scope,
        actor: change.actor ?? null,
        collectionId: change.collectionId ?? null,
    }));

    const panel = document.createElement('div');
    // The panel is a sibling of the status box, not a child of it, so it does not
    // inherit the theme variables the box carries. Wear the same theme class or the
    // panel is the one part of the tracker that ignores the user's choice.
    const theme = getSettings().menuStyle || 'default';
    panel.className = `sillynpc-review-panel sillynpc-theme-${theme}`;
    panel.dataset.messageId = String(messageId);

    const header = document.createElement('div');
    header.className = 'sillynpc-review-header';
    header.innerHTML = `<i class="fa-solid fa-list-check"></i> `
        + `<b>${pending.length} change${pending.length === 1 ? '' : 's'} to review</b>`;
    panel.appendChild(header);

    // Reasons the reader gave that belong to no row here - almost always a key it spelled
    // differently from the stat. Shown rather than dropped: a reason that could not be
    // placed is evidence about a reader losing track of what it is changing, which is the
    // question this whole feature exists to answer.
    const loose = getLooseNotes(messageId);
    if (loose.length) {
        const notes = document.createElement('div');
        notes.className = 'sillynpc-review-loose-notes';
        const lead = document.createElement('small');
        lead.textContent = loose.length === 1
            ? 'It also said, about nothing listed here:'
            : `It also said ${loose.length} things about nothing listed here:`;
        notes.appendChild(lead);
        for (const note of loose) {
            const line = document.createElement('small');
            line.className = 'sillynpc-review-loose-note';
            line.textContent = note;
            notes.appendChild(line);
        }
        panel.appendChild(notes);
    }

    const list = document.createElement('div');
    list.className = 'sillynpc-review-list';

    let lastOwner = null;
    for (const row of rows) {
        const owner = ownerOf(row.change);
        if (owner !== lastOwner) {
            const group = document.createElement('div');
            group.className = 'sillynpc-review-owner';
            group.textContent = owner;
            list.appendChild(group);
            lastOwner = owner;
        }
        list.appendChild(buildRow(row));
    }
    panel.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'sillynpc-review-actions';

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'menu_button';
    apply.innerHTML = '<i class="fa-solid fa-check"></i> Apply selected';
    apply.addEventListener('click', () => {
        const accepted = rows.filter(r => r.accepted).map(r => ({
            ...r.change, after: r.value,
            scope: r.scope, actor: r.actor, collectionId: r.collectionId,
        }));
        const dismissed = rows.filter(r => r.dismiss).map(r => r.change);
        resolvePendingChanges(messageId, accepted, dismissed);
        panel.remove();
    });

    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'menu_button';
    discard.title = 'Leave everything as it is';
    discard.innerHTML = '<i class="fa-solid fa-xmark"></i> Discard all';
    discard.addEventListener('click', () => {
        // Declining is about this message. Only a ticked never-again box is permanent.
        const dismissed = rows.filter(r => r.dismiss).map(r => r.change);
        resolvePendingChanges(messageId, [], dismissed);
        panel.remove();
    });

    actions.append(apply, discard);
    panel.appendChild(actions);
    return panel;
}

/**
 * Where a row is going, and the chance to change it.
 *
 * A row used to read "Tablet  (none) → Tablet" under an owner heading, which never said
 * which collection it meant - so an addition and a move looked identical, and a spell the
 * scan filed as an item could only be rejected, never corrected. These are the two things
 * a scan reading prose gets wrong: what kind of thing it is, and whose it is.
 *
 * Stats get the same line as plain text. A stat's home is fixed by the schema.
 */
function buildDestination(row) {
    const { change } = row;
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-review-dest';

    const into = document.createElement('small');
    into.textContent = 'into';
    wrap.appendChild(into);

    const isItem = change.kind === 'item-add' || change.kind === 'item-remove' || change.kind === 'item-change';
    if (!isItem) {
        const fixed = document.createElement('span');
        fixed.className = 'sillynpc-review-dest-fixed';
        fixed.textContent = `${ownerOf(change)} · ${change.label}`;
        wrap.appendChild(fixed);
        return wrap;
    }

    const settings = getSettings().statusTracker;

    // Which collection. Only ones valid for this kind of owner are offered.
    const colSelect = document.createElement('select');
    colSelect.className = 'sillynpc-review-dest-select';
    colSelect.title = 'Which collection this belongs in. A scan often files a spell as an item.';
    for (const col of settings.collections || []) {
        const forPlayer = col.target !== 'npc';
        const forNpc = col.target !== 'player';
        if (row.scope === 'player' ? !forPlayer : !forNpc) continue;
        const option = document.createElement('option');
        option.value = col.id;
        option.textContent = col.id;
        option.selected = col.id === row.collectionId;
        colSelect.appendChild(option);
    }
    colSelect.addEventListener('change', () => { row.collectionId = colSelect.value; });

    // Whose. The player, plus everyone with a card - a scan is mostly about people who
    // are not in the room, and their card is where their things are kept.
    const ownerSelect = document.createElement('select');
    ownerSelect.className = 'sillynpc-review-dest-select';
    ownerSelect.title = 'Who this belongs to. Change it if the scan credited the wrong character.';

    const playerOption = document.createElement('option');
    playerOption.value = '';
    playerOption.textContent = 'You';
    playerOption.selected = row.scope === 'player';
    ownerSelect.appendChild(playerOption);

    const names = new Set((getSettings().characters || []).map(c => c.name).filter(Boolean));
    if (change.actor) names.add(change.actor);
    for (const name of names) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        option.selected = row.scope === 'character' && row.actor === name;
        ownerSelect.appendChild(option);
    }
    ownerSelect.addEventListener('change', () => {
        row.scope = ownerSelect.value ? 'character' : 'player';
        row.actor = ownerSelect.value || null;
        // The collection list differs between the player and a character, so rebuild it.
        const stillValid = [...colSelect.options].some(o => o.value === row.collectionId);
        if (!stillValid) row.collectionId = colSelect.options[0]?.value ?? row.collectionId;
    });

    wrap.append(ownerSelect, colSelect);
    return wrap;
}

function buildRow(row) {
    const { change } = row;
    const el = document.createElement('div');
    el.className = `sillynpc-review-row kind-${change.kind}`;

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = row.accepted;
    toggle.className = 'sillynpc-review-toggle';
    toggle.title = 'Include this change';
    toggle.addEventListener('change', () => { row.accepted = toggle.checked; });

    const icon = document.createElement('i');
    icon.className = `fa-solid ${KIND_ICON[change.kind] || 'fa-circle'} sillynpc-review-icon`;

    const label = document.createElement('span');
    label.className = 'sillynpc-review-label';
    label.textContent = change.label;

    const from = document.createElement('span');
    from.className = 'sillynpc-review-from';
    from.textContent = change.before;

    const arrow = document.createElement('span');
    arrow.className = 'sillynpc-review-arrow';
    arrow.textContent = '→';

    // Item rows name a thing rather than hold a value, so only stats are editable.
    const editable = change.kind === 'stat' || change.kind === 'stat-max' || change.kind === 'item-change';
    const to = document.createElement(editable ? 'input' : 'span');
    to.className = 'sillynpc-review-to';
    if (editable) {
        to.type = 'text';
        to.value = row.value;
        to.title = 'Correct this value before applying';
        to.addEventListener('input', () => { row.value = to.value; });
        // The panel sits inside a chat message; stop SillyTavern's shortcuts seeing this.
        for (const evt of ['keydown', 'keyup', 'keypress']) {
            to.addEventListener(evt, e => e.stopPropagation());
        }
    } else {
        to.textContent = change.after;
    }

    const why = document.createElement('small');
    why.className = 'sillynpc-review-why';
    // Two different things, and both are worth reading: why the extension held this row
    // back ("large swing"), and what the reader says it read in the message. Neither
    // replaces the other - the risk assessment is the reason it is being asked about at
    // all, and the account is what decides the answer.
    const ours = change.reason || KIND_LABEL[change.kind] || '';
    if (change.note) {
        why.textContent = ours ? `${ours} — ${change.note}` : change.note;
        why.classList.add('has-note');
        why.title = change.note;
    } else {
        why.textContent = ours;
    }

    el.append(toggle, icon, label, from, arrow, to, buildDestination(row), why);

    // Blacklisting an item forever is a different decision from turning it down now, and
    // has to be asked for. Inferring it from an ordinary decline meant that discarding a
    // panel once made four real spells permanently unfindable.
    if (change.kind === 'item-add' || change.kind === 'item-remove') {
        el.appendChild(buildNeverAgain(row, change));
    }
    return el;
}

/**
 * The opt-in "stop suggesting this" control.
 *
 * Worded by what the row offers, because the two directions mean opposite things and one
 * shared label hid that completely: on a removal the tick used to record "this item is
 * gone for good" when every reader took it to mean "stop asking me to delete it".
 */
function buildNeverAgain(row, change) {
    const removing = change.kind === 'item-remove';

    const wrap = document.createElement('label');
    wrap.className = 'sillynpc-review-never';
    wrap.title = removing
        ? 'Protect this item. Nothing will propose taking it away again, including a scan '
          + 'of the whole history. Reversible from the item library.'
        : 'Stop proposing this item entirely. Use it for something the character has '
          + 'genuinely finished with - a scan of the whole history will not raise it '
          + 'again. Reversible from the item library.';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = false;
    box.addEventListener('change', () => { row.dismiss = box.checked; });

    const text = document.createElement('span');
    text.textContent = removing ? 'never remove this' : 'never add this';

    wrap.append(box, text);
    return wrap;
}

/**
 * Places the panel under a message, replacing any previous one.
 * @param {Element} mesEl
 * @param {string|number} messageId
 */
export function renderReviewPanel(mesEl, messageId) {
    if (!mesEl) return;
    mesEl.querySelectorAll('.sillynpc-review-panel').forEach(el => el.remove());

    const panel = buildReviewPanel(mesEl, messageId);
    if (!panel) return;

    const textContainer = mesEl.querySelector('.mes_text');
    if (textContainer) textContainer.appendChild(panel);
    else mesEl.appendChild(panel);
}
