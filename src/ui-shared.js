import { getSettings, saveSettings, defaultSettings } from './settings.js';
import { isStaticField } from './constants.js';
import { updateHUD } from './ui-hud.js';
import {
    loadStateFromMetadata,
    findMatchingStatKey,
    saveStateToMetadata,
    syncPlayerToMaster,
    addItem,
    removeItem,
    updateMasterItem,
    renameMasterItem,
    resolveMaxValue
} from './status-logic.js';
import { eventSource } from '../../../../events.js';
import { escapeHtml, computeStatBar } from './utils.js';
import { allThemeClasses, themeClassFor, SILLYNPC_THEMES } from './constants.js';
import { Popup } from '../../../../popup.js';
import { buildTokenReadout } from './tokens.js';

function getNestedValue(obj, path) {
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
}

function setNestedValue(obj, path, value) {
    const parts = path.split('.');
    const last = parts.pop();
    const target = parts.reduce((acc, part) => acc && acc[part], obj);
    if (target) target[last] = value;
}

/**
 * Hides a control that is only worth touching for a reason, unless dev mode is on.
 *
 * Hidden rather than removed, and hidden rather than never built: it stays in the page so
 * the checks that ask what a tab offers keep seeing it, and so turning dev mode on is a
 * redraw rather than a reload.
 *
 * @param {HTMLElement} wrap
 * @param {{ advanced?: boolean }} spec
 */
function markAdvanced(wrap, spec) {
    if (!spec?.advanced) return;
    wrap.dataset.advanced = 'true';
    if (!getSettings().devMode) wrap.style.display = 'none';
}
/**
 * @param {object} options
 * @param {string} [options.recommended] Adds a control that restores this text.
 *   A customised template silently keeps working while the recommended one moves on -
 *   the [FACTS] placeholder was added to the lore default and never reached anyone who
 *   had edited theirs, with nothing in the panel to say so.
 * @param {boolean} [options.showTokens] Adds a live token count under the box. What a
 *   prompt costs is decided when you write it, so it belongs where you write it - not
 *   discovered later from a bill. Counts the template as typed; the placeholders are
 *   filled at send time and cost whatever they are filled with.
 * @param {string} [options.emptyNote] Shown instead of a count when the box is empty,
 *   for the settings where empty means something other than "send nothing".
 */
export function buildSettingTextArea(options) {
    const { key, label, help, onChange, recommended, showTokens = false, emptyNote = '' } = options;
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-setting';
    // Says which setting this is, so a control can be found by what it writes rather
    // than by where it happens to be drawn - which is what a rearrangement changes.
    wrap.dataset.setting = key;
    markAdvanced(wrap, options);

    const text = document.createElement('label');
    text.className = 'sillynpc-setting-row';
    text.style.fontWeight = 'bold';
    text.textContent = label;
    wrap.append(text);

    const textarea = document.createElement('textarea');
    textarea.className = 'text_pole sillynpc-setting-textarea';
    textarea.rows = 6;
    textarea.style.marginTop = '6px';
    textarea.value = getNestedValue(getSettings(), key) ?? '';
    const tokens = showTokens
        ? buildTokenReadout(() => textarea.value, { note: emptyNote })
        : null;

    textarea.addEventListener('input', () => {
        setNestedValue(getSettings(), key, textarea.value);
        saveSettings();
        tokens?.refresh();
        onChange?.();
    });
    wrap.append(textarea);
    if (tokens) wrap.append(tokens.element);

    if (help) {
        const helpEl = document.createElement('small');
        helpEl.className = 'notes';
        helpEl.textContent = help;
        wrap.append(helpEl);
    }

    if (recommended) {
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'menu_button sillynpc-restore-recommended';
        restore.innerHTML = '<i class="fa-solid fa-rotate-left"></i> Restore recommended';
        restore.title = 'Replace this with the recommended template.';
        restore.addEventListener('click', async () => {
            if (textarea.value.trim() === String(recommended).trim()) {
                toastr.info('This is already the recommended template.', 'SillyNPC');
                return;
            }
            // It replaces work someone may have spent time on, so it asks.
            const ok = await Popup.show.confirm('Restore recommended template',
                'Your current text will be replaced. Copy it somewhere first if you want to keep it.');
            if (!ok) return;

            textarea.value = recommended;
            setNestedValue(getSettings(), key, recommended);
            saveSettings();
            tokens?.refresh();
            onChange?.();
        });
        wrap.append(restore);
    }

    return wrap;
}

