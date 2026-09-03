import { POPUP_TYPE, POPUP_RESULT, Popup } from '../../../../popup.js';
// The chat shows this picture beside every line the character speaks, so changing
// it has to redraw. reprocess.js rather than chat.js: chat.js imports this file.
import { triggerReprocess } from './reprocess.js';
import { getRequestHeaders } from '../../../../../script.js';
import { pickAndProcessImage } from './utils.js';
import { world_names } from '../../../../world-info.js';
import { getChatLorebookName } from './lorebook.js';
import { getSettings, saveSettings } from './settings.js';
import { LOG_PREFIX } from './constants.js';
import { 
    createLoreEntry, 
    generateLoreContent, 
    saveLoreContent, 
    generateCharacterImageLogic 
} from './api.js';

export async function generateLoreEntry(char, { onSave } = {}) {
    if (!char.name) {
        toastr.warning('Please give the character a name first.', 'SillyNPC');
        return;
    }

    const container = document.createElement('div');
    container.className = 'sillynpc-gen-popup';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '12px';

    const h = document.createElement('h3');
    h.textContent = char.lorebook ? `Regenerate Lore for ${char.name}` : `Generate Lore for ${char.name}`;
    container.append(h);

    // ─── Setup Row: Lorebook & Name (Hidden if already linked) ──────────
    const setupRow = document.createElement('div');
    setupRow.style.display = char.lorebook ? 'none' : 'grid';
    setupRow.style.gridTemplateColumns = '1fr 1fr';
    setupRow.style.gap = '10px';

    const worldField = document.createElement('div');
    worldField.className = 'sillynpc-editor-field';
    const worldLabel = document.createElement('label');
    worldLabel.textContent = 'Target Lorebook';
    const worldSelect = document.createElement('select');
    worldSelect.className = 'text_pole';
    // SillyTavern declares `export let world_names;` and fills it during its own startup,
    // so it can legitimately be undefined here.
    const worlds = Array.isArray(world_names) ? world_names : [];
    for (const name of worlds) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === (char.lorebook?.world || getSettings().defaultLorebook || getChatLorebookName())) opt.selected = true;
        worldSelect.append(opt);
    }
    worldField.append(worldLabel, worldSelect);

    const nameField = document.createElement('div');
    nameField.className = 'sillynpc-editor-field';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Entry Name';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'text_pole';
    nameInput.value = char.name;
    nameField.append(nameLabel, nameInput);

    setupRow.append(worldField, nameField);
    container.append(setupRow);

    // ─── Create Row ─────────────────────────────────────────────────────
    //
    // There was a "Connection Profile" select here with one hardcoded option that was
    // never read: generation runs through generateQuietPrompt on whatever profile is
    // current, and always did. A control that does nothing is worse than no control.
    const actionRow = document.createElement('div');
    actionRow.style.display = 'flex';
    actionRow.style.alignItems = 'flex-end';
    actionRow.style.gap = '10px';

    const profileField = document.createElement('div');
    profileField.className = 'sillynpc-editor-field';
    profileField.style.flex = '1';

    // With no lorebook at all, Create can only fail - say so where it is about to be
    // clicked, rather than after.
    if (!worlds.length) {
        const warn = document.createElement('small');
        warn.className = 'notes';
        warn.textContent = 'No lorebooks exist yet. Create one in SillyTavern\'s World Info '
            + 'panel first, then come back.';
        profileField.append(warn);
    }

    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'menu_button';
    createBtn.style.height = '32px';
    createBtn.style.display = char.lorebook ? 'none' : '';
    createBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Create Entry';
    createBtn.disabled = !worlds.length;

    actionRow.append(profileField, createBtn);
    container.append(actionRow);

    // ─── Status & Created Info ──────────────────────────────────────────
    const statusBox = document.createElement('div');
    statusBox.className = 'sillynpc-lorebook-preview';
    statusBox.style.minHeight = '40px';
    statusBox.style.fontSize = '0.9em';
    statusBox.innerHTML = char.lorebook 
        ? `<span style="color:var(--SmartThemeQuoteColor)">Linked to entry "${char.lorebook.world} / #${char.lorebook.uid}"</span>`
        : '<i class="notes">Entry not yet created...</i>';
    container.append(statusBox);

    // ─── Generation Results ─────────────────────────────────────────────
    const resultsContainer = document.createElement('div');
    resultsContainer.style.display = char.lorebook ? 'flex' : 'none';
    resultsContainer.style.flexDirection = 'column';
    resultsContainer.style.gap = '12px';

    const resultsTitle = document.createElement('h4');
    resultsTitle.textContent = 'Generation Results';
    resultsTitle.style.margin = '10px 0 0 0';
    resultsContainer.append(resultsTitle);

    // Sits above the boxes so a reply that ignored the instruction cannot look like a
    // result. Hidden until there is something to say.
    const resultWarning = document.createElement('div');
    resultWarning.className = 'sillynpc-lore-warning';
    resultWarning.style.display = 'none';
    resultsContainer.append(resultWarning);

    const tagsField = document.createElement('div');
    tagsField.className = 'sillynpc-editor-field';
    const tagsLabel = document.createElement('label');
    tagsLabel.textContent = 'Generated Tags';
    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.className = 'text_pole';
    tagsInput.placeholder = 'Tags will appear here...';
    tagsField.append(tagsLabel, tagsInput);
    resultsContainer.append(tagsField);

    const descField = document.createElement('div');
    descField.className = 'sillynpc-editor-field';
    const descLabel = document.createElement('label');
    descLabel.textContent = 'Generated Description';
    const descText = document.createElement('textarea');
    descText.className = 'text_pole';
    descText.rows = 8;
    descText.placeholder = 'Description will appear here...';
    descField.append(descLabel, descText);
    resultsContainer.append(descField);
    container.append(resultsContainer);

    // ─── Final Actions ──────────────────────────────────────────────────
    const footer = document.createElement('div');
    footer.className = 'sillynpc-lorebook-actions';
    
    const genBtn = document.createElement('button');
    genBtn.type = 'button';
    genBtn.className = 'menu_button';
    genBtn.style.display = char.lorebook ? '' : 'none';
    genBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Start Generation';

    const saveCloseBtn = document.createElement('button');
    saveCloseBtn.type = 'button';
    saveCloseBtn.className = 'menu_button';
    saveCloseBtn.style.display = 'none';
    saveCloseBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save & Close';

    footer.append(genBtn, saveCloseBtn);
    container.append(footer);

    let createdUid = char.lorebook?.uid || null;
    let createdWorld = char.lorebook?.world || null;

    // Set while a generation is in flight so onClosing can veto the close.
    let isGenerating = false;

    const popup = new Popup(container, POPUP_TYPE.DISPLAY, '', {
        onOpen: (p) => { p.dlg.style.width = '650px'; },
        onClosing: () => {
            if (isGenerating) {
                toastr.info('Generation in progress, please wait.', 'SillyNPC');
                return false;
            }
            return true;
        },
    });

    createBtn.addEventListener('click', async () => {
        const targetWorld = worldSelect.value;
        const entryName = nameInput.value.trim();
        if (!entryName) return toastr.warning('Please enter an entry name.');

        try {
            createBtn.disabled = true;
            const { uid } = await createLoreEntry(char, targetWorld, entryName);
            
            createdUid = uid;
            createdWorld = targetWorld;
            
            statusBox.innerHTML = `<span style="color:var(--SmartThemeGreenColor)">✓ Entry "${entryName}" created (UID: ${uid}) in "${targetWorld}"</span>`;
            toastr.success('Lorebook entry created!');
            
            resultsContainer.style.display = 'flex';
            genBtn.style.display = '';
            setupRow.style.display = 'none';
            createBtn.style.display = 'none';
        } catch (err) {
            console.error(LOG_PREFIX, 'Failed to create lore entry', err);
            toastr.error(String(err?.message || err), 'SillyNPC');
            createBtn.disabled = false;
        }
    });

    genBtn.addEventListener('click', async () => {
        if (!createdUid) return;
        genBtn.disabled = true;
        isGenerating = true;

        try {
            toastr.info('Generating tags and description...');
            
            const { tags, content, followedFormat, excerpt } =
                await generateLoreContent(char, createdWorld, createdUid);

            tagsInput.value = tags;
            descText.value = content;

            // Shown either way, so a usable answer can still be salvaged - but never
            // presented as though it worked.
            resultWarning.style.display = followedFormat ? 'none' : '';
            if (!followedFormat) {
                resultWarning.textContent = 'This reply did not use the requested Tags/Content '
                    + 'format, which usually means the instruction never reached the model - '
                    + 'most often because the request was too large. Try a smaller Chat To Read '
                    + 'or Excerpt Size Limit. Check it before saving.';
            }

            saveCloseBtn.style.display = '';
            if (excerpt?.trimmed) {
                toastr.info(
                    `Read ${excerpt.used} of ${excerpt.available} messages (excerpt size limit).`,
                    'SillyNPC');
            }
            toastr.success('Generation complete.');
        } catch (err) {
            console.error(LOG_PREFIX, 'Lore generation failed', err);
            toastr.error(String(err?.message || err), 'SillyNPC');
        } finally {
            genBtn.disabled = false;
            isGenerating = false;
        }
    });

    saveCloseBtn.addEventListener('click', async () => {
        if (!createdUid || !createdWorld) return;
        try {
            saveCloseBtn.disabled = true;
            saveCloseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

            await saveLoreContent(char, createdWorld, createdUid, tagsInput.value, descText.value);
            
            toastr.success('Lorebook entry updated and linked!');
            popup.completeCancelled();
            onSave?.();
        } catch (err) {
            toastr.error(`Save failed: ${err.message || err}`);
            saveCloseBtn.disabled = false;
            saveCloseBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save & Close';
        }
    });

    await popup.show();
}

