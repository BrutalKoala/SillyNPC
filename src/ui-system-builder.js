import { getSettings, saveSettings } from './settings.js';
import { Popup } from '../../../../popup.js';
import { updateHUD } from './ui-hud.js';
import { escapeHtml, moveInList } from './utils.js';
import { buildBulkBar, buildBulkCheckbox, spliceIndexes } from './ui-bulk-select.js';
import { renameCollectionId, renameCollectionField, renameStat } from './status-logic.js';

/**
 * System Builder: the stats, collections and fields a System is made of.
 *
 * Split out of status-settings.js. Editing what a System contains is a different job from
 * saving, restoring and swapping whole Systems, which is System Manager's.
 */

let systemBuilderActiveTab = 'global';

export function buildSystemBuilder(onRefresh) {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-system-builder';
    wrap.style.border = '1px solid var(--sillynpc-border-color)';
    wrap.style.borderRadius = '8px';
    wrap.style.overflow = 'hidden';

    const tabs = document.createElement('div');
    tabs.style.display = 'flex';
    tabs.style.background = 'var(--sillynpc-bg-secondary)';
    tabs.style.borderBottom = '1px solid var(--sillynpc-border-color)';

    const content = document.createElement('div');
    content.style.padding = '15px';

    const tabList = [
        { id: 'global', label: 'Global' },
        { id: 'npc', label: 'NPC' },
        { id: 'player', label: 'Player' },
        { id: 'collections', label: 'Collections' }
    ];

    const renderTabs = () => {
        tabs.replaceChildren();
        tabList.forEach(tab => {
            const btn = document.createElement('div');
            btn.textContent = tab.label;
            btn.style.padding = '8px 15px';
            btn.style.cursor = 'pointer';
            btn.style.flex = '1';
            btn.style.textAlign = 'center';
            if (systemBuilderActiveTab === tab.id) {
                // A white wash, which is no wash at all on the light themes - the open tab
                // there was indistinguishable from the two beside it. Mixed from the text
                // colour instead, so it darkens a light theme and lightens a dark one.
                btn.style.background = 'color-mix(in srgb, currentColor 12%, transparent)';
                btn.style.fontWeight = 'bold';
            }
            btn.addEventListener('click', () => {
                systemBuilderActiveTab = tab.id;
                renderTabs();
                renderContent();
            });
            tabs.appendChild(btn);
        });
    };

    const renderContent = () => {
        content.replaceChildren();
        if (systemBuilderActiveTab === 'global') {
            content.appendChild(buildStatsEditor('Global Stats', 'globalStats', onRefresh));
        } else if (systemBuilderActiveTab === 'npc') {
            content.appendChild(buildStatsEditor('NPC Stats', 'npcStats', onRefresh));
        } else if (systemBuilderActiveTab === 'player') {
            content.appendChild(buildStatsEditor('Player Stats', 'playerStats', onRefresh));
        } else if (systemBuilderActiveTab === 'collections') {
            content.appendChild(buildCollectionsEditor(onRefresh));
        }
    };

    renderTabs();
    renderContent();
    wrap.append(tabs, content);
    return wrap;
}