export function buildSettingSelect(spec) {
    const { key, label, help, options, onChange } = spec;
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-setting';
    // Says which setting this is, so a control can be found by what it writes rather
    // than by where it happens to be drawn - which is what a rearrangement changes.
    wrap.dataset.setting = key;
    markAdvanced(wrap, spec);

    const row = document.createElement('div');
    row.className = 'sillynpc-setting-row';
    const text = document.createElement('label');
    text.className = 'sillynpc-setting-label';
    text.textContent = label;
    const select = document.createElement('select');
    select.className = 'text_pole';
    for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        select.append(o);
    }
    select.value = getNestedValue(getSettings(), key) ?? '';
    select.addEventListener('change', () => {
        setNestedValue(getSettings(), key, select.value);
        saveSettings();
        onChange?.();
    });
    row.append(text, select);
    wrap.append(row);

    if (help) {
        const helpEl = document.createElement('small');
        helpEl.className = 'notes';
        helpEl.style.marginTop = '4px';
        helpEl.style.display = 'block';
        helpEl.textContent = help;
        wrap.append(helpEl);
    }
    return wrap;
}

export function buildSettingToggle(options) {
    const { key, label, help, onChange } = options;
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-setting';
    // Says which setting this is, so a control can be found by what it writes rather
    // than by where it happens to be drawn - which is what a rearrangement changes.
    wrap.dataset.setting = key;
    markAdvanced(wrap, options);

    const row = document.createElement('label');
    row.className = 'checkbox_label sillynpc-setting-row';
    row.style.cursor = 'pointer';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'sillynpc-setting-label';
    labelSpan.textContent = label;
    labelSpan.style.fontWeight = '500';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!getNestedValue(getSettings(), key);
    input.addEventListener('change', () => {
        setNestedValue(getSettings(), key, input.checked);
        saveSettings();
        onChange?.();
    });
    
    row.append(labelSpan, input);
    wrap.append(row);

    if (help) {
        const helpEl = document.createElement('small');
        helpEl.className = 'notes';
        helpEl.style.marginTop = '4px';
        helpEl.style.display = 'block';
        helpEl.textContent = help;
        wrap.append(helpEl);
    }

    return wrap;
}

export function buildSettingSlider(options) {
    const { key, label, help, min = 0, max = 100, step = 1, suffix = '', onChange } = options;
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-setting';
    // Says which setting this is, so a control can be found by what it writes rather
    // than by where it happens to be drawn - which is what a rearrangement changes.
    wrap.dataset.setting = key;
    markAdvanced(wrap, options);

    const row = document.createElement('div');
    row.className = 'sillynpc-setting-row';
    const text = document.createElement('label');
    text.className = 'sillynpc-setting-label';
    text.textContent = label;
    
    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'slider-container';
    
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.step = step;
    // A missing value used to fall back to a hardcoded 50, which is out of range for
    // sliders like hudScale (0.5-2.0) and meaningless for the rest. Fall back to the
    // schema default for this exact key, then clamp into the slider's own range so the
    // control can never start outside the bounds it advertises.
    const schemaDefault = getNestedValue(defaultSettings, key);
    const raw = getNestedValue(getSettings(), key) ?? schemaDefault ?? min;
    const numeric = Number(raw);
    slider.value = String(Math.min(max, Math.max(min, Number.isFinite(numeric) ? numeric : min)));
    
    const valueDisp = document.createElement('span');
    valueDisp.className = 'slider-value';
    valueDisp.textContent = `${slider.value}${suffix}`;
    
    // The readout and the stored value follow the drag; the caller is told once, when
    // the drag ends.
    //
    // Reporting from 'input' meant every pixel of movement ran onChange, and onChange
    // rebuilds the whole settings panel - so the slider under the cursor was destroyed
    // and replaced several times a second, taking the drag, the focus and the scroll
    // position with it. Twelve controls in the tracker panel are sliders.
    slider.addEventListener('input', () => {
        valueDisp.textContent = `${slider.value}${suffix}`;
        setNestedValue(getSettings(), key, Number(slider.value));
    });

    slider.addEventListener('change', () => {
        saveSettings();
        onChange?.();
    });
    
    sliderContainer.append(slider, valueDisp);
    row.append(text, sliderContainer);
    wrap.append(row);

    if (help) {
        const helpEl = document.createElement('small');
        helpEl.className = 'notes';
        helpEl.style.marginTop = '4px';
        helpEl.style.display = 'block';
        helpEl.textContent = help;
        wrap.append(helpEl);
    }
    return wrap;
}