/**
 * Removes a generated image from disk.
 *
 * Discard has to delete rather than decline to save: the file is written before we can
 * ask, because the API hands back a data URI that would otherwise be stored inline in
 * settings.json.
 *
 * @param {string} path
 */
async function deleteGeneratedImage(path) {
    if (!path || path.startsWith('data:')) return;
    try {
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path }),
        });
    } catch (err) {
        console.warn(LOG_PREFIX, 'Could not delete the discarded image:', err);
    }
}

/**
 * Asks how the portrait should be generated, and against what reference.
 *
 * Referencing is Gemini-only: SillyTavern's generateGoogleImage sends a prompt and nothing
 * else, and the /sd command has no argument that carries an image. So the options are
 * hidden on that backend rather than offered and silently ignored.
 *
 * @param {object} char
 * @returns {Promise<{ references: string[] } | null>} null when cancelled.
 */
async function askGenerationMode(char) {
    const isGemini = getSettings().imageBackend === 'gemini';
    const own = Array.isArray(char.images) ? char.images.filter(Boolean) : [];

    if (!isGemini) {
        const ok = await Popup.show.confirm(
            `Generate an image for "${char.name || 'this character'}"?`,
            'The Image Generation extension cannot take a reference image, so this is drawn '
            + 'from the prompt alone.',
        );
        return ok ? { references: [] } : null;
    }

    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-gen-popup';

    const intro = document.createElement('p');
    intro.textContent = `How should "${char.name || 'this character'}" be drawn?`;
    wrap.append(intro);

    /** @type {string[]} */
    const chosen = [];
    let mode = own.length ? 'current' : 'scratch';

    const noteForCurrent = own.length
        ? 'Keeps the same face and outfit; pose and scene can still change.'
        : 'No image yet, so this falls back to from scratch.';

    const options = [
        { value: 'scratch', label: 'From scratch', note: 'The prompt only. A fresh interpretation every time.' },
        { value: 'current', label: 'Use the current image as reference', note: noteForCurrent },
        { value: 'pick', label: 'Choose reference images', note: "From this character's saved images, from disk, or both." },
    ];

    const pickArea = document.createElement('div');
    pickArea.className = 'sillynpc-genref-area';

    const updateTally = () => {
        const tally = pickArea.querySelector('.sillynpc-genref-count');
        if (!tally) return;
        tally.textContent = chosen.length
            ? `${chosen.length} reference image${chosen.length === 1 ? '' : 's'} selected.`
            : 'Nothing selected yet, so this would generate from scratch.';
    };

    const refresh = () => {
        pickArea.replaceChildren();
        if (mode !== 'pick') return;

        if (own.length) {
            const heading = document.createElement('div');
            heading.className = 'notes';
            heading.textContent = "This character's images, click to select:";
            pickArea.append(heading);

            const grid = document.createElement('div');
            grid.className = 'sillynpc-genref-grid';
            for (const src of own) {
                const cell = document.createElement('div');
                cell.className = 'sillynpc-genref-cell';
                const img = document.createElement('img');
                img.src = src;
                cell.append(img);
                cell.addEventListener('click', () => {
                    const at = chosen.indexOf(src);
                    if (at >= 0) chosen.splice(at, 1);
                    else chosen.push(src);
                    cell.classList.toggle('selected', at < 0);
                    updateTally();
                });
                grid.append(cell);
            }
            pickArea.append(grid);
        }

        const upload = document.createElement('button');
        upload.type = 'button';
        upload.className = 'menu_button';
        upload.textContent = 'Add from disk';
        upload.addEventListener('click', async () => {
            const dataUrl = await pickAndProcessImage({ fullSize: true });
            if (dataUrl) {
                chosen.push(dataUrl);
                updateTally();
            }
        });
        pickArea.append(upload);

        const tally = document.createElement('div');
        tally.className = 'notes sillynpc-genref-count';
        pickArea.append(tally);
        updateTally();
    };

    const modes = document.createElement('div');
    modes.className = 'sillynpc-genmode-list';
    for (const option of options) {
        const row = document.createElement('label');
        row.className = 'sillynpc-genmode-row';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'sillynpc-genmode';
        radio.value = option.value;
        radio.checked = option.value === mode;
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            mode = option.value;
            refresh();
        });

        const label = document.createElement('strong');
        label.textContent = option.label;
        const note = document.createElement('small');
        note.className = 'notes';
        note.textContent = option.note;

        const text = document.createElement('span');
        text.append(label, document.createElement('br'), note);
        row.append(radio, text);
        modes.append(row);
    }

    wrap.append(modes, pickArea);
    refresh();

    const popup = new Popup(wrap, POPUP_TYPE.CONFIRM, '', { okButton: 'Generate', cancelButton: 'Cancel' });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;

    if (mode === 'scratch') return { references: [] };
    if (mode === 'current') return { references: char.imageUrl ? [char.imageUrl] : [] };
    return { references: chosen.slice() };
}

