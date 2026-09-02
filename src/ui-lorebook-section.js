import { Popup } from '../../../../popup.js';
import { loadWorldInfo } from '../../../../world-info.js';
import { world_names } from '../../../../world-info.js';
import { saveSettings } from './settings.js';
import { escapeHtml } from './utils.js';
import { LOG_PREFIX } from './constants.js';
import { tryAutoSyncLorebook, updateLorebookEntry, deleteLorebookEntry } from './lorebook.js';
import { generateLoreEntry } from './ui-api.js';

/**
 * The lorebook block: link an entry, write one, generate one, or replace the link.
 *
 * Lifted out of the character editor so the player's sheet can have the same one. Nothing
 * in it is about characters specifically - it reads and writes `char.lorebook`, which the
 * player's card carries under the same name.
 *
 * The mode and the draft are module state rather than per-card, because only one of these
 * is ever open: the editor shows one character at a time and the player sheet shows one
 * player. resetLorebookState() is what the pages call when they navigate away, so a
 * half-finished edit cannot reappear against somebody else.
 */

/** 'view' | 'picking' | 'editing' - which of the three faces the block is showing. */
let lorebookMode = 'view';
/** The entry being picked or written, before it is saved. */
let lorebookDraft = null;

/**
 * Redraws the page the block is sitting on. Set on every render, because the block
 * rebuilds itself in place and the two pages redraw very differently.
 * @type {() => void}
 */
let onChange = () => {};

export function resetLorebookState() {
    lorebookMode = 'view'; lorebookDraft = null;
}

export async function renderLorebookSection(char, container, options = {}) {
    if (!container) return;
    if (options.onChange) onChange = options.onChange;
    container.className = 'sillynpc-editor-field sillynpc-lorebook-field';
    container.innerHTML = `<label>Lorebook</label>`;

    if (lorebookMode === 'picking') {
        container.appendChild(await buildLorebookPicker(char));
    } else if (lorebookMode === 'editing' && lorebookDraft) {
        container.appendChild(buildLorebookEditor(char));
    } else if (char.lorebook) {
        container.appendChild(await buildLorebookView(char));
    } else {
        const actions = document.createElement('div');
        actions.className = 'sillynpc-lorebook-actions';
        actions.innerHTML = `
            <button type="button" class="menu_button inject-btn"><i class="fa-solid fa-book"></i> Inject</button>
            <button type="button" class="menu_button sync-btn"><i class="fa-solid fa-rotate"></i> Sync</button>
            <button type="button" class="menu_button gen-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate</button>
        `;
        actions.querySelector('.inject-btn').addEventListener('click', () => { lorebookMode = 'picking'; lorebookDraft = { world: '', uid: null }; onChange(); });
        actions.querySelector('.sync-btn').addEventListener('click', async () => { await tryAutoSyncLorebook(char); onChange(); });
        actions.querySelector('.gen-btn').addEventListener('click', () => generateLoreEntry(char, { onSave: () => onChange() }));
        container.appendChild(actions);
    }
}