/**
 * A number the user types, with no ceiling.
 *
 * Sliders are the wrong control for a budget. A slider has to advertise a maximum, and any
 * maximum here is a guess about someone else's model: 10k tokens is extravagant on one
 * setup and nothing on another. The cap on Lore Reply Budget was 4000 and on the story
 * excerpt 200000, both arbitrary, and neither could be exceeded however much context the
 * user had bought.
 *
 * So: no max, and no min beyond refusing negatives. The value is repaired on read in
 * normalizeSettings rather than policed on entry, because clearing the box to retype is a
 * normal thing to do and must not be fought.
 *
 * @param {object} options
 * @param {string} options.key Settings key, dot-separated for nested values.
 * @param {string} options.label
 * @param {string} [options.help]
 * @param {string} [options.suffix] Unit shown after the field.
 * @param {() => void} [options.onChange] Called when the field is committed, not per keystroke.
 * @returns {HTMLElement}
 */
export function buildSettingNumber(options) {
    const { key, label, help, suffix = '', onChange } = options;
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-setting';
    // Says which setting this is, so a control can be found by what it writes rather
    // than by where it happens to be drawn - which is what a rearrangement changes.
    wrap.dataset.setting = key;
    markAdvanced(wrap, options);

    const row = document.createElement('div');
    row.className = 'sillynpc-setting-row';
    const text = document.createElement('label');
    text.className = 'sillynpc-setting-label';
    text.textContent = label;

    const field = document.createElement('input');
    field.type = 'number';
    field.min = '0';
    field.step = '1';
    field.className = 'text_pole sillynpc-number-input';

    const schemaDefault = getNestedValue(defaultSettings, key);
    const raw = getNestedValue(getSettings(), key) ?? schemaDefault ?? 0;
    field.value = String(raw);

    // Store per keystroke so nothing is lost if the panel is rebuilt mid-edit, but tell
    // the caller only on commit - onChange re-renders the panel, which would rip the
    // field out from under the cursor on every digit.
    field.addEventListener('input', () => {
        const numeric = Number(field.value);
        if (field.value.trim() !== '' && Number.isFinite(numeric) && numeric >= 0) {
            setNestedValue(getSettings(), key, Math.floor(numeric));
        }
    });

    field.addEventListener('change', () => {
        const numeric = Number(field.value);
        const value = field.value.trim() !== '' && Number.isFinite(numeric) && numeric >= 0
            ? Math.floor(numeric)
            : Number(schemaDefault) || 0;
        setNestedValue(getSettings(), key, value);
        field.value = String(value);
        saveSettings();
        onChange?.();
    });

    if (suffix) {
        const unit = document.createElement('span');
        unit.className = 'sillynpc-number-suffix';
        unit.textContent = suffix;
        const box = document.createElement('div');
        box.className = 'sillynpc-number-container';
        box.append(field, unit);
        row.append(text, box);
    } else {
        row.append(text, field);
    }
    wrap.append(row);

    if (help) {
        const helpEl = document.createElement('small');
        helpEl.className = 'notes';
        helpEl.style.marginTop = '4px';
        helpEl.style.display = 'block';
        helpEl.textContent = help;
        wrap.append(helpEl);
    }
    return wrap;
}

/**
 * Renders a collection for a given actor (Player or NPC).
 * @param {string} tabId The collection ID
 * @param {Object} actor The actor object (state.player or a character from state.characters)
 * @param {Object} settings The status tracker settings
 */
