import { debugLog } from './constants.js';
import { eventSource } from '../../../../events.js';
import { POPUP_TYPE, POPUP_RESULT, Popup } from '../../../../popup.js';
import { getSettings } from './settings.js';
import { escapeHtml } from './utils.js';
import { openManagePopup } from './ui-manage.js';
import { buildPortraitBlock, openLightbox } from './ui-portrait.js';
import { renderLorebookSection, resetLorebookState } from './ui-lorebook-section.js';
import { buildProfileBlocks, renderProfileFields } from './ui-profile.js';
import { readLoreEntry } from './character-fill.js';
import { fillCharacter } from './ui-fill.js';
import { playerHistory, restorePlayerFromMessage } from './status-snapshots.js';
import { renderCollectionUI, attachCollectionListeners, resolveCollectionTarget, persistCollectionEdit, updateExtensionTheme } from './ui-shared.js';
import { buildBulkBar, spliceIndexes } from './ui-bulk-select.js';
import { choiceOptionsHtml, isChoiceField } from './ui-shared.js';
import { 
    loadStateFromMetadata,
    applyUpdate,
    getPersonaData,
    getPlayerCard
} from './status-logic.js';

/** 'profile' | 'edit' - the same two the character page has, for the same reason. */
let currentTab = 'profile';
let isCollectionEditMode = false;

/**
 * Bulk selection, one handle per collection.
 *
 * It used to be a single handle keyed to whichever collection tab was open. The tabs are
 * gone and every collection is on the page at once, so one handle would put its bar in
 * the first section and route every tick in every list into the same selection.
 *
 * Kept between draws because ticking a box redraws the sheet: a handle built during the
 * draw would forget the tick that caused it.
 *
 * @type {Map<string, object>}
 */
const playerBulks = new Map();

/** @param {string} colId */
function bulkFor(colId) {
    return playerBulks.get(colId) || null;
}

/** Builds the handle for a collection the first time that collection is drawn. */
function ensureBulk(colId, dom) {
    if (playerBulks.has(colId)) return playerBulks.get(colId);

    const handle = buildBulkBar({
        noun: 'item',
        allIds: () => (loadStateFromMetadata().player?.collections?.[colId] || [])
            .map((_, i) => i),
        onDelete: (ids) => {
            const player = loadStateFromMetadata().player;
            const where = resolveCollectionTarget(player, true);
            const list = where.target?.collections?.[colId];
            if (!list) return;
            // Descending, or the first splice shifts every index chosen after it.
            const removed = spliceIndexes(list, ids);
            persistCollectionEdit(`Dropped ${removed} item(s)`, where, true);
        },
        onRefresh: () => refreshModal(dom),
    });
    playerBulks.set(colId, handle);
    return handle;
}

