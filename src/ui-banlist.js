import { POPUP_TYPE, POPUP_RESULT, Popup } from '../../../../popup.js';
import { getSettings, saveSettings } from './settings.js';
import { LOG_PREFIX } from './constants.js';
import { updateExtensionTheme } from './ui-shared.js';
import {
    banMode, bannedPhrases, scanForBanCandidates, addBannedPhrases, addNotPeople,
} from './banlist.js';

/**
 * The ban list panel: what is banned, how it is being enforced, and a way to find more.
 *
 * Nothing here bans anything on its own. A phrase banned by mistake is a phrase the model
 * can no longer produce at all, and the failure does not look like a setting - it looks
 * like the model going strange in a way nobody would trace back to a list they approved a
 * week ago. So the scan proposes and you tick.
 */

/** One row: the phrase, and a way to take it off again. */
function phraseRow(phrase, index, onChange) {
    const row = document.createElement('div');
    row.className = 'sillynpc-ban-row';

    const text = document.createElement('span');
    text.className = 'sillynpc-ban-text';
    text.textContent = phrase;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'menu_button sillynpc-ban-remove';
    remove.title = 'Stop banning this';
    remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    remove.addEventListener('click', () => {
        getSettings().banList.splice(index, 1);
        saveSettings();
        onChange();
    });

    row.append(text, remove);
    return row;
}

/**
 * Offers what the scan found, and returns what was ticked.
 *
 * Both lists in one popup because they came from one reading, and because deciding about
 * them together is how you notice the scan has proposed a character's name as slop.
 *
 * @returns {Promise<{ phrases: string[], notPeople: string[] } | null>} Null on cancel.
 */
async function offerCandidates({ phrases, notPeople, read }) {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc sillynpc-manage sillynpc-ban-offer';
    wrap.style.padding = '16px';

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = 'What the scan found';
    wrap.append(title);

    const blurb = document.createElement('small');
    blurb.className = 'notes';
    blurb.style.cssText = 'display:block; margin-bottom:12px;';
    blurb.textContent = `Read ${read} message${read === 1 ? '' : 's'}. Tick what to act on. `
        + 'A banned phrase cannot be written at all, so leave anything you are unsure about.';
    wrap.append(blurb);

    if (!phrases.length && !notPeople.length) {
        const none = document.createElement('p');
        none.className = 'notes';
        none.textContent = 'Nothing worth banning was found.';
        wrap.append(none);
        await new Popup(wrap, POPUP_TYPE.DISPLAY, '', {
            onOpen: (p) => updateExtensionTheme(wrap, p),
        }).show();
        return null;
    }

    /** @type {Map<HTMLInputElement, string>} */
    const boxes = new Map();

    const section = (heading, note, items) => {
        if (!items.length) return;
        const h = document.createElement('div');
        h.className = 'sillynpc-cv-label';
        h.style.marginTop = '12px';
        h.textContent = heading;
        wrap.append(h);

        const small = document.createElement('small');
        small.className = 'notes';
        small.style.cssText = 'display:block; margin-bottom:6px;';
        small.textContent = note;
        wrap.append(small);

        for (const item of items) {
            const label = document.createElement('label');
            label.className = 'sillynpc-ban-offer-row';
            const box = document.createElement('input');
            box.type = 'checkbox';
            boxes.set(box, item);
            label.append(box, document.createTextNode(item));
            wrap.append(label);
        }
    };

    section('Phrases to ban', 'Stopped at the sampler where your backend allows it.', phrases);
    section('Not people', 'Added to Not Speakers, so they stop being decorated as characters.',
        notPeople);

    const result = await new Popup(wrap, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Apply ticked', cancelButton: 'Cancel',
        onOpen: (p) => updateExtensionTheme(wrap, p),
    }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;

    const ticked = [...boxes.entries()].filter(([box]) => box.checked).map(([, item]) => item);
    return {
        phrases: ticked.filter(item => phrases.includes(item)),
        notPeople: ticked.filter(item => notPeople.includes(item)),
    };
}

/** Renders the panel into a container, and redraws itself as things change. */
export function renderBanList(container) {
    if (!container) return;
    container.replaceChildren();
    container.className = 'sillynpc-ban-panel';

    const redraw = () => renderBanList(container);

    // How it is being enforced, said before the list rather than after: whether these are
    // banned or merely requested changes what the list means.
    const { mode, reason } = banMode();
    const status = document.createElement('div');
    status.className = `sillynpc-ban-mode is-${mode}`;
    const icon = document.createElement('i');
    icon.className = mode === 'sampler' ? 'fa-solid fa-ban' : 'fa-solid fa-comment-dots';
    const said = document.createElement('span');
    said.textContent = reason;
    status.append(icon, said);
    container.append(status);

    const phrases = bannedPhrases();
    if (phrases.length) {
        const list = document.createElement('div');
        list.className = 'sillynpc-ban-list';
        phrases.forEach((phrase, index) => list.append(phraseRow(phrase, index, redraw)));
        container.append(list);
    } else {
        const empty = document.createElement('p');
        empty.className = 'notes';
        empty.textContent = 'Nothing banned yet.';
        container.append(empty);
    }

    const actions = document.createElement('div');
    actions.className = 'sillynpc-ban-actions';

    const scan = document.createElement('button');
    scan.type = 'button';
    scan.className = 'menu_button';
    scan.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Scan the chat';
    scan.title = 'Read the recent replies and propose phrases the model leans on.';
    scan.addEventListener('click', async () => {
        scan.disabled = true;
        scan.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Reading...';
        try {
            const found = await scanForBanCandidates();
            const chosen = await offerCandidates(found);
            if (chosen) {
                const banned = addBannedPhrases(chosen.phrases);
                const ignored = addNotPeople(chosen.notPeople);
                toastr.success(
                    `Banned ${banned} phrase(s), and added ${ignored} to Not Speakers.`,
                    'SillyNPC');
            }
        } catch (err) {
            console.error(LOG_PREFIX, 'Ban scan failed', err);
            toastr.error(String(err?.message || err), 'SillyNPC');
        } finally {
            redraw();
        }
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'menu_button';
    add.innerHTML = '<i class="fa-solid fa-plus"></i> Add by hand';
    add.addEventListener('click', async () => {
        const phrase = await Popup.show.input('Ban a phrase',
            'The model will not be able to write this. Quotation marks cannot be banned.');
        if (!phrase) return;
        addBannedPhrases([phrase]);
        redraw();
    });

    actions.append(scan, add);
    container.append(actions);
}