async function buildLorebookPicker(char) {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-lorebook-picker';
    wrap.innerHTML = `
        <div class="sillynpc-lorebook-row"><span>World:</span><select class="text_pole world-select"><option value="">-- select world --</option></select></div>
        <div class="sillynpc-lorebook-row"><span>Entry:</span><select class="text_pole entry-select" disabled><option value="">-- select entry --</option></select></div>
        <div class="sillynpc-lorebook-preview"></div>
        <div class="sillynpc-lorebook-actions">
            <button type="button" class="menu_button cancel-btn">Cancel</button>
            <button type="button" class="menu_button confirm-btn" disabled><i class="fa-solid fa-check"></i> Confirm</button>
        </div>
    `;

    const worldSelect = wrap.querySelector('.world-select');
    const entrySelect = wrap.querySelector('.entry-select');
    const preview = wrap.querySelector('.sillynpc-lorebook-preview');
    const confirmBtn = wrap.querySelector('.confirm-btn');

    // Undefined until SillyTavern has initialised.
    for (const w of (Array.isArray(world_names) ? world_names : [])) {
        const opt = document.createElement('option');
        opt.value = opt.textContent = w;
        if (w === lorebookDraft?.world) opt.selected = true;
        worldSelect.append(opt);
    }

    const updatePreview = async () => {
        preview.textContent = '';
        confirmBtn.disabled = true;
        if (!lorebookDraft?.world || lorebookDraft.uid == null) return;
        const entry = (await loadWorldInfo(lorebookDraft.world))?.entries?.[lorebookDraft.uid];
        if (entry) {
            preview.textContent = entry.content || '(empty)';
            confirmBtn.disabled = false;
        }
    };

    const populateEntries = async (worldName) => {
        entrySelect.innerHTML = '<option value="">-- select entry --</option>';
        if (!worldName) return entrySelect.disabled = true;
        const data = await loadWorldInfo(worldName);
        const entries = Object.values(data?.entries ?? {}).sort((a, b) => (a.comment || '').localeCompare(b.comment || '') || a.uid - b.uid);
        for (const e of entries) {
            const opt = document.createElement('option');
            opt.value = e.uid;
            opt.textContent = `${e.comment || `Entry #${e.uid}`}${e.key?.length ? ` [${e.key.slice(0, 3).join(', ')}]` : ''}`;
            if (e.uid === lorebookDraft?.uid) opt.selected = true;
            entrySelect.append(opt);
        }
        entrySelect.disabled = false;
    };

    worldSelect.addEventListener('change', async () => {
        if (lorebookDraft) { lorebookDraft.world = worldSelect.value; lorebookDraft.uid = null; }
        await populateEntries(worldSelect.value);
        updatePreview();
    });
    entrySelect.addEventListener('change', () => {
        if (lorebookDraft) lorebookDraft.uid = entrySelect.value ? Number(entrySelect.value) : null;
        updatePreview();
    });
    wrap.querySelector('.cancel-btn').addEventListener('click', () => { resetLorebookState(); onChange(); });
    confirmBtn.addEventListener('click', () => {
        if (lorebookDraft) { char.lorebook = { world: lorebookDraft.world, uid: lorebookDraft.uid }; saveSettings(); resetLorebookState(); onChange(); }
    });

    if (lorebookDraft?.world) { populateEntries(lorebookDraft.world).then(updatePreview); }
    return wrap;
}

async function buildLorebookView(char) {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-lorebook-view';
    wrap.innerHTML = `
        <div class="sillynpc-lorebook-header"><div class="sillynpc-lorebook-title">Loading...</div></div>
        <div class="sillynpc-lorebook-content">Loading...</div>
        <div class="sillynpc-lorebook-actions" style="display:flex; flex-wrap:wrap; gap:8px; margin-top:12px;">
            <button type="button" class="menu_button eject-btn" title="Forget the link. The entry stays in the lorebook."><i class="fa-solid fa-eject"></i> Unlink</button>
            <button type="button" class="menu_button change-btn"><i class="fa-solid fa-shuffle"></i> Change</button>
            <button type="button" class="menu_button edit-btn" disabled><i class="fa-solid fa-pen"></i> Edit</button>
            <button type="button" class="menu_button regen-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> Regen</button>
            <button type="button" class="menu_button delete-entry-btn" disabled title="Remove the entry from the lorebook entirely."><i class="fa-solid fa-trash"></i> Delete Entry</button>
        </div>
    `;

    const titleEl = wrap.querySelector('.sillynpc-lorebook-title');
    const contentEl = wrap.querySelector('.sillynpc-lorebook-content');
    const editBtn = wrap.querySelector('.edit-btn');
    const deleteBtn = wrap.querySelector('.delete-entry-btn');

    try {
        const data = await loadWorldInfo(char.lorebook.world);
        const entry = data?.entries?.[char.lorebook.uid];
        if (!entry) {
            // The entry was deleted in SillyTavern's own editor, or the world was
            // renamed. This used to be a dead end - the text said "(entry not found)"
            // and nothing on the panel could clear or replace the link.
            renderBrokenLink(wrap, char, titleEl, contentEl);
        } else {
            titleEl.textContent = `${char.lorebook.world} / ${entry.comment || `Entry #${entry.uid}`}`;
            contentEl.textContent = entry.content || '(empty)';
            editBtn.disabled = false;
            editBtn.addEventListener('click', () => {
                lorebookMode = 'editing'; lorebookDraft = { world: char.lorebook.world, uid: char.lorebook.uid, comment: entry.comment || '', content: entry.content || '' };
                onChange();
            });

            deleteBtn.disabled = false;
            deleteBtn.addEventListener('click', async () => {
                const name = entry.comment || `Entry #${entry.uid}`;
                const ok = await Popup.show.confirm('Delete lorebook entry',
                    `"${name}" will be removed from "${char.lorebook.world}" for good. `
                    + 'Unlink instead if you only want to detach it from this character.');
                if (!ok) return;
                try {
                    await deleteLorebookEntry(char.lorebook.world, char.lorebook.uid);
                    char.lorebook = null;
                    saveSettings();
                    toastr.success(`Deleted "${name}".`, 'SillyNPC');
                } catch (err) {
                    console.error(LOG_PREFIX, 'Failed to delete lorebook entry', err);
                    toastr.error(`Could not delete the entry: ${err.message || err}`, 'SillyNPC');
                }
                onChange();
            });
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'Failed to load lorebook entry', err);
        renderBrokenLink(wrap, char, titleEl, contentEl, err);
    }

    wrap.querySelector('.eject-btn').addEventListener('click', () => { char.lorebook = null; saveSettings(); onChange(); });
    wrap.querySelector('.change-btn').addEventListener('click', () => { lorebookMode = 'picking'; lorebookDraft = { ...char.lorebook }; onChange(); });
    wrap.querySelector('.regen-btn').addEventListener('click', () => generateLoreEntry(char, { onSave: () => onChange() }));

    return wrap;
}