/**
 * Offers the finished image as use, keep or discard.
 *
 * Three outcomes need three buttons, which a confirm popup does not have, so the custom
 * buttons carry the answer and the popup's own result only tells us it closed. Dismissing
 * the popup any other way counts as discard, since an unwanted file is the thing worth
 * cleaning up.
 *
 * @param {string} url
 * @returns {Promise<'use'|'save'|'discard'>}
 */
async function askResultAction(url) {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-gen-popup';

    const img = document.createElement('img');
    img.src = url;
    img.className = 'sillynpc-genresult-image';
    wrap.append(img);

    const note = document.createElement('p');
    note.className = 'notes';
    note.textContent = 'Use it as the portrait, keep it alongside the others, or delete it.';
    wrap.append(note);

    let answer = 'discard';
    const popup = new Popup(wrap, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: false,
        customButtons: [
            { text: 'Use as portrait', result: POPUP_RESULT.AFFIRMATIVE, action: () => { answer = 'use'; } },
            { text: 'Keep, do not use', result: POPUP_RESULT.AFFIRMATIVE, action: () => { answer = 'save'; } },
            { text: 'Discard', result: POPUP_RESULT.NEGATIVE, action: () => { answer = 'discard'; } },
        ],
    });
    await popup.show();
    return answer;
}

export async function generateCharacterImage(char, { onSave } = {}) {
    const choice = await askGenerationMode(char);
    if (!choice) return;

    let imageUrl;
    try {
        toastr.info('Requesting image generation...', 'SillyNPC');
        imageUrl = await generateCharacterImageLogic(char, { referenceImages: choice.references });
    } catch (err) {
        toastr.error(`Generation failed: ${err.message}`, 'SillyNPC');
        return;
    }

    const action = await askResultAction(imageUrl);

    if (action === 'discard') {
        await deleteGeneratedImage(imageUrl);
        toastr.info('Generated image discarded.', 'SillyNPC');
        return;
    }

    if (!Array.isArray(char.images)) char.images = [];
    if (!char.images.includes(imageUrl)) char.images.push(imageUrl);
    if (action === 'use') char.imageUrl = imageUrl;
    saveSettings();
    if (action === 'use') triggerReprocess();

    toastr.success(
        action === 'use' ? 'Character image updated.' : 'Image saved to this character.',
        'SillyNPC',
    );
    onSave?.();
}
