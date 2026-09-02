import { Popup, POPUP_TYPE } from '../../../../popup.js';
import { getSettings, saveSettings } from './settings.js';
import { escapeHtml } from './utils.js';
import { debugLog } from './constants.js';
import { findTemplateLabels, applyLabelFixes } from './template-labels.js';

/** Every stat name the template could be referring to. */
function configuredFieldNames() {
    const tracker = getSettings().statusTracker;
    return ['globalStats', 'playerStats', 'npcStats']
        .flatMap(list => (tracker[list] || []).map(stat => stat?.name))
        .filter(Boolean);
}

/** One candidate, shown as what it is now and what it would become. */
function candidateRow(fix, index) {
    const row = document.createElement('label');
    row.className = 'sillynpc-fill-row';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'sillynpc-tidy-check';
    box.dataset.index = String(index);
    // A colon or a bracket is punctuation somebody chose to caption a value with. A bare
    // word before a reference might be a sentence, so it is offered without being assumed.
    box.checked = fix.likely;

    const text = document.createElement('span');
    text.className = 'sillynpc-fill-text';
    text.innerHTML = `<code>${escapeHtml(fix.before)}</code> &rarr; <code>${escapeHtml(fix.after)}</code>`
        + `<br><small class="notes">Removes the label "${escapeHtml(fix.label)}" `
        + `from in front of ${escapeHtml(fix.field)}.</small>`;

    row.append(box, text);
    return row;
}

/**
 * Offers to take hand-written labels out of the display template.
 *
 * Every change is shown before it happens. This is pattern-matching against somebody's
 * own HTML, and however carefully the pattern is drawn it will eventually meet a template
 * that means something else - so the answer is to show the diff rather than to be clever
 * and quiet about it.
 *
 * @param {() => void} [onDone] Called after the template changes, to redraw the panel.
 */
export async function tidyTemplateLabels(onDone) {
    const tracker = getSettings().statusTracker;
    const template = String(tracker.template ?? '');
    const found = findTemplateLabels(template, configuredFieldNames());

    if (!found.length) {
        toastr.info('No hand-written labels found in the template.', 'SillyNPC');
        return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-fill-plan';

    const heading = document.createElement('h3');
    heading.textContent = 'Labels written into the template';
    wrap.append(heading);

    const intro = document.createElement('small');
    intro.className = 'notes';
    intro.textContent = 'These words sit beside a field reference rather than coming from '
        + 'the field, so renaming the field leaves them saying the old name. Removing one '
        + "lets the field's own Format decide its label - the Name box beside Visible in "
        + 'the System Builder is the switch for that.';
    wrap.append(intro);

    found.forEach((fix, index) => wrap.append(candidateRow(fix, index)));

    const popup = new Popup(wrap, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Remove selected', cancelButton: 'Cancel',
    });
    if (!await popup.show()) return;

    const chosen = [...wrap.querySelectorAll('.sillynpc-tidy-check')]
        .filter(box => box.checked)
        .map(box => found[Number(box.dataset.index)])
        .filter(Boolean);

    if (!chosen.length) return;

    tracker.template = applyLabelFixes(template, chosen);
    saveSettings();
    debugLog(`Removed ${chosen.length} hand-written label(s) from the template`);
    toastr.success(
        `Removed ${chosen.length} label${chosen.length === 1 ? '' : 's'}. `
        + 'Tick Name on a field to have its own name shown instead.',
        'SillyNPC');
    onDone?.();
}
