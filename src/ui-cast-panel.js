import { POPUP_TYPE, Popup } from '../../../../popup.js';
import { escapeHtml } from './utils.js';
import { updateExtensionTheme } from './ui-shared.js';
import { triggerReprocess } from './reprocess.js';
import {
    loadStateFromMetadata,
    getCastDecisions,
    setCastDecision,
    CAST_PERSONA,
    CAST_EXCLUDED,
} from './status-logic.js';

/**
 * Who the tracker should treat as a character, and who it should stop admitting.
 *
 * A local model that writes `**I**:` puts "I" in the cast; one that writes the user's own
 * lines with their name puts the player there beside their own HUD row. Removing them was
 * futile, because the cast is re-derived from the message on every redraw and nothing
 * remembered the removal.
 *
 * The decision is made here rather than by matching the persona's name, because the
 * extension cannot tell the persona from a character who happens to share the name - and
 * a story is perfectly entitled to have one.
 */

const CHOICES = [
    { value: '', label: 'In the scene', hint: 'A character like any other.' },
    { value: CAST_PERSONA, label: 'This is me', hint: 'The player. Drawn with your persona picture, tracked by the HUD, never as a character.' },
    { value: CAST_EXCLUDED, label: 'Not a character', hint: 'Narration the reader mistook for somebody speaking.' },
];

/**
 * Everybody the panel should offer a decision about: the current cast, plus anyone
 * already decided so the decision can be undone.
 *
 * @returns {Array<{ name: string, reason: string }>}
 */
export function castPanelRows() {
    const decisions = getCastDecisions();
    const rows = [];
    const seen = new Set();

    let live = [];
    try { live = loadStateFromMetadata()?.characters || []; } catch { /* no chat open */ }
    for (const char of live) {
        const key = String(char?.name ?? '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        rows.push({ name: char.name, reason: decisions[key] || '' });
    }

    // The decided are not in the cast any more - that is the point - so they would
    // otherwise be unreachable, and a decision you cannot undo is a trap.
    for (const [key, reason] of Object.entries(decisions)) {
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ name: key, reason });
    }

    return rows;
}

/**
 * @param {() => void} [onDone] Redraws whatever opened this, once a decision is made.
 */
export async function openCastPanel(onDone) {
    const container = document.createElement('div');
    container.className = 'sillynpc sillynpc-manage sillynpc-cast-panel';
    container.style.padding = '16px';

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = 'Who is in this scene';
    container.appendChild(title);

    const blurb = document.createElement('small');
    blurb.className = 'notes';
    blurb.style.cssText = 'display:block; margin-bottom:12px;';
    blurb.textContent = 'A reader can mistake narration for somebody speaking, and it has no '
        + 'way to know which "you" is you. Say so once here and it stops putting them back. '
        + 'Remembered for this chat only, since another story may have a real character of '
        + 'the same name.';
    container.appendChild(blurb);

    const rows = castPanelRows();
    if (rows.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'notes';
        empty.style.opacity = '0.6';
        empty.textContent = 'Nobody is in the scene yet.';
        container.appendChild(empty);
    }

    let changed = false;

    for (const row of rows) {
        const wrap = document.createElement('div');
        wrap.className = 'sillynpc-cast-row';

        const name = document.createElement('span');
        name.className = 'sillynpc-cast-name';
        name.textContent = row.name;
        wrap.appendChild(name);

        const choices = document.createElement('div');
        choices.className = 'sillynpc-cast-choices';

        for (const choice of CHOICES) {
            const label = document.createElement('label');
            label.className = 'sillynpc-cast-choice';
            label.title = choice.hint;

            const radio = document.createElement('input');
            radio.type = 'radio';
            // Per row, or choosing for one person would clear everybody else's answer.
            radio.name = `sillynpc-cast-${escapeHtml(row.name)}`;
            radio.checked = row.reason === choice.value;
            radio.addEventListener('change', () => {
                if (!radio.checked) return;
                if (setCastDecision(row.name, choice.value || null)) changed = true;
            });

            label.append(radio, document.createTextNode(choice.label));
            choices.appendChild(label);
        }

        wrap.appendChild(choices);
        container.appendChild(wrap);
    }

    const popup = new Popup(container, POPUP_TYPE.DISPLAY, '', {
        onOpen: (p) => updateExtensionTheme(container, p),
    });
    await popup.show();

    // Only when something was actually decided: this redraws every message, and doing
    // that for a panel somebody opened and closed again is the stall this avoids.
    if (!changed) return;
    // The decision shows in the chat as well as the tracker - saying "this is me" changes
    // the portrait beside the name - and the caller only knows about its own box.
    triggerReprocess();
    onDone?.();
}