export function renderCollectionUI(tabId, actor, settings, options = {}) {
    const colDef = settings.collections.find(c => c.id === tabId);
    if (!colDef) return '';

    const items = (actor.collections && actor.collections[tabId]) || [];
    const isEditMode = options.isEditMode !== false; // default true
    // The caller's bulk-select handle, if it offers one. Rows are keyed by index here
    // rather than by name: two items can share a name, and the index is what the delete
    // below already works from.
    const bulk = options.bulk || null;

    return `
        <div class="sillynpc-collection-container">
            <div class="sillynpc-collection-actions" style="display:flex; gap:10px; margin-bottom: 10px;">
                ${options.showEditToggle ? 
                    `<button class="menu_button sillynpc-edit-toggle" style="white-space: nowrap; width: auto; min-width: max-content;">${isEditMode ? 'Disable Edit' : 'Enable Edit'}</button>` 
                    : ''}
                ${isEditMode ? `<button class="menu_button sillynpc-add-item" data-col="${escapeHtml(tabId)}" style="white-space: nowrap; width: auto; min-width: max-content;">Add New Item</button>` : ''}
                ${isEditMode && bulk ? '<span class="sillynpc-bulk-slot"></span>' : ''}
            </div>
            <div class="sillynpc-collection-list">
                ${items.map((item, idx) => `
                    <div class="sillynpc-item-card ${isEditMode ? '' : 'readonly-mode'}" data-idx="${idx}" data-col="${escapeHtml(tabId)}">
                        <div class="item-header" style="display:flex; gap:10px; align-items:flex-start; flex-wrap:wrap;">
                            ${bulk?.isActive() ? `<input type="checkbox" class="sillynpc-bulk-check item-bulk-check"${bulk.isSelected(idx) ? ' checked' : ''}>` : ''}
                            ${colDef.fields.filter(f => !f.isMultiline).map(f => {
                                const val = item[f.name] !== undefined ? item[f.name] : (f.defaultValue !== undefined ? f.defaultValue : (f.type === 'number' ? 0 : ''));
                                if (!isEditMode) {
                                    const width = f.isPrimary ? 'flex:1; min-width:150px;' : 'width:auto; min-width:80px;';
                                    return `
                                        <div class="readonly-field" style="${width}">
                                            <div class="field-label">${escapeHtml(f.label || f.name)}</div>
                                            <div class="field-value">${f.type === 'boolean' ? (val ? 'Yes' : 'No') : escapeHtml(String(val))}</div>
                                        </div>
                                    `;
                                } else {
                                    if (isChoiceField(f)) {
                                        const width = f.isPrimary ? 'flex:1; min-width:150px;' : 'width:110px;';
                                        return `<select class="text_pole item-field-input"
                                                        data-field="${escapeHtml(f.name)}"
                                                        style="${width}">${choiceOptionsHtml(f.options, val)}</select>`;
                                    }
                                    if (f.type === 'boolean') {
                                        return `
                                            <label style="display:flex; align-items:center; gap:5px;">
                                                <input type="checkbox" class="item-field-input" data-field="${escapeHtml(f.name)}" ${val ? 'checked' : ''}>
                                                <small>${escapeHtml(f.label || f.name)}</small>
                                            </label>
                                        `;
                                    }
                                    const width = f.isPrimary ? 'flex:1; min-width:150px;' : 'width:80px;';
                                    return `<input type="${f.type === 'number' ? 'number' : 'text'}" 
                                                   class="text_pole item-field-input" 
                                                   data-field="${escapeHtml(f.name)}" 
                                                   value="${escapeHtml(String(val))}" 
                                                   placeholder="${escapeHtml(f.label || f.name)}" 
                                                   style="${width}">`;
                                }
                            }).join('')}
                            ${isEditMode && !bulk?.isActive() ? `
                            <div class="item-actions" style="margin-left:auto;">
                                <i class="fa-solid fa-trash drop-item" title="Drop" style="cursor:pointer; color:var(--red); opacity:0.7;"></i>
                            </div>
                            ` : ''}
                        </div>
                        ${colDef.fields.filter(f => f.isMultiline).map(f => {
                            const val = item[f.name] || '';
                            if (!isEditMode) {
                                return `
                                    <div class="readonly-field multiline" style="width: 100%; margin-top: 8px;">
                                        <div class="field-label">${escapeHtml(f.label || f.name)}</div>
                                        <div class="field-value">${escapeHtml(val)}</div>
                                    </div>
                                `;
                            } else {
                                return `<textarea class="text_pole item-field-input" 
                                                 data-field="${escapeHtml(f.name)}" 
                                                 placeholder="${escapeHtml(f.label || f.name)}" 
                                                 style="width: 100%; margin-top: 8px; resize: vertical; min-height: 40px;">${escapeHtml(val)}</textarea>`;
                            }
                        }).join('')}
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

/**
 * Where an edit to this actor's belongings should be written.
 *
 * The handlers used to look the character up in the chat state and give up when they were
 * not there - so editing the belongings of anyone not in the current scene did nothing at
 * all. Delete never even asked; typed text stayed on screen until the panel redrew from
 * the card, and then reverted. The character page hands in a card-backed actor for exactly
 * that case, and this stops it being thrown away.
 *
 * @param {object} actor The actor the editor was opened with.
 * @param {boolean} isPlayer
 * @returns {{ target: object|null, state: object|null, offstage: boolean }}
 *   `state` is null off stage - there is no scene copy to write, only the card.
 */
export function resolveCollectionTarget(actor, isPlayer) {
    const state = loadStateFromMetadata();
    const inScene = isPlayer
        ? state.player
        : (state.characters || []).find(c => c.name === actor.name);

    if (inScene) return { target: inScene, state, offstage: false };

    // Not in the scene. The card is the only copy, and it is what seeds them when they
    // next walk in - so it is the right thing to edit, not a dead end.
    return { target: actor || null, state: null, offstage: true };
}

/**
 * Writes a belongings edit where it belongs, and tells the rest of the app only if it
 * matters.
 *
 * Exported because bulk delete is a second door onto the same act, and two doors that
 * save differently is how a deletion appears to work and then comes back.
 *
 * @param {string} label For the tracker's undo history.
 * @param {{state: object|null, offstage: boolean}} where From resolveCollectionTarget.
 * @param {boolean} isPlayer
 */
export function persistCollectionEdit(label, { state, offstage }, isPlayer) {
    if (offstage) {
        // The card lives in the settings, not in the chat. Nothing in the scene changed,
        // so nothing needs reprocessing either.
        saveSettings();
        return;
    }
    saveStateToMetadata(state, { label });
    if (isPlayer) syncPlayerToMaster(state, { authoritative: true });
    eventSource.emit('sillynpc-status-updated', state);
}

/**
 * Attaches event listeners for collection UI.
 * @param {HTMLElement} dom Container element
 * @param {Object} actor Actor object to update
 * @param {Function} onRefresh Callback to refresh the UI
 * @param {object|null} [bulk] A bulk-select handle, when the caller offers one.
 */
export function attachCollectionListeners(dom, actor, onRefresh, bulk = null) {
    const isPlayer = actor.name === 'Player' || actor.name === (loadStateFromMetadata().player?.name);

    // The bar is one element reused across redraws - it holds the selection - so it is
    // moved into the freshly drawn slot rather than rebuilt with the rest of the panel.
    if (bulk) {
        dom.querySelector('.sillynpc-bulk-slot')?.appendChild(bulk.bar);
        dom.querySelectorAll('.item-bulk-check').forEach(box => {
            const idx = box.closest('.sillynpc-item-card')?.dataset.idx;
            box.addEventListener('change', () => bulk.toggle(idx, box.checked));
        });
    }

    const persist = (label, where) => persistCollectionEdit(label, where, isPlayer);

    // Collection Actions
    dom.querySelectorAll('.sillynpc-add-item').forEach(btn => {
        if (btn.dataset.listenerAttached) return;
        btn.addEventListener('click', () => {
            const colId = btn.dataset.col;
            const settings = getSettings().statusTracker;
            const colDef = settings.collections.find(c => c.id === colId);
            const primaryField = colDef ? colDef.fields.find(f => f.isPrimary) : null;
            const newItemName = "";
            const newItem = { [primaryField ? primaryField.name : 'name']: newItemName };
            
            // Initialize fields with defaults
            if (colDef) {
                colDef.fields.forEach(f => {
                    if (f.isPrimary) return;
                    if (f.defaultValue !== undefined && f.defaultValue !== '') {
                        newItem[f.name] = f.type === 'number' ? parseFloat(f.defaultValue) : f.defaultValue;
                    } else {
                        if (f.type === 'number') newItem[f.name] = 0;
                        else if (f.type === 'boolean') newItem[f.name] = false;
                        else newItem[f.name] = "";
                    }
                });
            }

            const where = resolveCollectionTarget(actor, isPlayer);
            if (!where.target) return;

            addItem(where.target, colId, newItem);
            // A decision, not a reading of the state: authoritative, or the merge
            // guard puts back whatever master still remembers.
            persist('Item added', where);
            onRefresh?.();
        });
        btn.dataset.listenerAttached = 'true';
    });

    // Persisting on every keystroke was expensive and destructive: each character
    // typed deep-cloned the whole state into the history array, deep-cloned it again
    // into persona master storage, and emitted sillynpc-status-updated -- which
    // reprocesses every message in the chat. Typing a 13-character item name did all
    // of that 13 times, and renameMasterItem() left a Master DB entry for every
    // intermediate prefix ("s", "sw", "swo", ...).
    //
    // Now the write is debounced and also flushed on 'change' (blur/Enter), so a
    // rename is committed once, with its final value.
    const COMMIT_DELAY_MS = 400;

    const commitField = (input) => {
        const card = input.closest('.sillynpc-item-card');
        if (!card) return;
        const colId = card.dataset.col;
        const idx = parseInt(card.dataset.idx);
        const fieldName = input.dataset.field;

        const settings = getSettings().statusTracker;
        const colDef = settings.collections.find(c => c.id === colId);
        const primaryField = colDef ? colDef.fields.find(f => f.isPrimary) : { name: 'name' };
        const fieldDef = colDef ? colDef.fields.find(f => f.name === fieldName) : null;

        const where = resolveCollectionTarget(actor, isPlayer);
        const items = where.target?.collections?.[colId];
        if (!items || !items[idx]) return;

        let value = input.value;
        if (input.type === 'checkbox') value = input.checked;
        else if (input.type === 'number') value = parseFloat(input.value) || 0;

        // Nothing settled since the last commit - skip the whole write.
        if (items[idx][fieldName] === value) return;

        const oldName = items[idx][primaryField.name];
        items[idx][fieldName] = value;
        const newItem = items[idx];
        const newName = newItem[primaryField.name];

        // Master Database Updates
        const isPrimary = primaryField.name === fieldName;
        const isStatic = fieldDef ? isStaticField(fieldDef) : false;

        if (isPrimary && oldName !== newName) {
            renameMasterItem(colId, oldName, newName, newItem);
        } else if (isStatic) {
            updateMasterItem(colId, newName, newItem);
        }

        // A rename removes one key and adds another, so without this the old name is
        // merged back from master and the item exists twice.
        persist('Item edited', where);
    };

    dom.querySelectorAll('.item-field-input').forEach(input => {
        if (input.dataset.listenerAttached) return;

        let timer = null;
        const flush = () => {
            if (timer) { clearTimeout(timer); timer = null; }
            commitField(input);
        };

        input.addEventListener('input', () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(flush, COMMIT_DELAY_MS);
        });
        // Blur, Enter, and checkbox/select toggles commit immediately.
        input.addEventListener('change', flush);
        input.addEventListener('blur', flush);

        input.dataset.listenerAttached = 'true';
    });

    dom.querySelectorAll('.drop-item').forEach(btn => {
        if (btn.dataset.listenerAttached) return;
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const card = btn.closest('.sillynpc-item-card');
            const colId = card.dataset.col;
            const idx = parseInt(card.dataset.idx);

            const where = resolveCollectionTarget(actor, isPlayer);
            const items = where.target?.collections?.[colId];

            if (items && items[idx]) {
                const item = items[idx];
                const settings = getSettings().statusTracker;
                const colDef = settings.collections.find(c => c.id === colId);
                const primaryField = colDef ? colDef.fields.find(f => f.isPrimary) : { name: 'name' };
                const itemName = item[primaryField.name] || 'Item';

                if (await Popup.show.confirm('Delete item', `Delete "${itemName}"?`)) {
                    // Take it off this character, and leave the library alone: dropping a
                    // sword should not delete what a sword is for everyone else.
                    // The tombstone that stops an item creeping back is about this chat,
                    // so it is only worth writing for someone who is in it.
                    removeItem(where.target, colId, itemName, !where.offstage);
                    // Authoritative, or the merge guard restores it from master and the
                    // deletion appears to do nothing at all.
                    persist('Item dropped', where);
                    onRefresh?.();
                }
            }
        });
        btn.dataset.listenerAttached = 'true';
    });
}

