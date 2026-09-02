import { getSettings } from './settings.js';
import { exportCharacters, importCharacters, parseTransferFile } from './character-transfer.js';
import { LOG_PREFIX } from './constants.js';
import { POPUP_TYPE, Popup } from '../../../../popup.js';

/**
 * Sending characters out of the grid and taking them in.
 *
 * The file-handling half of character-transfer.js, kept apart from it so the format and
 * the merging can be tested without a DOM.
 */

/** Turns a filename into something a file system will accept. */
function safeFileName(text) {
    return String(text || 'character').replace(/[^\w\-. ]+/g, '_').trim() || 'character';
}

/** Hands the browser a file to save. */
function offerDownload(payload, fileName) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
}

/**
 * Writes the given characters to a file.
 *
 * @param {object[]} chars
 */
export async function exportCharacterFile(chars) {
    const list = (chars || []).filter(Boolean);
    if (!list.length) return;

    try {
        const { payload, lostImages } = await exportCharacters(list);
        const fileName = list.length === 1
            ? `sillynpc-${safeFileName(list[0].name)}.json`
            : `sillynpc-${list.length}-characters.json`;
        offerDownload(payload, fileName);

        // Said here rather than left for the recipient to discover: a portrait whose file
        // has gone is dropped from the export, and only the sender can do anything about it.
        if (lostImages) {
            toastr.warning(
                `${lostImages} portrait${lostImages === 1 ? '' : 's'} could not be read, and `
                + 'have been left out of the file.', 'SillyNPC');
        }
        toastr.success(
            list.length === 1 ? `Exported ${list[0].name || 'the character'}.` : `Exported ${list.length} characters.`,
            'SillyNPC');
    } catch (err) {
        console.error(LOG_PREFIX, 'Character export failed', err);
        toastr.error(String(err.message || err), 'SillyNPC');
    }
}

/** Which of the incoming names are already in use here. */
function collidingNames(payload) {
    const here = new Set((getSettings().characters || [])
        .map(c => String(c.name || '').toLowerCase()));
    return payload.characters
        .map(r => String(r?.name || '').trim())
        .filter(name => name && here.has(name.toLowerCase()));
}

/**
 * Asks once what to do about every name already in use.
 *
 * Once rather than per character: a file of ten people who are all already here would
 * otherwise be ten dialogs, which is how somebody clicks Overwrite without reading.
 *
 * @returns {Promise<string|null>} 'rename' | 'overwrite' | 'skip', or null if cancelled.
 */
async function askAboutCollisions(names) {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-import-collision';

    const heading = document.createElement('h3');
    heading.textContent = names.length === 1
        ? `You already have ${names[0]}`
        : `You already have ${names.length} of these characters`;
    wrap.append(heading);

    const who = document.createElement('p');
    who.className = 'notes';
    who.textContent = names.join(', ');
    wrap.append(who);

    const label = document.createElement('label');
    label.className = 'sillynpc-import-choice';
    label.textContent = 'What should happen to them?';

    const select = document.createElement('select');
    select.className = 'text_pole';
    for (const [value, text] of [
        ['rename', 'Keep both - bring the new ones in under a free name'],
        ['skip', 'Keep mine - leave the ones in the file out'],
        ['overwrite', 'Replace mine with the ones in the file'],
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.append(option);
    }
    label.append(select);
    wrap.append(label);

    const warning = document.createElement('small');
    warning.className = 'notes';
    warning.textContent = 'Replacing cannot be undone. Everything on your card - its '
        + 'portraits, its profile and anything the tracker holds for it - is written over.';
    wrap.append(warning);

    const popup = new Popup(wrap, POPUP_TYPE.CONFIRM, '', { okButton: 'Import', cancelButton: 'Cancel' });
    const confirmed = await popup.show();
    return confirmed ? select.value : null;
}

/** What happened, as one line. */
function describeResult(result) {
    const parts = [];
    if (result.added.length) parts.push(`${result.added.length} added`);
    if (result.overwritten.length) parts.push(`${result.overwritten.length} replaced`);
    if (result.skipped.length) parts.push(`${result.skipped.length} skipped`);
    return parts.length ? parts.join(', ') : 'nothing to do';
}

/**
 * Reads a character file and brings its contents in.
 *
 * @param {() => void} [onDone] Redraws whatever is showing.
 */
export async function importCharacterFile(onDone) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';

    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;

        try {
            const payload = parseTransferFile(await file.text());

            const clashes = collidingNames(payload);
            let choice = 'rename';
            if (clashes.length) {
                choice = await askAboutCollisions(clashes);
                if (!choice) return;
            }

            const result = await importCharacters(payload, { onCollision: async () => choice });
            toastr.success(describeResult(result), 'SillyNPC');
            // Anything the import could not do exactly as asked - a lorebook it had
            // nowhere to write, or an entry already kept for that name.
            for (const note of result.notes) toastr.info(note, 'SillyNPC');
            onDone?.();
        } catch (err) {
            console.error(LOG_PREFIX, 'Character import failed', err);
            toastr.error(String(err.message || err), 'SillyNPC');
        }
    };

    input.click();
}
