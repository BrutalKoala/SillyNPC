import { availablePrompts, PROMPTS } from './prompts.js';
import { buildSettingTextArea, buildSettingNumber, buildSettingSlider } from './ui-shared.js';
import { escapeHtml } from './utils.js';

/**
 * One prompt editor, built from its registry entry.
 *
 * Used both by the Prompts tab and by the tab the prompt has always lived in, so the two
 * are the same control rather than two that look alike.
 *
 * @param {object} entry From PROMPTS.
 * @param {{ onChange?: () => void, showHome?: boolean }} [options] `showHome` adds the
 *   line saying where else this prompt can be found - wanted in the collected view,
 *   noise in the tab it names.
 */
export function buildPromptEditor(entry, { onChange, showHome = false } = {}) {
    const wrap = buildSettingTextArea({
        key: entry.key,
        label: entry.label,
        help: entry.help,
        recommended: entry.recommended?.(),
        emptyNote: entry.emptyNote,
        showTokens: true,
        onChange,
    });

    if (showHome && entry.home) {
        const where = document.createElement('small');
        where.className = 'notes sillynpc-prompt-home';
        where.textContent = `Also in ${entry.home}. The same setting - editing it here or there is the same edit.`;
        wrap.append(where);
    }

    return wrap;
}

/** The reply budget that belongs to a prompt, if it has one. */
export function buildPromptBudget(entry, { onChange } = {}) {
    const budget = entry.budget;
    if (!budget) return null;

    // advanced, to agree with the same control on the Tracker tab. A reply budget hidden
    // in one place and offered in another is the two disagreeing about what it is.
    const common = { key: budget.key, label: budget.label, help: budget.help, onChange, advanced: true };
    return budget.kind === 'slider'
        ? buildSettingSlider({ ...common, min: budget.min, max: budget.max, step: budget.step })
        : buildSettingNumber({ ...common, suffix: budget.suffix || '' });
}

/**
 * The Prompts tab: every prompt that applies to the current setup, with its reply budget
 * and its cost, in one place.
 *
 * Nothing was moved here. Each prompt still sits beside the settings it works with, where
 * it is found while doing that job; this view is for the other question - what is this
 * model being told in total, and what does it cost - which cannot be answered from a
 * setting seen one tab at a time.
 *
 * @param {HTMLElement} view
 * @param {() => void} [onApply] Called after an edit, so a view that shows the result of
 *   a prompt can redraw.
 */
export function renderPromptsView(view, onApply) {
    if (!view) return;
    view.replaceChildren();

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = 'Prompts';
    view.append(title);

    const intro = document.createElement('small');
    intro.className = 'notes';
    intro.textContent = 'Everything this extension says to a model, and what each costs. '
        + 'The count is of the text as written - placeholders are filled when it is sent '
        + 'and cost whatever they are filled with.';
    view.append(intro);

    const shown = availablePrompts();
    for (const entry of shown) {
        const section = document.createElement('div');
        section.className = 'sillynpc-prompt-section';
        section.append(buildPromptEditor(entry, { onChange: onApply, showHome: true }));
        const budget = buildPromptBudget(entry, { onChange: onApply });
        if (budget) section.append(budget);
        view.append(section);
    }

    // A prompt hidden because it does not apply is different from one that does not
    // exist. Saying which, and why, stops a search for the negative prompt on a Gemini
    // setup ending in the conclusion that it was lost.
    const hidden = PROMPTS.filter(p => !shown.includes(p));
    if (hidden.length) {
        const note = document.createElement('small');
        note.className = 'notes sillynpc-prompt-hidden';
        note.innerHTML = 'Not shown, because your current setup does not send them: '
            + hidden.map(p => `<b>${escapeHtml(p.label)}</b>`).join(', ') + '.';
        view.append(note);
    }
}