/** The framings that are valid CSS in the position this lands in. */
const PORTRAIT_FRAMINGS = ['top', 'center', 'bottom'];

/**
 * Publishes the chosen portrait framing for the stylesheet to read.
 *
 * One write on the document element, rather than a rule per portrait: the HUD circle and
 * the tracker box's NPC portraits both read `--sillynpc-portrait-focus`, and anything round
 * added later gets it for free.
 *
 * An unrecognised stored value becomes `top` rather than reaching the stylesheet, where an
 * invalid position is silently dropped and the portrait quietly reverts to whatever the
 * browser defaults to.
 *
 * @returns {string} The framing actually applied.
 */
/**
 * Writes the speech-block padding to the document root.
 *
 * A root variable rather than a class, because two rules read it - the plain block and the
 * coloured-background variant - and they have to move together.
 *
 * @returns {number} The applied value, after clamping.
 */
export function applySpeechPadding() {
    const raw = Number(getSettings().speechPadY);
    // Clamped rather than trusted: a negative padding is valid CSS and pulls neighbouring
    // blocks into each other, which looks like a rendering fault rather than a setting.
    const padding = Number.isFinite(raw) ? Math.max(0, Math.min(40, Math.round(raw))) : 6;
    document.documentElement?.style?.setProperty('--sillynpc-speech-pad-y', `${padding}px`);
    return padding;
}

