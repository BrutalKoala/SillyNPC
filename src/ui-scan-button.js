import { getSettings } from './settings.js';
import { LOG_PREFIX } from './constants.js';
import { scanHistoryForCollections, estimateScan } from './history-scan.js';

/**
 * The scan button, beside SillyTavern's own options button on the send bar.
 *
 * It sits there rather than in the extension panel because it is used mid-play - you
 * notice the inventory has drifted and want it caught up without leaving the chat.
 */

const BUTTON_ID = 'sillynpc-scan-button';

/** Adds the button once. Safe to call repeatedly. */
function mountScanButton() {
    if (document.getElementById(BUTTON_ID)) return;
    const host = document.getElementById('leftSendForm');
    if (!host) return;

    const button = document.createElement('div');
    button.id = BUTTON_ID;
    button.className = 'fa-solid fa-clipboard-list interactable sillynpc-scan-button';
    button.tabIndex = 0;
    button.title = 'Read the chat history and bring inventories, spells and skills up to date.';
    button.addEventListener('click', onScanClicked);
    host.appendChild(button);
}

function unmountScanButton() {
    document.getElementById(BUTTON_ID)?.remove();
}

/** Reflects the setting, so turning the tracker off takes the button with it. */
export function refreshScanButton() {
    const settings = getSettings().statusTracker;
    if (settings.enabled && settings.scanButtonEnabled !== false) mountScanButton();
    else unmountScanButton();
}

async function onScanClicked() {
    const button = document.getElementById(BUTTON_ID);
    if (button?.classList.contains('sillynpc-scanning')) return;

    const estimate = estimateScan();
    if (!estimate.messages) {
        toastr.info('Nothing in this chat to scan yet.', 'SillyNPC');
        return;
    }

    // A scan is a real request against the user's own quota, and the size is worth
    // seeing before it is spent - a whole-chat scan is not a small ask.
    const confirmed = await confirmScan(estimate);
    if (!confirmed) return;

    button?.classList.add('sillynpc-scanning');
    try {
        const result = await scanHistoryForCollections(({ chunk, of }) => {
            if (of > 1) button.title = `Reading the history - pass ${chunk} of ${of}...`;
        });
        if (!result.ok) {
            toastr.error(result.reason || 'The scan did not complete.', 'SillyNPC');
            return;
        }
        const scope = result.passes > 1
            ? `${result.messages} messages over ${result.passes} passes`
            : `${result.messages} messages`;
        if (result.skipped?.length) {
            const names = result.skipped.slice(0, 2).join(' and ');
            const rest = result.skipped.length > 2 ? ` and ${result.skipped.length - 2} others` : '';
            toastr.warning(
                `${result.skipped.length} finding${result.skipped.length === 1 ? '' : 's'} ignored: `
                + `${names}${rest} ${result.skipped.length === 1 ? 'has' : 'have'} no character card.`,
                'SillyNPC');
        }
        if (result.failures) {
            toastr.warning(`${result.failures} of ${result.passes} passes came back unusable.`, 'SillyNPC');
        }
        if (!result.pending) {
            toastr.success(`Read ${scope}. Nothing to change.`, 'SillyNPC');
            return;
        }
        toastr.info(
            `${result.pending} proposed change${result.pending === 1 ? '' : 's'} waiting under the last message.`,
            'SillyNPC');
    } catch (err) {
        console.error(LOG_PREFIX, 'Scan failed', err);
        toastr.error(String(err?.message || err), 'SillyNPC');
    } finally {
        button?.classList.remove('sillynpc-scanning');
    }
}

async function confirmScan({ messages, approxTokens, truncated, eligible, passes }) {
    const lines = [
        `Read ${messages} of ${eligible} message${eligible === 1 ? '' : 's'} `
            + `(roughly ${approxTokens.toLocaleString()} tokens) and propose what each `
            + 'character should be carrying and know.',
        '',
        passes > 1
            ? `This takes ${passes} passes, so ${passes} requests.`
            : 'This takes one request.',
        '',
        'Nothing is applied on its own - every change waits for you in the review panel.',
    ];
    if (truncated) {
        // Naming the setting matters: the old wording said the history was trimmed and
        // left the reader to guess which of two limits did it.
        lines.push('', `${eligible - messages} older messages will not be read - raise `
            + '"Passes Allowed" in the tracker settings to cover the whole story.');
    }
    const text = lines.join('\n');

    try {
        const { POPUP_TYPE, Popup } = await import('../../../../popup.js');
        const popup = new Popup(text.replace(/\n/g, '<br>'), POPUP_TYPE.CONFIRM, '', {
            okButton: 'Scan', cancelButton: 'Cancel',
        });
        return Boolean(await popup.show());
    } catch {
        // Popup is part of SillyTavern; if it moves, ask the plain way rather than
        // spending the request unannounced.
        return window.confirm(text);
    }
}