export function openPlayerModal() {
    // Reads the chat's state and renders it. It used to pull master storage over the live
    // state first - "to avoid race conditions" - which meant looking at your character
    // could change them, and the next save made it permanent.
    const state = loadStateFromMetadata();

    const persona = getPersonaData();
    const settings = getSettings().statusTracker;
    
    debugLog('Opening player modal', { persona });

    const levelStat = settings.playerStats.find(s => (s.name === 'Level' || s.name === 'LvL') && s.visible !== false);
    const levelValue = levelStat ? (state.player.stats[levelStat.name] || levelStat.defaultValue || '1') : null;

    const modalHtml = `
        <div class="sillynpc-modal sillynpc-player-sheet">
            <div class="sillynpc-sheet-header">
                <div class="sillynpc-sheet-title">
                    <span class="persona-name">${escapeHtml(persona.name)}</span>
                    ${levelValue !== null ? `<div class="level-badge">Lvl ${escapeHtml(levelValue)}</div>` : ''}
                </div>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <button type="button" class="menu_button sillynpc-sheet-fill" title="Read the story for who you are, a lore entry, your fields and a portrait - filling only what is still empty."><i class="fa-solid fa-fill-drip"></i> <span>Fill</span></button>
                    <button type="button" class="menu_button sillynpc-restore-open" title="Put your stats and collections back to what they were after an earlier message"><i class="fa-solid fa-clock-rotate-left"></i></button>
                    <div class="sillynpc-sheet-settings" title="Extension Settings" style="cursor: pointer;"><i class="fa-solid fa-cog"></i></div>
                    <div class="sillynpc-sheet-close" style="cursor: pointer;"><i class="fa-solid fa-xmark"></i></div>
                </div>
            </div>
            <div class="sillynpc-sheet-body">
                <div class="sillynpc-sheet-sidebar"></div>
                <div class="sillynpc-sheet-main">
                    <div class="sillynpc-charview-tabs">
                        <button type="button" class="sillynpc-charview-tab ${currentTab === 'profile' ? 'active' : ''}" data-view="profile">Profile</button>
                        <button type="button" class="sillynpc-charview-tab ${currentTab === 'edit' ? 'active' : ''}" data-view="edit">Edit</button>
                    </div>
                    <div class="sillynpc-sheet-content">
                        ${renderTabContent(currentTab, state)}
                    </div>
                </div>
            </div>
        </div>
    `;

    const container = document.createElement('div');
    container.innerHTML = modalHtml;
    // The same three the manage popup sets, and for the same reason: the dialog is given
    // a fixed height, and everything inside it measures against this wrapper. Without a
    // height here the sheet is as tall as its contents, so the part that is meant to
    // scroll never overflows anything - it is simply clipped by the dialog.
    container.style.height = '100%';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';

    const popup = new Popup(container, POPUP_TYPE.DISPLAY, '', {
        large: true,
        onOpen: (p) => {
            const dlg = p.dlg;
            if (dlg) {
                // Hide default ST close button completely
                const stCloseBtns = dlg.querySelectorAll('.popup_close, #dialogue_popup_close, .close_button, .popup-close, .popup-close-button, .popup-button-close');
                stCloseBtns.forEach(btn => btn.remove()); // Use remove() instead of display:none to be sure

                // Attach click listener directly to the active close button inside the open modal
                const closeBtn = dlg.querySelector('.sillynpc-sheet-close');
                if (closeBtn) {
                    closeBtn.addEventListener('click', () => p.completeCancelled());
                }

                const settingsBtn = dlg.querySelector('.sillynpc-sheet-settings');
                if (settingsBtn) {
                    settingsBtn.addEventListener('click', () => {
                        p.completeCancelled();
                        openManagePopup({ tab: 'systems' });
                    });
                }

                dlg.style.setProperty('padding', '0px', 'important');
                dlg.style.setProperty('background', 'transparent', 'important');
                dlg.style.setProperty('border', 'none', 'important');
                dlg.style.setProperty('box-shadow', 'none', 'important');

                const isMobile = window.innerWidth <= 768;
                const width = isMobile ? 95 : (getSettings().popupWidth ?? 80);
                const height = isMobile ? 90 : (getSettings().popupHeight ?? 80);

                dlg.style.setProperty('width', `${width}vw`, 'important');
                dlg.style.setProperty('max-width', '98vw', 'important');
                dlg.style.setProperty('height', `${height}vh`, 'important');
                dlg.style.setProperty('max-height', '98vh', 'important');
                
                if (isMobile) {
                    dlg.style.setProperty('margin', '2vh auto', 'important');
                }
            }
        }
    });
    
    popup.show();
    updateExtensionTheme(container, popup);
    // The lorebook block is shared with the character editor, and its mode is module
    // state - a picker left open there would otherwise open here against the player.
    resetLorebookState();
    renderSidebar(container);
    renderTabExtras(container);
    attachModalListeners(container);
}

/**
 * The left column: the player's portrait.
 *
 * Read-only on Profile and the full block on Edit, the same split the character page
 * makes - looking at somebody and changing them are different jobs and the controls
 * belong with the second one.
 *
 * Redrawn on its own rather than through refreshModal, which only replaces the tab
 * content: generating a portrait has to show here.
 *
 * @param {HTMLElement} dom
 */