export function applyPortraitFraming() {
    const stored = String(getSettings().portraitFraming ?? '').trim().toLowerCase();
    const framing = PORTRAIT_FRAMINGS.includes(stored) ? stored : 'top';
    document.documentElement?.style?.setProperty('--sillynpc-portrait-focus', framing);
    return framing;
}

/**
 * Updates the extension theme classes on all open extension windows.
 */
export function updateAllExtensionThemes() {
    // Target all active SillyNPC containers in the DOM
    const manageContainers = document.querySelectorAll('.sillynpc-manage, .sillynpc-player-sheet');
    manageContainers.forEach(container => {
        updateExtensionTheme(container);
    });

        // Target all status boxes in the chat
        const statusContainers = document.querySelectorAll('.sillynpc-status-tracker-container');
        statusContainers.forEach(container => {
            const box = container.querySelector('.sillynpc-status-box') || container;
            updateExtensionTheme(box);
            
            // Fix: Re-calculate progress bar widths if they exist in this box
            const state = loadStateFromMetadata();
            const playerStats = getSettings().statusTracker.playerStats;
            
            container.querySelectorAll('.sillynpc-hud-bar').forEach(bar => {
                const statClass = Array.from(bar.classList).find(c => c !== 'sillynpc-hud-bar');
                if (statClass) {
                    const statDef = playerStats.find(s => s.name.toLowerCase().replace(/\s+/g, '-') === statClass);
                    if (statDef && state.player && state.player.stats) {
                        const actualKey = findMatchingStatKey(state.player.stats, statDef.name) || statDef.name;
                        const rawValue = state.player.stats[actualKey] || statDef.defaultValue || '0';
                        const { percent } = computeStatBar({
                            rawValue,
                            min: statDef.min,
                            max: resolveMaxValue(statDef),
                        });
                        bar.style.width = `${percent}%`;
                    }
                }
            });
        });

    // Update the HUD
    updateHUD();
}