function buildCollectionsEditor(onRefresh) {
    const wrap = document.createElement('div');
    const settings = getSettings().statusTracker;
    const collections = settings.collections || [];

    // Migration logic: convert string fields to object fields
    collections.forEach(col => {
        if (Array.isArray(col.fields) && col.fields.length > 0 && typeof col.fields[0] === 'string') {
            col.fields = col.fields.map(fieldName => ({
                name: fieldName,
                type: fieldName === 'quantity' ? 'number' : 'text',
                label: fieldName.charAt(0).toUpperCase() + fieldName.slice(1),
                isMultiline: fieldName === 'description',
                isPrimary: fieldName === 'name',
                defaultValue: fieldName === 'quantity' ? '1' : ''
            }));
            saveSettings();
        }
    });

    const bulk = statsBulkBar('collections', onRefresh, 'collection');
    wrap.appendChild(bulk.bar);

    collections.forEach((col, index) => {
        const colWrap = document.createElement('div');
        colWrap.className = 'sillynpc-alias-row';
        colWrap.style.marginBottom = '20px';
        colWrap.style.padding = '15px';
        colWrap.style.background = 'var(--sillynpc-bg-secondary)';
        colWrap.style.borderRadius = '8px';
        colWrap.style.border = '1px solid var(--sillynpc-border-color)';

        colWrap.innerHTML = `
            <div style="display:flex; gap:8px; width:100%; margin-bottom:12px;">
                <input type="text" class="text_pole col-name" value="${escapeHtml(col.name)}" placeholder="Collection Name" style="flex:2">
                <input type="text" class="text_pole col-id" value="${escapeHtml(col.id)}" placeholder="id (slug)" style="flex:1">
                <select class="text_pole col-target" style="flex:1">
                    <option value="all" ${col.target === 'all' ? 'selected' : ''}>All Targets</option>
                    <option value="player" ${col.target === 'player' ? 'selected' : ''}>Player Only</option>
                    <option value="npc" ${col.target === 'npc' ? 'selected' : ''}>NPCs Only</option>
                </select>
                <label style="display:flex; align-items:center; gap:4px; margin-right:10px; cursor:pointer;" title="Visible in Tracker">
                    <input type="checkbox" class="col-visible" ${col.visible !== false ? 'checked' : ''}>
                    <small>Visible</small>
                </label>
                <button type="button" class="menu_button move-up-btn" title="Move Up" ${index === 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
                <button type="button" class="menu_button move-down-btn" title="Move Down" ${index === collections.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-arrow-down"></i></button>
                <button type="button" class="menu_button delete-btn" title="Delete Collection" style="color: var(--sillynpc-danger);"><i class="fa-solid fa-trash"></i></button>
            </div>
            <div class="fields-container" style="margin-left: 20px; border-left: 2px solid var(--sillynpc-border, rgba(128,128,128,0.25)); padding-left: 15px;">
                <div style="margin-bottom: 8px;"><small style="opacity:0.6; font-weight:bold; text-transform:uppercase; letter-spacing:0.05em;">Fields Configuration</small></div>
                <div class="fields-list"></div>
                <button type="button" class="menu_button add-field-btn" style="font-size:0.85em; padding:2px 10px; margin-top:8px;">
                    <i class="fa-solid fa-plus"></i> Add Field
                </button>
            </div>
        `;

        const fieldsList = colWrap.querySelector('.fields-list');
        const renderFields = () => {
            fieldsList.replaceChildren();
            col.fields.forEach((field, fIdx) => {
                const fRow = document.createElement('div');
                fRow.style.display = 'flex';
                fRow.style.gap = '5px';
                fRow.style.marginBottom = '5px';
                fRow.style.alignItems = 'center';
                
                fRow.innerHTML = `
                    <input type="text" class="text_pole f-name" value="${escapeHtml(field.name)}" placeholder="Key" style="width:60px; font-size:0.8em;" title="Field key (e.g. weight)">
                    <input type="text" class="text_pole f-label" value="${escapeHtml(field.label || '')}" placeholder="Label" style="flex:1; font-size:0.8em;" title="Display Label">
                    <input type="text" class="text_pole f-default" value="${escapeHtml(field.defaultValue !== undefined ? field.defaultValue : '')}" placeholder="Def" style="width:40px; font-size:0.8em;" title="Default Value">
                    <select class="text_pole f-type" style="width:65px; font-size:0.8em;">
                        <option value="text" ${field.type === 'text' ? 'selected' : ''}>Text</option>
                        <option value="number" ${field.type === 'number' ? 'selected' : ''}>Num</option>
                        <option value="boolean" ${field.type === 'boolean' ? 'selected' : ''}>Bool</option>
                    </select>
                    <label style="display:flex; align-items:center; gap:2px; cursor:pointer;" title="Primary identifier">
                        <input type="checkbox" class="f-primary" ${field.isPrimary ? 'checked' : ''}>
                        <small style="font-size:0.7em; opacity:0.7;">Pri</small>
                    </label>
                    <label style="display:flex; align-items:center; gap:2px; cursor:pointer;" title="Allow multiple lines (for text type)">
                        <input type="checkbox" class="f-multiline" ${field.isMultiline ? 'checked' : ''} ${field.type !== 'text' ? 'disabled' : ''}>
                        <small style="font-size:0.7em; opacity:0.7;">Multi</small>
                    </label>
                    <label style="display:flex; align-items:center; gap:2px; cursor:pointer;" title="Is this field static (preserved in Master Database)?">
                        <input type="checkbox" class="f-static" ${field.isStatic !== false ? 'checked' : ''}>
                        <small style="font-size:0.7em; opacity:0.7;">Static</small>
                    </label>
                    <input type="text" class="text_pole f-options"
                           value="${escapeHtml((field.options || []).join(', '))}"
                           placeholder="Any value"
                           title="Allowed values, separated by commas. Leave empty to allow anything."
                           style="width:110px; font-size:0.8em;">
                    <button type="button" class="menu_button move-field-up" title="Move up" style="padding:0 5px;" ${fIdx === 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
                    <button type="button" class="menu_button move-field-down" title="Move down" style="padding:0 5px;" ${fIdx === col.fields.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-arrow-down"></i></button>
                    <button type="button" class="menu_button delete-field-btn" style="padding:0 5px; color:var(--red);"><i class="fa-solid fa-xmark"></i></button>
                `;

                const nameInput = fRow.querySelector('.f-name');
                nameInput.title = 'Field key. Renaming it carries the stored values across.';
                // Sanitised as you type, committed when you leave the box. Renaming on
                // every keystroke would migrate the whole library once per letter, and an
                // emptied box would briefly name the field ''.
                nameInput.addEventListener('input', (e) => {
                    e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
                });
                nameInput.addEventListener('change', (e) => {
                    const oldName = field.name;
                    const newName = e.target.value.trim();
                    if (!newName || newName === oldName) {
                        e.target.value = oldName;
                        return;
                    }
                    if (col.fields.some(f => f !== field && f.name === newName)) {
                        toastr.error(`This collection already has a field called "${newName}".`, 'SillyNPC');
                        e.target.value = oldName;
                        return;
                    }
                    field.name = newName;
                    const moved = renameCollectionField(col.id, oldName, newName);
                    saveSettings();
                    // A rename that moved nothing and one that moved forty items look the
                    // same afterwards, and the difference is worth knowing.
                    if (moved) {
                        toastr.success(`Renamed to "${newName}" and carried ${moved} item${moved === 1 ? '' : 's'} across.`, 'SillyNPC');
                    }
                    onRefresh();
                });
                fRow.querySelector('.f-label').addEventListener('input', (e) => { field.label = e.target.value; saveSettings(); });
                fRow.querySelector('.f-default').addEventListener('input', (e) => { field.defaultValue = e.target.value; saveSettings(); });
                fRow.querySelector('.f-options').addEventListener('change', (e) => {
                    field.options = parseOptions(e.target.value);
                    saveSettings();
                    renderFields();
                });
                fRow.querySelector('.f-type').addEventListener('change', (e) => { 
                    field.type = e.target.value; 
                    const multi = fRow.querySelector('.f-multiline');
                    multi.disabled = field.type !== 'text';
                    if (multi.disabled) { multi.checked = false; field.isMultiline = false; }
                    
                    // Default isStatic logic: numbers are dynamic by default, others static
                    const staticCheck = fRow.querySelector('.f-static');
                    field.isStatic = field.type !== 'number';
                    staticCheck.checked = field.isStatic;

                    saveSettings(); 
                });
                fRow.querySelector('.f-primary').addEventListener('change', (e) => { 
                    if (e.target.checked) {
                        col.fields.forEach(f => f.isPrimary = false);
                        field.isPrimary = true;
                        renderFields();
                    } else {
                        field.isPrimary = false;
                    }
                    saveSettings(); 
                });
                fRow.querySelector('.f-multiline').addEventListener('change', (e) => { field.isMultiline = e.target.checked; saveSettings(); });
                fRow.querySelector('.f-static').addEventListener('change', (e) => { field.isStatic = e.target.checked; saveSettings(); });
                for (const [selector, delta] of [['.move-field-up', -1], ['.move-field-down', 1]]) {
                    fRow.querySelector(selector)?.addEventListener('click', () => {
                        if (!moveInList(col.fields, fIdx, delta)) return;
                        saveSettings();
                        renderFields();
                    });
                }

                fRow.querySelector('.delete-field-btn').addEventListener('click', () => {
                    col.fields.splice(fIdx, 1);
                    saveSettings();
                    renderFields();
                });

                fieldsList.appendChild(fRow);
            });
        };

        colWrap.querySelector('.add-field-btn').addEventListener('click', () => {
            col.fields.push({ name: 'new_field', label: 'New Field', type: 'text' });
            saveSettings();
            renderFields();
        });

        colWrap.querySelector('.col-name').addEventListener('input', (e) => { col.name = e.target.value; saveSettings(); });
        const colIdInput = colWrap.querySelector('.col-id');
        colIdInput.title = 'Storage key for this collection. Renaming it migrates existing items.';
        colIdInput.addEventListener('change', (e) => {
            const oldId = col.id;
            const newId = e.target.value.trim();
            if (!newId || newId === oldId) {
                e.target.value = oldId;
                return;
            }
            if (collections.some(c => c !== col && c.id === newId)) {
                toastr.error(`A collection with the id "${newId}" already exists.`, 'SillyNPC');
                e.target.value = oldId;
                return;
            }
            col.id = newId;
            const moved = renameCollectionId(oldId, newId);
            saveSettings();
            if (moved) {
                toastr.success(`Renamed to "${newId}" and carried ${moved} item${moved === 1 ? '' : 's'} across.`, 'SillyNPC');
            }
            onRefresh();
        });
        colWrap.querySelector('.col-target').addEventListener('change', (e) => { col.target = e.target.value; saveSettings(); });
        const visibleCheck = colWrap.querySelector('.col-visible');
        if (visibleCheck) {
            visibleCheck.addEventListener('change', (e) => { col.visible = e.target.checked; saveSettings(); onRefresh(); });
        }
        // Through the same rule the stat rows and the collection fields use. The swap was
        // written out here twice; three lists with a pair of buttons each would have made
        // four copies of it to keep right.
        for (const [selector, delta] of [['.move-up-btn', -1], ['.move-down-btn', 1]]) {
            colWrap.querySelector(selector)?.addEventListener('click', () => {
                if (!moveInList(collections, index, delta)) return;
                saveSettings();
                onRefresh();
            });
        }
        colWrap.querySelector('.delete-btn').addEventListener('click', async () => {
            if (await Popup.show.confirm('Delete collection', `Delete "${col.name}"? Its stored items will be left behind.`)) {
                collections.splice(index, 1);
                saveSettings();
                onRefresh();
            }
        });

        if (bulk.isActive()) {
            colWrap.querySelector('.delete-btn')?.replaceWith(buildBulkCheckbox(bulk, index));
        }

        renderFields();
        wrap.appendChild(colWrap);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'menu_button';
    addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add Collection';
    addBtn.addEventListener('click', () => {
        collections.push({ 
            id: 'new_collection', 
            name: 'New Collection', 
            fields: [
                { name: 'name', label: 'Name', type: 'text', isPrimary: true, isStatic: true, defaultValue: '' },
                { name: 'quantity', label: 'Quantity', type: 'number', isPrimary: false, isStatic: false, defaultValue: '1' },
                { name: 'description', label: 'Description', type: 'text', isMultiline: true, isPrimary: false, isStatic: true, defaultValue: '' }
            ], 
            target: 'all' 
        });
        saveSettings();
        onRefresh();
    });
    wrap.appendChild(addBtn);

    return wrap;
}

/**
 * A comma-separated list of allowed values, as typed.
 *
 * Empty means the field allows anything, which is every field until somebody says
 * otherwise. Blank entries are dropped so a trailing comma while typing does not
 * declare an allowed empty value.
 */
function parseOptions(text) {
    return String(text || '').split(',').map(v => v.trim()).filter(Boolean);
}
/** The Format a field has when its label is the field's own name. */
const NAMED_FORMAT = '{{name}}: {{value}}';
/** The Format a field has when it shows the value alone. */
const BARE_FORMAT = '{{value}}';

/**
 * Whether the Name checkbox can speak for this Format at all.
 *
 * A field whose Format writes its own wording - `DD: {{value}}` - is not one of the two
 * states the checkbox toggles between, and ticking it would have to throw that wording
 * away. A checkbox that quietly deletes something you typed is worse than one you
 * cannot press.
 */
function formatIsToggleable(format) {
    const text = String(format ?? '').trim();
    if (!text || text === BARE_FORMAT) return true;
    return text.includes('{{name}}');
}
/**
 * One bulk-select handle per stat list, kept across the redraws ticking a box causes.
 *
 * Keyed by the settings key rather than shared, or ticking a global stat would carry its
 * index onto the NPC list - and index 2 exists in both.
 *
 * @type {Map<string, object>}
 */
const statBulkBars = new Map();

function statsBulkBar(settingsKey, onRefresh, noun = 'field') {
    if (!statBulkBars.has(settingsKey)) {
        statBulkBars.set(settingsKey, buildBulkBar({
            noun,
            allIds: () => (getSettings().statusTracker[settingsKey] || []).map((_, i) => i),
            onDelete: (ids) => {
                // Descending, or the first splice shifts every index chosen after it.
                spliceIndexes(getSettings().statusTracker[settingsKey], ids);
                saveSettings();
            },
            onRefresh: () => onRefresh(),
        }));
    }
    return statBulkBars.get(settingsKey);
}

function buildStatsEditor(label, settingsKey, onRefresh) {
    const wrap = document.createElement('div');
    const stats = getSettings().statusTracker[settingsKey];
    const bulk = statsBulkBar(settingsKey, onRefresh);
    wrap.appendChild(bulk.bar);

    stats.forEach((stat, index) => {
        const row = document.createElement('div');
        row.className = 'sillynpc-alias-row';
        row.style.marginBottom = '12px';
        row.style.flexWrap = 'wrap';
        row.innerHTML = `
            <div style="display:flex; gap:8px; width:100%; margin-bottom:4px;">
                <input type="text" class="text_pole stat-name" value="${escapeHtml(stat.name)}" placeholder="Stat Name" style="flex:1">
                <input type="text" class="text_pole stat-default" value="${escapeHtml(stat.defaultValue || '')}" placeholder="Default Value" style="flex:1">
                <button type="button" class="menu_button stat-up-btn" title="Move up - this order is the order the tracker, the character page and the reader all use" ${index === 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
                <button type="button" class="menu_button stat-down-btn" title="Move down" ${index === stats.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-arrow-down"></i></button>
                <button type="button" class="menu_button delete-btn"><i class="fa-solid fa-trash"></i></button>
            </div>
            <div style="display:flex; gap:8px; width:100%; align-items:center;">
                <small style="opacity:0.6; flex-shrink:0;">Format:</small>
                <input type="text" class="text_pole stat-format" value="${escapeHtml(stat.format || '{{value}}')}" placeholder="e.g. HP: {{value}}" style="flex:1; font-size:0.9em; height:24px;">
                ${stat.type === 'bar' ? `
                <small style="opacity:0.6; flex-shrink:0;">Min:</small>
                <input type="text" class="text_pole stat-min" value="${escapeHtml(stat.min ?? '')}" placeholder="0" title="Lower bound for a Meter. Use a negative number for ranges like -100..100." style="width:45px; font-size:0.9em; height:24px;">
                <small style="opacity:0.6; flex-shrink:0;" title="The maximum this stat starts at. Once play moves the ceiling - a level-up, a new rank - the live value wins and this is no longer consulted.">Starts max:</small>
                <input type="text" class="text_pole stat-max" value="${escapeHtml(stat.maxStatValue || '')}" placeholder="Max" title="Starting maximum only. The ceiling actually in play is read from the stat's own value, so a character who has grown past this is not clamped back." style="width:50px; font-size:0.9em; height:24px;">
                ` : `
                <small style="opacity:0.6; flex-shrink:0;">Write it:</small>
                <input type="text" class="text_pole stat-hint" value="${escapeHtml(stat.hint || '')}"
                       placeholder="e.g. the current objective only, one line"
                       title="Told to the reader when it fills this field in. Say the shape you want - a date as DD.MM.YY, a single sentence, a place name - and it is sent with every extraction."
                       style="flex:1; min-width:120px; font-size:0.9em; height:24px;">
                <small style="opacity:0.6; flex-shrink:0;" title="A hard limit the extension applies itself, so a field cannot grow into a log however the reader answers. Blank means no limit.">Max chars:</small>
                <input type="text" class="text_pole stat-length" value="${escapeHtml(stat.maxLength ?? '')}"
                       placeholder="—" title="Blank for no limit. Anything longer is cut back to a word boundary and marked."
                       style="width:50px; font-size:0.9em; height:24px;">
                `}
                <select class="text_pole stat-type" title="How this stat is displayed" style="width:80px; font-size:0.85em; height:24px;">
                    <option value="text" ${stat.type !== 'bar' ? 'selected' : ''}>Text</option>
                    <option value="bar" ${stat.type === 'bar' ? 'selected' : ''}>Meter</option>
                </select>
                <label style="display:flex; align-items:center; gap:4px; margin-left:10px;">
                    <input type="checkbox" class="stat-visible" ${stat.visible !== false ? 'checked' : ''}>
                    <small>Visible</small>
                </label>
                <label style="display:flex; align-items:center; gap:4px; margin-left:6px;"
                       title="${formatIsToggleable(stat.format)
                            ? 'Show the field name in front of the value on the tracker.'
                            : 'This field\'s Format already sets its own label.'}">
                    <input type="checkbox" class="stat-show-name"
                           ${String(stat.format || '').includes('{{name}}') ? 'checked' : ''}
                           ${formatIsToggleable(stat.format) ? '' : 'disabled'}>
                    <small>Name</small>
                </label>
                <input type="text" class="text_pole stat-options"
                       value="${escapeHtml((stat.options || []).join(', '))}"
                       placeholder="Any value"
                       title="Allowed values, separated by commas. Leave empty to allow anything."
                       style="flex:1.2; min-width:120px; font-size:0.85em; height:24px; margin-left:10px;">
                ${settingsKey === 'playerStats' ? `
                <label style="display:flex; align-items:center; gap:4px; margin-left:10px;">
                    <input type="checkbox" class="stat-primary" ${stat.isPrimary ? 'checked' : ''}>
                    <small>Primary (HUD)</small>
                </label>
                <label style="display:flex; align-items:center; gap:4px; margin-left:6px;" title="Colour of this stat's meter on the floating HUD">
                    <input type="color" class="stat-color" value="${stat.color || '#7aa2f7'}" style="width:26px; height:20px; padding:0; border:0; background:none; cursor:pointer;">
                    <small>Meter</small>
                </label>
                ` : ''}
            </div>
        `;
        
        const statNameInput = row.querySelector('.stat-name');
        statNameInput.title = 'Renaming this carries its stored values, the scene binding, '
            + 'any time rule that names it, and the display template.';
        // Committed when you leave the box rather than on every keystroke: renaming per
        // letter would migrate every stored value once per character typed, and an emptied
        // box would briefly name the stat "".
        statNameInput.addEventListener('change', (e) => {
            const oldName = stat.name;
            const newName = e.target.value.trim();
            if (!newName || newName === oldName) {
                e.target.value = oldName;
                return;
            }
            if (stats.some(s => s !== stat && s.name === newName)) {
                toastr.error(`This list already has a stat called "${newName}".`, 'SillyNPC');
                e.target.value = oldName;
                return;
            }

            stat.name = newName;
            const carried = renameStat(settingsKey, oldName, newName);
            saveSettings();

            const parts = [];
            if (carried.values) parts.push(`${carried.values} stored value${carried.values === 1 ? '' : 's'}`);
            if (carried.references) parts.push(`${carried.references} reference${carried.references === 1 ? '' : 's'}`);
            if (carried.templateUpdated) parts.push('the display template');
            if (parts.length) {
                toastr.success(`Renamed to "${newName}" and carried ${parts.join(', ')} across.`, 'SillyNPC');
            }
            // Not rewritten, because a selector can be built from a name in more ways than
            // can be recognised - but silence here would look like nothing was left behind.
            if (carried.cssMentions) {
                toastr.warning(`Your custom CSS still mentions "${oldName}". Check it by hand.`, 'SillyNPC');
            }
            onRefresh();
        });
        // The meter used to take its colour from a stylesheet rule keyed to the stat's
        // name, so only HP, MP, Mana and Energy ever had one.
        row.querySelector('.stat-color')?.addEventListener('input', (e) => {
            stat.color = e.target.value;
            saveSettings();
            updateHUD();
        });
        row.querySelector('.stat-default').addEventListener('input', (e) => { stat.defaultValue = e.target.value; saveSettings(); });
        row.querySelector('.stat-format').addEventListener('input', (e) => { stat.format = e.target.value; saveSettings(); });
        // Optional chaining because the row only carries the controls its type uses:
        // Min and Starts max belong to a Meter, the hint and the cap to a Text field.
        // They were all shown on every row, which is why a Text field offered a lower
        // bound it has no use for - and where the room for the new pair came from.
        row.querySelector('.stat-max')?.addEventListener('input', (e) => { stat.maxStatValue = e.target.value; saveSettings(); });
        row.querySelector('.stat-min')?.addEventListener('input', (e) => { stat.min = e.target.value; saveSettings(); });
        row.querySelector('.stat-hint')?.addEventListener('input', (e) => { stat.hint = e.target.value; saveSettings(); });
        row.querySelector('.stat-length')?.addEventListener('input', (e) => {
            // Kept as typed rather than coerced: a half-typed number must not become 0,
            // which would read as a limit of nothing. capToLength ignores anything that
            // is not a positive number.
            stat.maxLength = e.target.value.trim();
            saveSettings();
        });
        for (const [selector, delta] of [['.stat-up-btn', -1], ['.stat-down-btn', 1]]) {
            row.querySelector(selector)?.addEventListener('click', () => {
                if (!moveInList(stats, index, delta)) return;
                saveSettings();
                // The whole editor, not the row: the buttons at both ends have to become
                // enabled or disabled as entries pass them.
                onRefresh();
            });
        }

        row.querySelector('.stat-type').addEventListener('change', (e) => { stat.type = e.target.value; saveSettings(); onRefresh(); });
        row.querySelector('.stat-visible').addEventListener('change', (e) => { stat.visible = e.target.checked; saveSettings(); onRefresh(); });
        // A shortcut for writing Format, not a second mechanism: one place decides what
        // a field is labelled, and it is the box right there in the row.
        row.querySelector('.stat-show-name').addEventListener('change', (e) => {
            stat.format = e.target.checked ? NAMED_FORMAT : BARE_FORMAT;
            saveSettings();
            onRefresh();
        });
        // Committed on change rather than per keystroke: a half-typed list would refuse
        // values the user is in the middle of allowing.
        row.querySelector('.stat-options').addEventListener('change', (e) => {
            stat.options = parseOptions(e.target.value);
            saveSettings();
            onRefresh();
        });
        if (settingsKey === 'playerStats') {
            row.querySelector('.stat-primary').addEventListener('change', (e) => {
                stat.isPrimary = e.target.checked;
                saveSettings();
                // The HUD is a separate element from this panel; without this the meter
                // only appeared after a reload, or after some other setting refreshed it.
                updateHUD();
                onRefresh();
            });
        }
        row.querySelector('.delete-btn').addEventListener('click', async () => {
            // It used to go on one click with nothing asked. Bulk delete asks, and two
            // doors onto the same act should not disagree about how final it is.
            const ok = await Popup.show.confirm(
                `Delete "${stat.name || 'this field'}"?`,
                'The field is removed from the tracker. Values already recorded on a '
                + 'character are left alone but will no longer be shown.',
            );
            if (!ok) return;
            stats.splice(index, 1);
            saveSettings();
            onRefresh();
        });

        if (bulk.isActive()) {
            // The checkbox replaces the row's own delete while selecting.
            row.querySelector('.delete-btn')?.replaceWith(buildBulkCheckbox(bulk, index));
        }

        wrap.appendChild(row);
    });
    
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'menu_button';
    addBtn.innerHTML = `<i class="fa-solid fa-plus"></i> Add New Field`;
    addBtn.addEventListener('click', () => {
        const newStat = { name: 'New Stat', defaultValue: '', format: '{{value}}', visible: true, type: 'text', min: '' };
        newStat.maxStatValue = '';
        stats.push(newStat);
        saveSettings();
        onRefresh();
    });
    
    wrap.appendChild(addBtn);
    return wrap;
}