function renderSidebar(dom) {
    const sidebar = dom.querySelector('.sillynpc-sheet-sidebar');
    if (!sidebar) return;

    const card = getPlayerCard();
    sidebar.replaceChildren();

    if (currentTab === 'edit') {
        const { preview, buttons } = buildPortraitBlock(card, {
            onChange: () => {
                renderSidebar(dom);
                // The same face is on the HUD and beside every message the player has sent,
                // and neither redraws itself. Announced rather than called: this module cannot
                // reach the HUD without closing an import loop, and index.js already owns the
                // list of things a change like this has to repaint.
                eventSource.emit('sillynpc-player-portrait-changed');
            },
        });
        sidebar.append(preview, buttons);
        return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-cv-portrait';
    if (card.imageUrl) {
        const img = document.createElement('img');
        img.src = card.imageUrl;
        img.alt = card.name || '';
        img.title = 'Click to view full size';
        img.style.cursor = 'zoom-in';
        img.addEventListener('click', () => openLightbox(card.imageUrl));
        wrap.append(img);
    } else {
        const empty = document.createElement('div');
        empty.className = 'sillynpc-cv-portrait-empty';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-user-large';
        const text = document.createElement('span');
        text.textContent = 'no image';
        empty.append(icon, text);
        wrap.append(empty);
    }
    sidebar.append(wrap);
}

/**
 * The parts of a tab that build elements rather than markup: the profile fields, and the
 * lore. renderTabContent hands back a string, and both of these need real nodes - the
 * lore because it is loaded over an await.
 *
 * @param {HTMLElement} dom
 */
function renderTabExtras(dom) {
    const card = getPlayerCard();

    const readOnly = dom.querySelector('.sillynpc-sheet-content .sillynpc-sheet-profile');
    if (readOnly) {
        const blocks = buildProfileBlocks(card);
        if (blocks.length) {
            readOnly.replaceChildren(...blocks);
        } else {
            const empty = document.createElement('p');
            empty.className = 'notes sillynpc-cv-empty';
            empty.textContent = 'Nothing recorded about who you are yet. Open Edit and '
                + 'write it, and the reader will be told it as established fact.';
            readOnly.replaceChildren(empty);
        }
    }

    const form = dom.querySelector('.sillynpc-sheet-content .sillynpc-sheet-profile-form');
    if (form) renderProfileFields(card, form);

    const loreView = dom.querySelector('.sillynpc-sheet-content .sillynpc-sheet-lore');
    if (loreView) {
        loreView.replaceChildren();
        if (card.lorebook?.world) {
            readLoreEntry(card).then(text => {
                if (!text) return;
                const heading = document.createElement('div');
                heading.className = 'sillynpc-cv-label';
                heading.textContent = `Lore · ${card.lorebook.world}`;
                const body = document.createElement('div');
                body.className = 'sillynpc-cv-lore-text';
                body.textContent = text;
                loreView.append(heading, body);
            }).catch(err => console.error('[SillyNPC] player lore read failed', err));
        }
    }

    const loreEdit = dom.querySelector('.sillynpc-sheet-content .lorebook-section-container');
    if (loreEdit) {
        renderLorebookSection(card, loreEdit, { onChange: () => refreshModal(dom) })
            .catch(err => console.error('[SillyNPC] player lorebook section failed', err));
    }
}

/** The collections a player can hold anything in. */
function playerCollections() {
    return (getSettings().statusTracker.collections || [])
        .filter(col => col.target === 'player' || col.target === 'all');
}

/** One collection under its own heading, however the tab wants it drawn. */
function collectionSection(col, state, settings, options) {
    return `
        <div class="sillynpc-sheet-section" data-col-section="${escapeHtml(col.id)}">
            <div class="sillynpc-cv-label">${escapeHtml(col.name || col.id)}</div>
            ${renderCollectionUI(col.id, state.player, settings, options)}
        </div>
    `;
}

function renderTabContent(tabId, state) {
    const settings = getSettings().statusTracker;

    if (tabId === 'profile') {
        return `
            <div class="sillynpc-attributes-grid">
                ${settings.playerStats.map(statDef => {
                    const actualKey = Object.keys(state.player.stats || {}).find(k => k.toLowerCase() === statDef.name.toLowerCase()) || statDef.name;
                    const value = state.player.stats[actualKey] || statDef.defaultValue || '';
                    // A field with a fixed vocabulary is chosen, not typed. Free typing
                    // would still be refused on the way in, but being told no after the
                    // fact is a worse answer than not being offered the chance.
                    const control = isChoiceField(statDef)
                        ? `<select class="attr-value sillynpc-inline-choice text_pole" data-stat="${escapeHtml(actualKey)}">`
                            + `${choiceOptionsHtml(statDef.options, value)}</select>`
                        : `<span class="attr-value sillynpc-inline-edit" data-stat="${escapeHtml(actualKey)}" contenteditable="true">${escapeHtml(value)}</span>`;
                    return `
                        <div class="sillynpc-attribute-item">
                            <span class="attr-name">${escapeHtml(statDef.name)}</span>
                            ${control}
                        </div>
                    `;
                }).join('')}
            </div>
            <div class="sillynpc-sheet-profile"></div>
            ${playerCollections().map(col => collectionSection(col, state, settings, {
                isEditMode: false, showEditToggle: false,
            })).join('')}
            <div class="sillynpc-sheet-lore"></div>
        `;
    }

    // Edit. The stats are not repeated here: they are click-to-edit on Profile already,
    // and the one number somebody opens this sheet to fix should not be a tab away.
    return `
        <div class="sillynpc-sheet-profile-form"></div>
        ${playerCollections().map(col => collectionSection(col, state, settings, {
            isEditMode: isCollectionEditMode, showEditToggle: true, bulk: bulkFor(col.id),
        })).join('')}
        <div class="lorebook-section-container"></div>
    `;
}

function attachModalListeners(dom) {
    // Tab switching
    dom.querySelectorAll('.sillynpc-charview-tab').forEach(tab => {
        if (tab.dataset.listenerAttached) return;
        tab.addEventListener('click', () => {
            if (currentTab === tab.dataset.view) return;
            currentTab = tab.dataset.view;
            refreshModal(dom);
            // The portrait differs between the two: read-only on Profile, the full block
            // with its controls on Edit.
            renderSidebar(dom);
        });
        tab.dataset.listenerAttached = 'true';
    });

    dom.querySelectorAll('.sillynpc-inline-choice').forEach(el => {
        if (el.dataset.listenerAttached) return;
        el.addEventListener('change', () => {
            applyUpdate({ player: { stats: { [el.dataset.stat]: el.value } } });
        });
        el.dataset.listenerAttached = 'true';
    });

    // Inline Editing
    dom.querySelectorAll('.sillynpc-inline-edit').forEach(el => {
        if (el.dataset.listenerAttached) return;
        el.addEventListener('blur', () => {
            const statName = el.dataset.stat;
            const newValue = el.innerText.trim();
            applyUpdate({ player: { stats: { [statName]: newValue } } });
        });
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        });
        el.dataset.listenerAttached = 'true';
    });

    const state = loadStateFromMetadata();

    // Scoped to its own section, so each collection's Add, its checkboxes and its bulk
    // bar reach only its own list. Handed the whole sheet they would all bind to the
    // first section on the page.
    for (const col of playerCollections()) {
        const section = dom.querySelector(`[data-col-section="${col.id}"]`);
        if (!section) continue;
        attachCollectionListeners(section, state.player, () => refreshModal(dom),
            ensureBulk(col.id, dom));
    }

    dom.querySelectorAll('.sillynpc-edit-toggle').forEach(btn => {
        if (btn.dataset.listenerAttached) return;
        btn.addEventListener('click', () => {
            isCollectionEditMode = !isCollectionEditMode;
            refreshModal(dom);
        });
        btn.dataset.listenerAttached = 'true';
    });

    const fillBtn = dom.querySelector('.sillynpc-sheet-fill');
    if (fillBtn && !fillBtn.dataset.listenerAttached) {
        fillBtn.addEventListener('click', () => {
            fillCharacter(getPlayerCard(), {
                onSave: () => {
                    renderSidebar(dom);
                    refreshModal(dom);
                    // A portrait or a new set of stats both show outside this popup.
                    eventSource.emit('sillynpc-player-portrait-changed');
                },
            });
        });
        fillBtn.dataset.listenerAttached = 'true';
    }

    const restoreBtn = dom.querySelector('.sillynpc-restore-open');
    if (restoreBtn && !restoreBtn.dataset.listenerAttached) {
        restoreBtn.addEventListener('click', () => {
            openRestorePicker().then(changed => { if (changed) refreshModal(dom); })
                .catch(err => console.error('[SillyNPC] restore picker failed', err));
        });
        restoreBtn.dataset.listenerAttached = 'true';
    }
}