/**
 * Updates the extension theme classes on the given root and its parent popup.
 * @param {HTMLElement} root The root element of the extension UI
 * @param {Popup} [popupInstance] Optional popup instance to target
 */
export function updateExtensionTheme(root, popupInstance = null) {
    if (!root) return;
    const style = getSettings().menuStyle || 'default';
    const container = root.classList.contains('sillynpc-manage') || root.classList.contains('sillynpc-player-sheet') ? root : root.querySelector('.sillynpc-manage') || root.querySelector('.sillynpc-player-sheet');
    if (!container) return;
    
    const themeClasses = allThemeClasses();
    container.classList.remove(...themeClasses);

    const isSillyNPCTheme = SILLYNPC_THEMES.includes(style);
    const themeClass = themeClassFor(style);
    
    // Fallback: if it's a SillyTavern native theme not in our special list, still try to add it
    // so CSS variables from that theme can be used.
    container.classList.add(themeClass);
    if (!isSillyNPCTheme && style !== 'default') {
        container.classList.add(`sillynpc-theme-${style}`);
    }

    // Text size, as a multiplier of whatever the theme sets rather than a size of its own,
    // so a theme that ships larger type stays proportionally itself. Set here because this
    // is the one function every menu and sheet goes through to be themed.
    const menuScale = Number(getSettings().menuFontScale);
    container.style.setProperty('--sillynpc-font-scale',
        String(Number.isFinite(menuScale) && menuScale > 0 ? menuScale : 1));
    
    // Target the actual SillyTavern Popup dialog element
    const dlg = popupInstance?.dlg || container.closest('.popup, #dialogue_popup');
    if (dlg) {
        dlg.classList.remove(...themeClasses);
        dlg.classList.add(themeClass);
        // Force theme inheritance on the popup dialog wrapper
        dlg.style.setProperty('color', 'var(--sillynpc-fg-primary)', 'important');
        dlg.style.setProperty('font-family', 'var(--sillynpc-font-family)', 'important');
    }
}

