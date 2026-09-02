import { getSettings, saveSettings } from './settings.js';
import { getContext } from '../../../../st-context.js';

/**
 * Which connection answers which request.
 *
 * Shared rather than owned by a tab: the tracker's pickers and the lore tab's picker are
 * the same control over different settings, and the one time they were not, choosing a
 * Scan Connection silently changed the extraction connection instead.
 */

function profileStore(scope) {
    return scope === 'root' ? getSettings() : getSettings().statusTracker;
}

/** The profile currently chosen for one setting. */
export function readProfileSetting(scope, key) {
    return profileStore(scope)[key] || '';
}

/**
 * Records the profile chosen for one setting, and only that one.
 *
 * The picker used to read and write `extractionProfileId` whatever key it was handed, so
 * choosing a **Scan Connection** silently changed the extraction connection instead, both
 * dropdowns showed the same value, and `scanProfileId` could never be set at all - even
 * though the scan reads it (`src/history-scan.js`).
 */
export function writeProfileSetting(scope, key, value) {
    profileStore(scope)[key] = value;
    saveSettings();
}

/**
 * A "which connection runs this" dropdown.
 *
 * @param {Function} onChange
 * @param {{ key?: string, scope?: 'tracker'|'root', labelText?: string,
 *           fallbackLabel?: string, noteText?: string, unavailableText?: string }} options
 */
export function buildConnectionProfilePicker(onChange, options = {}) {
    const {
        key = 'extractionProfileId',
        scope = 'tracker',
        labelText = 'Extraction Connection',
        fallbackLabel = 'Main API (same as chat)',
        noteText = 'Which connection runs the extraction. A small fast model is usually '
            + 'enough, and keeps this off the budget of your main model.',
        unavailableText = 'Connection Manager is not available, so the extraction uses '
            + 'your main API. Enable the Connection Manager extension to run it on a '
            + 'separate, cheaper model.',
    } = options;

    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-setting';

    const row = document.createElement('div');
    row.className = 'sillynpc-setting-row';
    const label = document.createElement('label');
    label.className = 'sillynpc-setting-label';
    label.textContent = labelText;

    const note = document.createElement('small');
    note.className = 'notes';
    note.style.cssText = 'margin-top:4px; display:block;';

    let profiles = null;
    try {
        profiles = getContext().ConnectionManagerRequestService.getSupportedProfiles();
    } catch (err) {
        debugLogSafe('Connection Manager unavailable for the extraction picker', err);
    }

    if (!profiles) {
        note.textContent = unavailableText;
        row.append(label);
        wrap.append(row, note);
        return wrap;
    }

    const select = document.createElement('select');
    select.className = 'text_pole';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = fallbackLabel;
    select.append(none);
    for (const profile of profiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name || profile.id;
        select.append(option);
    }
    select.value = readProfileSetting(scope, key);
    select.addEventListener('change', () => {
        writeProfileSetting(scope, key, select.value);
        onChange?.();
    });

    note.textContent = noteText;
    row.append(label, select);
    wrap.append(row, note);
    return wrap;
}

/** Console noise from an optional integration is not worth a hard failure. */
function debugLogSafe(message, err) {
    try { console.debug('[SillyNPC]', message, err); } catch { /* ignore */ }
}