/** What a link whose entry has gone offers instead of a dead end. */
function renderBrokenLink(wrap, char, titleEl, contentEl, err = null) {
    titleEl.textContent = `${char.lorebook.world} / #${char.lorebook.uid}`;
    contentEl.textContent = err
        ? `Could not open "${char.lorebook.world}": ${err.message || err}`
        : 'This entry no longer exists. It was probably deleted in SillyTavern, or the lorebook was renamed.';

    // Regenerating into an entry that is not there cannot work, and deleting it is
    // already done.
    wrap.querySelector('.regen-btn')?.remove();
    wrap.querySelector('.delete-entry-btn')?.remove();

    const actions = wrap.querySelector('.sillynpc-lorebook-actions');
    const relink = document.createElement('button');
    relink.type = 'button';
    relink.className = 'menu_button';
    relink.innerHTML = '<i class="fa-solid fa-link"></i> Re-link';
    relink.addEventListener('click', () => {
        lorebookMode = 'picking';
        lorebookDraft = { world: char.lorebook.world, uid: null };
        onChange();
    });
    actions.appendChild(relink);
}

function buildLorebookEditor(char) {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-lorebook-edit';
    if (!lorebookDraft) return wrap;
    wrap.innerHTML = `
        <div class="sillynpc-lorebook-meta">${escapeHtml(lorebookDraft.world)} / Entry #${escapeHtml(lorebookDraft.uid)}</div>
        <label>Title (comment)</label><input type="text" class="text_pole comment-input" value="${escapeHtml(lorebookDraft.comment)}">
        <label>Content</label><textarea class="text_pole sillynpc-lorebook-textarea" rows="10">${escapeHtml(lorebookDraft.content)}</textarea>
        <div class="sillynpc-lorebook-actions">
            <button type="button" class="menu_button cancel-btn">Cancel</button>
            <button type="button" class="menu_button save-btn"><i class="fa-solid fa-check"></i> Save</button>
        </div>
    `;
    wrap.querySelector('.comment-input').addEventListener('input', (e) => { if(lorebookDraft) lorebookDraft.comment = e.target.value; });
    wrap.querySelector('textarea').addEventListener('input', (e) => { if(lorebookDraft) lorebookDraft.content = e.target.value; });
    wrap.querySelector('.cancel-btn').addEventListener('click', () => { resetLorebookState(); onChange(); });
    wrap.querySelector('.save-btn').addEventListener('click', async () => {
        if (!lorebookDraft) return;
        try {
            await updateLorebookEntry(lorebookDraft.world, lorebookDraft.uid, {
                comment: lorebookDraft.comment,
                content: lorebookDraft.content
            });
            toastr.success('Saved.');
            resetLorebookState();
            onChange();
        } catch (err) {
            console.error(LOG_PREFIX, 'Failed to save lorebook entry', err);
            toastr.error('Failed to save entry.');
        }
    });
    return wrap;
}