/**
 * Repositions SillyTavern's default close button inside our visual container.
 * Solves the issue where the "X" button floats far away on customized layouts.
 *
 * It **moves the node**, rather than styling it where it sits. So `visualContent` must be
 * an element the panel never replaces the children of: the Entry Library handed in its own
 * scrolling root and redrew it on every delete, keystroke and rename, which destroyed the
 * only visible way out of the popup. Give this a wrapper and redraw a child of it.
 *
 * Safe to call again - appendChild on a child already there just moves it - and calling it
 * again is how a button that has been wiped comes back, since popupInstance.closeButton
 * still references the detached node.
 */
export function repositionCloseButton(popupInstance, visualContent) {
    if (!popupInstance || !popupInstance.dlg || !visualContent) return;

    // SillyTavern's close control is '.popup-button-close', and Popup exposes it as
    // .closeButton (popup.js:256). The previous selector list - '.popup_close,
    // #dialogue_popup_close, .close_button' - matched none of them, so this function
    // silently did nothing and the X floated outside the styled panel.
    const closeBtn = popupInstance.closeButton
        || popupInstance.dlg.querySelector('.popup-button-close');
    if (!closeBtn) return;

    visualContent.style.position = 'relative';
    visualContent.appendChild(closeBtn);
    closeBtn.style.cssText = 'position: absolute; top: var(--sillynpc-space-md); '
        + 'right: var(--sillynpc-space-md); cursor: pointer; '
        + 'z-index: var(--sillynpc-z-modal); margin: 0;';
}
/**
 * The entries a choice dropdown offers, in order.
 *
 * A stored value that is no longer on the list gets an entry of its own, marked, and stays
 * selected. Narrowing a list in the builder must not silently rewrite characters nobody
 * was looking at, and a dropdown that simply omits the value would look like nothing is
 * chosen while the sheet says otherwise.
 *
 * The blank entry is always there: empty means "use the default" on a card, and a value
 * you cannot take back is worse than one you can.
 *
 * @param {string[]} options
 * @param {string} current
 * @returns {{ value: string, label: string, selected: boolean }[]}
 */
export function choiceEntries(options, current) {
    const allowed = (options || []).map(v => String(v ?? '').trim()).filter(Boolean);
    const value = String(current ?? '').trim();

    const entries = [{ value: '', label: '(default)', selected: value === '' }];
    for (const allowedValue of allowed) {
        entries.push({ value: allowedValue, label: allowedValue, selected: allowedValue === value });
    }
    if (value && !allowed.includes(value)) {
        entries.push({ value, label: `${value} (no longer allowed)`, selected: true });
    }
    return entries;
}

/** The same list as DOM, for the editors that build elements. */
export function buildChoiceSelect(options, current) {
    const select = document.createElement('select');
    select.className = 'text_pole sillynpc-choice-select';
    for (const entry of choiceEntries(options, current)) {
        const option = document.createElement('option');
        option.value = entry.value;
        option.textContent = entry.label;
        select.append(option);
    }
    select.value = String(current ?? '').trim();
    return select;
}

/** The same list as markup, for the editors that build HTML strings. */
export function choiceOptionsHtml(options, current) {
    return choiceEntries(options, current)
        .map(entry => `<option value="${escapeHtml(entry.value)}"${entry.selected ? ' selected' : ''}>`
            + `${escapeHtml(entry.label)}</option>`)
        .join('');
}

/** Whether this definition restricts what it may hold. */
export function isChoiceField(def) {
    return (def?.options || []).some(v => String(v ?? '').trim());
}

/**
 * Hides a heading whose every control is hidden.
 *
 * Marking settings advanced empties whole sections - If Something Goes Wrong is three
 * budgets and nothing else - and a heading with nothing under it reads as something that
 * failed to load rather than as something deliberately not shown.
 *
 * By what is visible rather than by what it knows: a section can hold a button, a note or
 * a connection picker as well as settings, and a rule naming the kinds it expects would
 * hide a section the moment somebody put something else in one.
 *
 * @param {HTMLElement} view A rendered panel.
 */
export function hideEmptySections(view) {
    if (!view) return;
    const isHeading = (el) => {
        const cls = String(el?.className || '');
        return cls.includes('sillynpc-section-title') || cls.includes('sillynpc-subsection-title');
    };

    const children = [...(view.children || [])];
    for (let i = 0; i < children.length; i++) {
        if (!isHeading(children[i])) continue;

        let anythingVisible = false;
        let j = i + 1;
        for (; j < children.length && !isHeading(children[j]); j++) {
            if (children[j].style?.display !== 'none') { anythingVisible = true; break; }
        }
        children[i].style.display = anythingVisible ? '' : 'none';
    }
}
