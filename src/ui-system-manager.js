import { getSettings } from './settings.js';
import { updateAllExtensionThemes } from './ui-shared.js';
import { deleteSystemPreset, importSystemPreset, getActiveSystem, setActiveSystem, createSystem, saveCheckpoint, restoreCheckpoint, deleteCheckpoint, getCheckpoints } from './status-logic.js';
import { Popup } from '../../../../popup.js';
import { triggerReprocess } from './chat.js';
import { updateHUD } from './ui-hud.js';
import { escapeHtml } from './utils.js';
import { openItemLibrary } from './ui-item-library.js';

/**
 * System Manager: saving, restoring and swapping whole Systems.
 *
 * Split out of status-settings.js. What a System is made of is System Builder's job.
 */

function exportSystem(name) {
    const settings = getSettings();
    const profile = settings.statusTracker.presets?.[name];
    if (!profile) return;
    
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_system.json`;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Save and restore controls for the active system.
 *
 * A system's snapshot is otherwise only rewritten when you switch away from it, so a
 * system you never leave keeps whatever it held the last time you did - which is how two
 * deleted characters stayed frozen inside one. These make the save deliberate, and keep
 * the previous ones so a change you regret is a restore rather than a rebuild.
 *
 * @param {() => void} onRefresh Redraws the manager, since saving changes the list.
 * @returns {HTMLElement}
 */
function buildCheckpointControls(onRefresh) {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-setting';

    const active = getActiveSystem();
    const preset = getSettings().statusTracker.presets?.[active];

    const title = document.createElement('div');
    title.className = 'sillynpc-setting-row';
    title.style.fontWeight = 'bold';
    title.textContent = active ? `Saved states of "${active}"` : 'Saved states';
    wrap.append(title);

    if (!active || !preset) {
        const none = document.createElement('small');
        none.className = 'notes';
        none.textContent = 'No system is active, so there is nothing to save.';
        wrap.append(none);
        return wrap;
    }

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex; gap:10px; flex-wrap:wrap; margin:8px 0;';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'menu_button';
    saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save state now';
    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        const { saved, kept, reason } = await saveCheckpoint('Manual save');
        saveBtn.disabled = false;
        if (!saved && reason === 'unchanged') {
            toastr.info('Nothing has changed since the last saved state.', 'SillyNPC');
            return;
        }
        if (!saved) {
            toastr.error('Could not write the saved state.', 'SillyNPC');
            return;
        }
        toastr.success(`Saved. ${kept} state${kept === 1 ? '' : 's'} kept.`, 'SillyNPC');
        onRefresh();
    });
    buttons.append(saveBtn);
    wrap.append(buttons);

    const history = getCheckpoints(preset);
    if (!history.length) {
        const none = document.createElement('small');
        none.className = 'notes';
        none.textContent = 'No states saved yet. Saving one now gives you something to come '
            + 'back to before you change anything you might regret.';
        wrap.append(none);
        return wrap;
    }

    const list = document.createElement('div');
    list.className = 'sillynpc-checkpoint-list';

    history.forEach((point, index) => {
        const row = document.createElement('div');
        row.className = 'sillynpc-checkpoint-row';

        const when = document.createElement('span');
        when.className = 'sillynpc-checkpoint-when';
        const cast = (point.world?.characters || []).length;
        when.textContent = `${new Date(point.savedAt).toLocaleString()} — ${point.label}`
            + ` (${cast} character${cast === 1 ? '' : 's'})`;

        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'menu_button';
        restore.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i> Restore';
        restore.addEventListener('click', async () => {
            const ok = await Popup.show.confirm(
                'Restore this saved state?',
                'Your characters, item library, persona records and this system\'s settings '
                + 'are replaced with the saved ones. The current state is saved first, so '
                + 'this can be undone by restoring that.',
            );
            if (!ok) return;
            if (await restoreCheckpoint(index)) {
                toastr.success('Restored.', 'SillyNPC');
                triggerReprocess();
                updateHUD();
                onRefresh();
            } else {
                toastr.error('Could not read that saved state; its file may be gone.', 'SillyNPC');
            }
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'menu_button';
        remove.title = 'Delete this saved state';
        remove.innerHTML = '<i class="fa-solid fa-trash"></i>';
        remove.addEventListener('click', async () => {
            if (await deleteCheckpoint(index)) onRefresh();
        });

        row.append(when, restore, remove);
        list.append(row);
    });

    wrap.append(list);

    const note = document.createElement('small');
    note.className = 'notes';
    note.style.marginTop = '6px';
    note.textContent = 'Each state holds a full copy of this system: its characters, item '
        + 'library, persona records and settings. They are written to user/files/ rather '
        + 'than into your settings, so keeping several costs nothing on every save. '
        + 'Restoring saves the current one first, so nothing is a one-way door.';
    wrap.append(note);

    return wrap;
}

export function buildSystemManager(onRefresh) {
    const wrap = document.createElement('div');
    const settings = getSettings();
    const presets = settings.statusTracker.presets || {};
    const presetNames = Object.keys(presets);

    const listWrap = document.createElement('div');
    listWrap.style.marginBottom = '20px';
    listWrap.style.maxHeight = '300px';
    listWrap.style.overflowY = 'auto';
    listWrap.style.border = '1px solid var(--sillynpc-border)';
    listWrap.style.borderRadius = '5px';

    if (presetNames.length === 0) {
        listWrap.innerHTML = `<div style="padding:15px; text-align:center; opacity:0.5;">No systems in library.</div>`;
    } else {
        const table = document.createElement('table');
        table.style.width = '100%';
        table.style.borderCollapse = 'collapse';
        
        presetNames.forEach(name => {
            const profile = presets[name];
            const row = document.createElement('tr');
            row.style.borderBottom = '1px solid var(--sillynpc-border)';
            
            const nameCell = document.createElement('td');
            nameCell.style.padding = '8px';
            // A system's cast is the thing you would most regret switching away from
            // without noticing, so the count is on the row rather than hidden inside it.
            const cast = name === getActiveSystem()
                ? (getSettings().characters || []).length
                : (profile.world?.characters || []).length;
            const detail = [
                profile.metadata?.description || '',
                profile.world ? `${cast} character${cast === 1 ? '' : 's'}` : 'rules only',
            ].filter(Boolean).join(' — ');
            nameCell.innerHTML = `<div style="font-weight:bold">${escapeHtml(name)}`
                + (name === getActiveSystem() ? ' <small style="opacity:0.6">(in use)</small>' : '')
                + `</div><small style="opacity:0.6">${escapeHtml(detail)}</small>`;
            
            const actionsCell = document.createElement('td');
            actionsCell.style.padding = '8px';
            actionsCell.style.textAlign = 'right';
            actionsCell.style.whiteSpace = 'nowrap';
            
            // Which system you are in used to be unknowable: the library listed four and
            // marked none. The radio both shows it and is how you change it.
            const activeCell = document.createElement('td');
            activeCell.style.cssText = 'padding:8px; width:1%;';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'sillynpc-active-system';
            radio.checked = name === getActiveSystem();
            radio.title = radio.checked ? 'In use' : `Switch to "${name}"`;
            radio.addEventListener('change', () => {
                if (!radio.checked) return;
                // The system being left is captured on the way out, so there is nothing
                // to remember to save and no way to lose a world by switching.
                setActiveSystem(name);
                updateAllExtensionThemes();
                onRefresh();
                triggerReprocess();
            });
            activeCell.append(radio);

            const expBtn = document.createElement('button');
            expBtn.className = 'menu_button';
            expBtn.title = 'Export to JSON';
            expBtn.innerHTML = '<i class="fa-solid fa-file-export"></i>';
            expBtn.addEventListener('click', () => exportSystem(name));

            const delBtn = document.createElement('button');
            delBtn.className = 'menu_button';
            delBtn.title = 'Delete';
            delBtn.style.color = 'var(--red)';
            delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
            delBtn.addEventListener('click', async () => {
                // Deleting the system in use would take the cast and item library with it
                // and leave the configuration belonging to nothing.
                if (name === getActiveSystem()) {
                    toastr.info('Switch to another system before deleting this one.', 'SillyNPC');
                    return;
                }
                const cast = (profile.world?.characters || []).length;
                const warning = cast
                    ? `Delete "${name}"? Its ${cast} character${cast === 1 ? '' : 's'}, `
                      + 'item library and persona records go with it.'
                    : `Delete the saved system "${name}"?`;
                if (await Popup.show.confirm('Delete system', warning)) {
                    deleteSystemPreset(name);
                    onRefresh();
                }
            });

            actionsCell.append(expBtn, delBtn);
            row.append(activeCell, nameCell, actionsCell);
            table.appendChild(row);
        });
        listWrap.appendChild(table);
    }

    // Global Actions
    const globalActions = document.createElement('div');
    globalActions.style.display = 'flex';
    globalActions.style.gap = '10px';
    globalActions.style.flexWrap = 'wrap';

    // "Save current as new" asked you to remember to do it, and every new ruleset began
    // as a copy of the last one. Switching now captures on the way out, so this is only
    // about starting something genuinely new.
    const newBtn = document.createElement('button');
    newBtn.className = 'menu_button';
    newBtn.style.flex = '1';
    newBtn.innerHTML = '<i class="fa-solid fa-plus"></i> New System';
    newBtn.title = 'Start a new system from the defaults, with no characters in it. '
        + 'The one you are in now is saved first.';
    newBtn.addEventListener('click', async () => {
        const name = (await Popup.show.input('New system', 'Name for this system:'))?.trim();
        if (!name) return;
        if (!createSystem(name)) {
            toastr.error(`A system called "${name}" already exists.`, 'SillyNPC');
            return;
        }
        updateAllExtensionThemes();
        onRefresh();
        triggerReprocess();
    });

    const importBtn = document.createElement('button');
    importBtn.className = 'menu_button';
    importBtn.style.flex = '1';
    importBtn.innerHTML = '<i class="fa-solid fa-file-import"></i> Import JSON';
    importBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    const text = await file.text();
                    importSystemPreset(text);
                    onRefresh();
                } catch (err) {
                    toastr.error(`Failed to import system: ${err.message}`, 'SillyNPC');
                }
            }
        };
        input.click();
    });

    const libraryBtn = document.createElement('button');
    libraryBtn.className = 'menu_button';
    libraryBtn.style.flex = '1';
    libraryBtn.innerHTML = '<i class="fa-solid fa-book"></i> Entry Library';
    libraryBtn.title = 'View and clean up what the extension remembers between chats - items, skills, spells, whatever your collections hold';
    libraryBtn.addEventListener('click', () => openItemLibrary());

    globalActions.append(newBtn, importBtn, libraryBtn);
    wrap.append(listWrap, globalActions, buildCheckpointControls(onRefresh));
    return wrap;
}