/**
 * Choosing a point to put the player's stats and collections back to.
 *
 * Built on the per-message change records, which are the thing that actually survived
 * when a story's HP and Energy were overwritten - reading them was a manual dig through
 * the chat file, and this is that dig with a button on it.
 *
 * @returns {Promise<boolean>} Whether anything was restored.
 */
async function openRestorePicker() {
    const points = playerHistory();
    if (points.length < 2) {
        toastr.info('This chat has no earlier player state recorded yet.', 'SillyNPC');
        return false;
    }

    const wrap = document.createElement('div');
    const intro = document.createElement('p');
    intro.textContent = 'Put your stats and collections back to how they were after a '
        + 'message. Characters in the scene and world stats are left as they are.';
    wrap.append(intro);

    const select = document.createElement('select');
    select.className = 'text_pole';
    select.style.width = '100%';
    for (const point of points) {
        const option = document.createElement('option');
        option.value = String(point.messageId);
        const summary = Object.entries(point.stats)
            .filter(([, v]) => String(v).includes('/'))
            .map(([k, v]) => `${k} ${v}`).join(', ');
        option.textContent = `Message ${point.messageId} — ${summary || 'no meters'}`
            + ` · ${point.itemCount} item${point.itemCount === 1 ? '' : 's'}`
            // Older than the record, so it is reconstructed rather than known.
            + (point.exact ? '' : ' (approximate)');
        select.append(option);
    }
    // The newest point is where you already are; start one back, which is what you want.
    select.selectedIndex = Math.min(1, points.length - 1);
    wrap.append(select);

    const note = document.createElement('small');
    note.className = 'notes';
    note.style.cssText = 'display:block; margin-top:8px;';
    note.textContent = 'This lands as an ordinary undo step, so picking the wrong message '
        + 'can be undone like anything else.';
    wrap.append(note);

    const result = await new Popup(wrap, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Restore', cancelButton: 'Cancel',
    }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return false;

    const outcome = restorePlayerFromMessage(Number(select.value));
    if (!outcome) {
        toastr.error('Nothing recorded for that message.', 'SillyNPC');
        return false;
    }
    toastr.success(
        outcome.exact
            ? `Restored from message ${select.value}.`
            : `Restored from message ${select.value}, reconstructed (${outcome.reason}).`,
        'SillyNPC');
    return true;
}

function refreshModal(dom) {
    const state = loadStateFromMetadata();

    // We do NOT want to refresh the entire modal if an input is focused, as it breaks typing!
    // We only refresh when explicitly called (like adding or dropping items).
    // Or tab switching.
    const content = dom.querySelector('.sillynpc-sheet-content');
    content.innerHTML = renderTabContent(currentTab, state);
    
    // The tabs were renamed to the character page's when the sheet was rebuilt, and this
    // was left reading the old class and the old attribute - so it matched nothing and
    // Edit never lit up.
    dom.querySelectorAll('.sillynpc-charview-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.view === currentTab);
    });
    
    renderTabExtras(dom);
    attachModalListeners(dom);
}


