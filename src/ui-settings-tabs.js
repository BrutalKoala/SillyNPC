import { getSettings, saveSettings } from './settings.js';
import { pickAndProcessImages, resolveImageFolder, describeSaveDestination } from './utils.js';
import { buildSettingSelect, buildSettingToggle, buildSettingTextArea, buildSettingSlider, buildSettingNumber, updateAllExtensionThemes, applyPortraitFraming, applySpeechPadding } from './ui-shared.js';
import { buildPromptEditor, buildPromptBudget } from './ui-prompts.js';
import { renderBanList } from './ui-banlist.js';
import { promptById } from './prompts.js';
import { world_names } from '../../../../world-info.js';
import { extension_settings } from '../../../../extensions.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { LOG_PREFIX, NARRATOR_RULES_PROMPT, SILLYNPC_THEMES, GEMINI_IMAGE_MODELS, PORTRAIT_SHAPES, debugLog, setDebugLogging } from './constants.js';
import { buildLoreExcerpt, resolvePortraitShape, getLastLoreConnection, resolveImageSecretId, scanFolderForCharacterImages, persistGeneratedImage } from './api.js';
import { getSecretLabelById } from '../../../../secrets.js';
import { getRequestHeaders } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { buildConnectionProfilePicker } from './ui-connection-profiles.js';
import { clearRuns } from './default-portraits.js';
import { triggerReprocess } from './chat.js';

/**
 * Display labels for the shipped themes. Built from SILLYNPC_THEMES so the
 * dropdown can never drift out of sync with the themes that actually exist.
 */
const THEME_LABELS = {
    'terminal': 'Terminal (Dark - Mono)',
    'cyberpunk': 'Cyberpunk (Neon - Mono)',
    'monochrome': 'Monochrome (Light)',
    'modern-dark': 'Modern Dark',
    'fantasy-hud': 'Fantasy HUD (Dark - Serif)',
    'tabletop-parchment': 'Tabletop Parchment (Light - Serif)',
    'analog-horror': 'Analog Horror (Dark - Mono)',
    'rosewater': 'Rosewater (Light - Serif)',
};

const THEME_OPTIONS = SILLYNPC_THEMES.map(id => ({ value: id, label: THEME_LABELS[id] || id }));

/**
 * How the chat and the menu look.
 *
 * Was "UI Style", which held the styling but not the four controls that decide whether
 * anything is coloured, whether names are replaced by portraits, or how a portrait is
 * scaled - those were in a tab called Settings, along with the prompts, the popup size and
 * the debug switch. Everything visual is here now.
 */
export function renderAppearanceView(view, onReprocessMessages, updateExtensionTheme) {
    if (!view) return;

    view.replaceChildren();
    const reprocess = () => onReprocessMessages();
    const rerender = () => renderAppearanceView(view, onReprocessMessages, updateExtensionTheme);

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = 'Chat & Menu Styling';
    view.appendChild(title);

    view.append(buildSettingSelect({
        key: 'menuStyle',
        label: 'Unified Theme Style',
        help: 'Unified appearance style that applies to extension menus, sheets, popups, and in-chat status tracker boxes.',
        options: [{ value: 'default', label: 'Seamless Native' }, ...THEME_OPTIONS],
        onChange: () => { updateAllExtensionThemes(); reprocess(); },
    }));
    view.append(buildSettingSlider({
        key: 'menuFontScale',
        label: 'Menu Text Size',
        min: 0.8, max: 1.5, step: 0.05, suffix: 'x',
        help: 'Text in the menus, the character pages and the player sheet, against what '
            + 'the chosen theme sets - so a theme with larger type stays larger.',
        onChange: () => updateAllExtensionThemes(),
    }));
    view.append(buildSettingSlider({
        key: 'trackerFontScale',
        label: 'Tracker Text Size',
        min: 0.8, max: 1.5, step: 0.05, suffix: 'x',
        help: 'Text in the status box in the chat. Separate from the menus because the box '
            + 'sits in the middle of the story and competes with the prose around it - '
            + 'wanting it smaller there is not wanting the settings smaller too.',
        onChange: reprocess,
    }));
    view.append(buildSettingSelect({ key: 'dividerStyle', label: 'Speech Block Dividers', options: [{value:'subtle',label:'Subtle Fade'},{value:'bold',label:'Solid Accent'},{value:'dashed',label:'Dashed Line'},{value:'none',label:'No Dividers'}], onChange: reprocess }));
    view.append(buildSettingSlider({
        key: 'speechPadY',
        label: 'Speech Block Spacing',
        min: 0, max: 30, step: 1, suffix: 'px',
        help: 'Space above and below each character block. The width of the coloured band '
            + 'is fixed; only its height changes here.',
        onChange: () => { applySpeechPadding(); reprocess(); },
    }));

    const colourHeading = document.createElement('h3');
    colourHeading.className = 'sillynpc-section-title';
    colourHeading.style.marginTop = '20px';
    colourHeading.textContent = 'Colour';
    view.append(colourHeading);

    view.append(buildSettingToggle({
        key: 'applyColors',
        label: 'Enable Colored Chat Blocks',
        help: 'The master switch for colour in the chat: with it off nothing is tinted, and '
            + 'any colour the model wrote into its own reply is left showing through. On, a '
            + 'speaker\'s dialogue carries their colour in the style set below.',
        onChange: rerender,
    }));
    // Only while there is colouring for them to affect. Both decide how colour is applied
    // rather than whether it happens, so with the switch above off they do nothing at all -
    // and a live-looking control that does nothing is worse than one that is absent.
    if (getSettings().applyColors) {
        view.append(buildSettingSelect({ key: 'colorStyle', label: 'Character Coloring Logic', options: [{value:'text',label:'Text Only'},{value:'background',label:'Soft Background'},{value:'border',label:'Left Border Accent'},{value:'gradient',label:'Subtle Gradient'},{value:'all',label:'Full Highlight (Strong)'}], onChange: reprocess }));
        view.append(buildSettingToggle({
            key: 'autoColorUnknownSpeakers',
            label: 'Colour Speakers Without A Card',
            help: 'A card\'s own colour always wins, so this is only about everybody else. '
                + 'On, anyone who speaks gets a shade derived from their name - the same '
                + 'name always the same shade. Off, a colour is what marks the characters '
                + 'you have made a card for.',
            onChange: reprocess,
        }));
    }

    const portraitHeading = document.createElement('h3');
    portraitHeading.className = 'sillynpc-section-title';
    portraitHeading.style.marginTop = '20px';
    portraitHeading.textContent = 'Portraits In The Chat';
    view.append(portraitHeading);

    view.append(buildSettingSelect({ key: 'avatarShape', label: 'Chat Avatar Shape', options: [{value:'square',label:'Sharp Square'},{value:'rounded',label:'Rounded Corners'},{value:'circle',label:'Perfect Circle'}], onChange: reprocess }));
    view.append(buildSettingSelect({ key: 'avatarSize', label: 'Chat Avatar Size', options: [{value:'small',label:'Small (44px)'},{value:'medium',label:'Medium (64px)'},{value:'large',label:'Large (96px)'},{value:'extra',label:'Extra Large (132px)'}], onChange: reprocess }));
    view.append(buildSettingSelect({ key: 'defaultImageFit', label: 'Avatar Image Scaling', options: [{value:'contain',label:'Fit within frame (Contain)'},{value:'cover',label:'Fill frame completely (Cover)'}], onChange: reprocess }));
    view.append(buildSettingSelect({
        key: 'portraitFraming',
        label: 'Portrait Framing',
        options: [
            { value: 'top', label: 'Keep the top (faces)' },
            { value: 'center', label: 'Keep the middle' },
            { value: 'bottom', label: 'Keep the bottom' },
        ],
        help: 'The floating HUD and the tracker box show portraits in circles, so a tall '
            + 'image loses two of its edges. Keeping the top shows the head in almost any '
            + 'portrait; change it if your pictures are framed differently.',
        onChange: () => { applyPortraitFraming(); reprocess(); },
    }));
    view.append(buildSettingToggle({
        key: 'hideSpeakerNames',
        label: 'Hide Default Speaker Names',
        help: 'Replaces the bold name before a colon with that character\'s portrait. Only '
            + 'where there is a card to supply one: a speaker without a card keeps their '
            + 'name, since telling two of them apart is what the name is doing.',
        onChange: reprocess,
    }));

    renderDefaultView(view, rerender);
}

/**
 * What the model is asked to write, and how what it writes is read back.
 *
 * A tab of its own because these three - the dialogue format, the narrator rules and the
 * ban list - are one job done three ways, and they were scattered across two tabs, one of
 * which was called Settings and held the popup size as well.
 *
 * The reading half belongs with them rather than with the styling: "Not Speakers" and
 * lenient matching decide what counts as somebody talking, which is the same question the
 * dialogue format asks the model to make easy.
 */
export function renderWritingRulesView(view, onReprocessMessages) {
    if (!view) return;

    view.replaceChildren();
    const reprocess = () => onReprocessMessages();
    const rerender = () => renderWritingRulesView(view, onReprocessMessages);

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = 'What The Model Is Asked To Write';
    view.appendChild(title);

    const intro = document.createElement('p');
    intro.className = 'notes sillynpc-tab-intro';
    intro.textContent = 'Everything here is sent with your messages, and each is placed '
        + 'rather than merely worded: where an instruction sits in the prompt decides '
        + 'whether it holds. Only the dialogue format is on to begin with, because the '
        + 'rest of the extension reads what it asks for.';
    view.appendChild(intro);

    const formatHeading = document.createElement('h4');
    formatHeading.className = 'sillynpc-subsection-title';
    formatHeading.textContent = 'Dialogue Formatting';
    view.append(formatHeading);

    view.append(buildSettingToggle({
        key: 'dialogueFormatEnabled',
        label: 'Ask The Model To Format Dialogue',
        help: 'Sends the Dialogue Format prompt with every message, asking for a speaker '
            + 'line - a name in bold followed by a colon - which is what avatars, speech '
            + 'blocks and colours all read. Without it, whether your chat is decorated '
            + 'depends on your persona or preset happening to ask for the same thing, and '
            + 'switching either one silently stops all of it.',
        onChange: rerender,
    }));
    if (getSettings().dialogueFormatEnabled) {
        view.append(buildPromptEditor(promptById('dialogueFormat')));
        view.append(buildSettingNumber({
            key: 'dialogueFormatDepth',
            advanced: true,
            label: 'Format Reminder Depth',
            suffix: 'messages back',
            help: 'How far back from the newest message the prompt above is inserted. 0 '
                + 'puts it after the newest one, so it is the last thing the model reads '
                + 'before answering - which is where a layout rule holds best, and why it '
                + 'is the default. Raise it only if it crowds something you would rather '
                + 'have last.',
        }));
    }

    const narratorHeading = document.createElement('h4');
    narratorHeading.className = 'sillynpc-subsection-title';
    narratorHeading.textContent = 'Narrator Rules';
    view.append(narratorHeading);

    view.append(buildSettingToggle({
        key: 'narratorRulesEnabled',
        label: 'Send Narrator Rules Late In The Prompt',
        help: 'For the rules a narrator keeps breaking: speaking or acting for you, '
            + 'recapping what just happened, wrapping the scene up, summarising instead of '
            + 'writing it. Written into a card those sit at the top of the prompt with the '
            + 'whole chat between them and the moment they apply, which is why rewording '
            + 'one so often changes nothing - where it sits was the problem, not how it '
            + 'was phrased. Switching this on fills the box with a working set to edit; '
            + 'emptying the box sends nothing.',
        onChange: () => {
            // Filled on the way on, not shipped as a default. Nothing is ever sent while
            // the feature is off, so this cannot put words in a prompt nobody asked for -
            // and a blank field beside "write something here" is not guidance.
            const settings = getSettings();
            if (settings.narratorRulesEnabled
                && !String(settings.narratorRulesPrompt ?? '').trim()) {
                settings.narratorRulesPrompt = NARRATOR_RULES_PROMPT;
                saveSettings();
            }
            rerender();
        },
    }));
    if (getSettings().narratorRulesEnabled) {
        view.append(buildPromptEditor(promptById('narratorRules')));
        view.append(buildSettingNumber({
            key: 'narratorRulesDepth',
            advanced: true,
            label: 'Narrator Rules Depth',
            suffix: 'messages back',
            help: 'How far back from the newest message the rules are inserted. 0 puts '
                + 'them after the newest one, last before the model answers, which is '
                + 'where an instruction holds best. Raise it if it crowds the dialogue '
                + 'format, which wants the same place.',
        }));
    }

    const banHeading = document.createElement('h4');
    banHeading.className = 'sillynpc-subsection-title';
    banHeading.textContent = 'Ban List';
    view.append(banHeading);

    view.append(buildSettingToggle({
        key: 'banListEnabled',
        label: 'Stop The Model Repeating Itself',
        help: 'Phrases you have banned are sent to the sampler where your backend takes '
            + 'them, which means the model cannot write them - not that it is asked not '
            + 'to. On an API that has no such thing they are asked for in the prompt '
            + 'instead, and the panel says which of the two you are getting.',
        onChange: rerender,
    }));
    if (getSettings().banListEnabled) {
        const banPanel = document.createElement('div');
        view.append(banPanel);
        renderBanList(banPanel);

        view.append(buildSettingNumber({
            key: 'banScanDepth',
            advanced: true,
            label: 'Scan Depth',
            suffix: 'replies',
            help: 'How many of the model\'s own replies the scan reads. Your own messages '
                + 'are skipped - your habits are not what this is for. 0 reads the whole '
                + 'chat, which costs more and finds older habits.',
        }));
    }

    const readingHeading = document.createElement('h3');
    readingHeading.className = 'sillynpc-section-title';
    readingHeading.style.marginTop = '24px';
    readingHeading.textContent = 'How Its Writing Is Read';
    view.append(readingHeading);

    const readingNote = document.createElement('p');
    readingNote.className = 'notes sillynpc-tab-intro';
    readingNote.textContent = 'The other side of the same question: which of the words in a '
        + 'reply are somebody speaking.';
    view.append(readingNote);

    view.append(buildSettingTextArea({
        key: 'speakerIgnoreList',
        label: 'Not Speakers',
        help: 'Words the narrator writes in bold before a colon that are not people - DC, '
            + 'Cost, Damage, Roll. One per line or separated by commas. Everything you '
            + 'named in System Builder is already excluded, so stats and collections need '
            + 'no entry here. A character who has a card is never ignored.',
        onChange: reprocess,
    }));
    view.append(buildSettingToggle({
        key: 'caseInsensitive',
        label: 'Lenient Name Matching',
        help: 'Matches character names regardless of uppercase/lowercase letters.',
        onChange: reprocess,
    }));
}

/**
 * The extension itself: whether it runs, how big its menu is, and how to see what it does.
 *
 * What is left of a tab called Settings once everything that belonged to a subject went to
 * that subject's tab. These four genuinely belong to no feature.
 *
 * @param {HTMLElement} view
 * @param {{ applyPopupSize: () => void, onExport: () => void, onImport: () => void }} handlers
 */
export function renderAdvancedView(view, handlers = {}) {
    if (!view) return;
    const { applyPopupSize, onExport, onImport } = handlers;

    view.replaceChildren();
    // Dev mode changes which controls exist, so the panel is drawn again rather than left
    // showing the answer to the previous question.
    const rerender = () => renderAdvancedView(view, handlers);

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = 'SillyNPC';
    view.appendChild(title);

    view.append(buildSettingToggle({
        key: 'enabled',
        label: 'Enable SillyNPC',
        help: 'The master switch. Off, nothing is decorated, no prompt is sent and the '
            + 'tracker reads nothing - your characters and everything they hold are kept.',
        onChange: () => triggerReprocess(),
    }));

    view.append(buildSettingToggle({
        key: 'devMode',
        label: 'Show Every Setting',
        help: 'Eighteen settings are hidden to begin with: reply budgets, transcript sizes, '
            + 'prompt depths, and the two that can lose an update if set wrong. Their '
            + 'defaults are right until something specific goes wrong, and meeting all '
            + 'eighty-one at once is how the useful ones get lost among them. Nothing is '
            + 'removed - this shows them again, on every tab.',
        onChange: () => rerender(),
    }));

    const sizeHeading = document.createElement('h3');
    sizeHeading.className = 'sillynpc-section-title';
    sizeHeading.style.marginTop = '20px';
    sizeHeading.textContent = 'Menu Size';
    view.append(sizeHeading);

    view.append(buildSettingSlider({ key: 'popupWidth', label: 'Menu Width', min: 20, max: 100, suffix: 'vw', help: 'Width relative to screen size.', onChange: () => applyPopupSize?.() }));
    view.append(buildSettingSlider({ key: 'popupHeight', label: 'Menu Height', min: 20, max: 100, suffix: 'vh', help: 'Height relative to screen size.', onChange: () => applyPopupSize?.() }));

    const backupHeading = document.createElement('h3');
    backupHeading.className = 'sillynpc-section-title';
    backupHeading.style.marginTop = '20px';
    backupHeading.textContent = 'Backup';
    view.append(backupHeading);

    const backupNote = document.createElement('p');
    backupNote.className = 'notes sillynpc-tab-intro';
    backupNote.textContent = 'Everything at once - every character, every setting, every '
        + 'System. Importing one replaces all of it, so this is a backup rather than a way '
        + 'to share: to send somebody a single character, use Export on their page.';
    view.append(backupNote);

    const backupRow = document.createElement('div');
    backupRow.className = 'sillynpc-backup-row';

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'menu_button';
    exportBtn.innerHTML = '<i class="fa-solid fa-file-export"></i> <span>Export everything</span>';
    exportBtn.addEventListener('click', () => onExport?.());

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'menu_button';
    importBtn.innerHTML = '<i class="fa-solid fa-file-import"></i> <span>Import a backup</span>';
    importBtn.addEventListener('click', () => onImport?.());

    backupRow.append(exportBtn, importBtn);
    view.append(backupRow);

    const troubleshooting = document.createElement('h3');
    troubleshooting.className = 'sillynpc-section-title';
    troubleshooting.style.marginTop = '20px';
    troubleshooting.textContent = 'Troubleshooting';
    view.append(troubleshooting);

    view.append(buildSettingToggle({
        key: 'debugLogging',
        label: 'Log Requests To The Console',
        help: 'Prints one line in the browser console for every request SillyNPC makes - '
            + 'lore, extraction and portraits - naming the connection, the model and which '
            + 'API key it used. Off by default because extraction runs after every message. '
            + 'Open the console with F12.',
        onChange: () => setDebugLogging(getSettings().debugLogging),
    }));
}

/**
 * The pool of faces for speakers who have none.
 *
 * Was one picture and a Browse button. One picture meant every stranger in the story wore
 * the same face, which is worse than no picture at all - it says these are all one person.
 *
 * @param {HTMLElement} view
 * @param {() => void} rerender
 */
export function renderDefaultView(view, rerender) {
    if (!view) return;

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = 'Faces For Strangers';
    view.appendChild(title);

    const help = document.createElement('p');
    help.className = 'notes sillynpc-pool-note';
    help.textContent = 'Anybody who speaks without a card of their own wears one of these, '
        + 'and so does a character whose card has no portrait yet. Add as many as you like: '
        + 'with only one, every stranger in the story is the same face.';
    view.appendChild(help);

    const sticky = document.createElement('p');
    sticky.className = 'notes sillynpc-pool-note';
    sticky.textContent = 'A face is drawn once and kept, not picked again on every redraw. '
        + 'A stranger holds theirs while they keep appearing and draws a new one if they '
        + 'turn up again much later - the guard you talk to for three messages is one '
        + 'guard, and the guard two hundred messages later is somebody else. A character '
        + 'with a card keeps theirs for good, until you give them a portrait.';
    view.appendChild(sticky);

    const pool = Array.isArray(getSettings().defaultImages) ? getSettings().defaultImages : [];

    const grid = document.createElement('div');
    grid.className = 'sillynpc-pool-grid';

    if (pool.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'notes sillynpc-pool-empty';
        empty.textContent = 'No faces yet. Until there is at least one, a speaker with no '
            + 'card gets the plain silhouette.';
        grid.appendChild(empty);
    }

    pool.forEach((entry, index) => {
        const cell = document.createElement('div');
        cell.className = 'sillynpc-pool-cell';

        const frame = document.createElement('div');
        frame.className = 'sillynpc-pool-frame';
        const img = document.createElement('img');
        img.src = entry.src;
        img.alt = '';
        frame.appendChild(img);
        cell.appendChild(frame);

        // Free text rather than a fixed vocabulary: what a world is full of is the world's
        // business. Matched against the words in a speaker's name and a card's category.
        const tags = document.createElement('input');
        tags.type = 'text';
        tags.className = 'text_pole sillynpc-pool-tags';
        tags.placeholder = 'guard, soldier';
        tags.title = 'Words that decide who can draw this face. A speaker whose name or '
            + 'category contains one of them draws from the tagged faces only.';
        tags.value = (entry.tags || []).join(', ');
        tags.addEventListener('change', () => {
            entry.tags = tags.value.split(',').map(t => t.trim()).filter(Boolean);
            saveSettings();
        });
        cell.appendChild(tags);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'menu_button sillynpc-pool-remove';
        remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        remove.title = 'Take this face out of the pool.';
        remove.addEventListener('click', () => {
            getSettings().defaultImages.splice(index, 1);
            saveSettings();
            // Anybody already wearing it is given another the next time they are drawn;
            // faceForCard checks that the face it remembers is still in the pool.
            rerender?.();
        });
        cell.appendChild(remove);

        grid.appendChild(cell);
    });

    view.appendChild(grid);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'menu_button';
    addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> <span>Add faces</span>';
    addBtn.title = 'Choose one or several pictures at once.';
    addBtn.addEventListener('click', async () => {
        // Full size, because these are written to disk like any other portrait rather than
        // stored inline - the small cap only ever cost quality.
        const picked = await pickAndProcessImages({ fullSize: true });
        if (!picked.length) return;

        addBtn.disabled = true;
        try {
            const settings = getSettings();
            if (!Array.isArray(settings.defaultImages)) settings.defaultImages = [];
            for (const dataUri of picked) {
                const stored = await persistGeneratedImage(dataUri, 'default');
                settings.defaultImages.push({ src: stored, tags: [] });
            }
            saveSettings();
            toastr.success(`Added ${picked.length} face${picked.length === 1 ? '' : 's'}.`, 'SillyNPC');
        } catch (err) {
            console.error(LOG_PREFIX, 'Could not add fallback portraits', err);
            toastr.error(String(err.message || err), 'SillyNPC');
        } finally {
            addBtn.disabled = false;
            rerender?.();
        }
    });
    view.appendChild(addBtn);

    // Only worth asking once there is more than one face to swap between.
    if (pool.length > 1) {
        view.appendChild(buildSettingNumber({
            key: 'defaultPortraitRunGap',
            label: 'A Stranger Is Somebody New After',
            suffix: 'messages away',
            help: 'How long a stranger can be absent before the next sighting draws a new '
                + 'face. Lower means a busier world of one-off faces; higher means the same '
                + 'stranger is remembered across a longer stretch of story.',
        }));

        const forget = document.createElement('button');
        forget.type = 'button';
        forget.className = 'menu_button';
        forget.innerHTML = '<i class="fa-solid fa-arrow-rotate-left"></i> <span>Redraw every face in this chat</span>';
        forget.title = 'Forgets which face this chat gave to whom, so everybody draws again.';
        forget.addEventListener('click', async () => {
            const ok = await Popup.show.confirm('Redraw every face',
                'Everybody without a card of their own draws a new face. Nothing else changes.');
            if (!ok) return;
            clearRuns();
            triggerReprocess();
            rerender?.();
        });
        view.appendChild(forget);
    }
}

export function renderGenerationSettingsView(view) {
    if (!view) return;
    
    view.replaceChildren();
    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = 'Lorebook & AI';
    view.appendChild(title);

    view.append(buildWorldInfoScannerSettings());
    view.append(buildSettingSelect({ key: 'defaultLorebook', label: 'Default Target Lorebook', options: [{value:'',label:'-- current --'}, ...(Array.isArray(world_names) ? world_names : []).map(w => ({value:w,label:w}))] }));
    view.append(buildSettingSelect({
        key: 'contextMessages',
        label: 'Chat To Read',
        options: [
            { value: 5, label: 'Last 5 messages' },
            { value: 10, label: 'Last 10 messages' },
            { value: 15, label: 'Last 15 messages' },
            { value: 30, label: 'Last 30 messages' },
            { value: 50, label: 'Last 50 messages' },
            { value: 100, label: 'Last 100 messages' },
            { value: 200, label: 'Last 200 messages' },
            { value: 0, label: 'Whole chat' },
        ],
        help: 'How much of the story the lore writer sees. Whichever you pick, the excerpt '
            + 'is capped below - whole messages, newest first - so a long story is trimmed '
            + 'rather than making a request no model can take.',
    }));
    const excerptReadout = document.createElement('small');
    excerptReadout.className = 'notes';
    excerptReadout.style.cssText = 'display:block; margin:-2px 0 10px;';
    view.append(buildSettingNumber({
        key: 'loreCharBudget',
        advanced: true,
        label: 'Story Excerpt',
        suffix: 'characters',
        help: 'How much of the story is copied into the lore prompt, counted in characters - '
            + 'roughly four per token. Whole messages, newest first, until the next one will '
            + 'not fit. This is a single request and cannot be split into passes the way the '
            + 'history scan is, so the figure below is what one lore generation costs.',
        onChange: () => updateExcerptReadout(excerptReadout),
    }));
    updateExcerptReadout(excerptReadout);
    view.append(excerptReadout);
    view.append(buildSettingToggle({
        key: 'loreUseDataBank',
        label: 'Search the Data Bank',
        help: 'Look the character up in your Data Bank before writing, and give the writer '
            + 'what it finds. Needs SillyTavern\'s Vector Storage with Data Bank files '
            + 'enabled; its own chunk-count setting decides how much comes back. Searched '
            + 'by name. SillyTavern skips vectors for background requests like this one, '
            + 'so without this the writer never sees your Data Bank at all.',
    }));
    view.append(buildConnectionProfilePicker(null, {
        key: 'loreProfileId',
        scope: 'root',
        labelText: 'Lore Connection',
        fallbackLabel: 'Main API (same as chat)',
        noteText: 'Which connection writes lore entries. Separate from the tracker\'s: a '
            + 'small model chosen for returning JSON is not the one you want writing prose.',
        unavailableText: 'Connection Manager is not available, so lore is written by your '
            + 'main API. Enable the Connection Manager extension to choose another model.',
    }));
    view.append(buildLastLoreConnectionNote());
    view.append(buildPromptBudget(promptById('lore')));
    view.append(buildPromptEditor(promptById('lore')));
    
    const imgTitle = document.createElement('h3');
    imgTitle.className = 'sillynpc-section-title';
    imgTitle.style.marginTop = '20px';
    imgTitle.textContent = 'Image Generation';
    view.append(imgTitle);

    // Re-render so the Gemini-only controls appear/disappear with the backend choice.
    const rerender = () => renderGenerationSettingsView(view);

    view.append(buildSettingSelect({
        key: 'imageBackend',
        label: 'Portrait Source',
        options: [
            { value: 'sd', label: "SillyTavern's Image Generation (shared)" },
            { value: 'gemini', label: 'Google Gemini image model (set up here)' },
        ],
        help: "SillyTavern's Image Generation draws with whatever that extension is already "
            + 'set to - source, model, sampler, steps - shared with /imagine and everything '
            + 'else in SillyTavern. SillyNPC adds only the prompt and the shape. The Gemini '
            + 'option is configured here instead and is independent of those settings; it '
            + "exists because that extension's Google source lists only imagen-* and veo-*, "
            + 'so the Gemini image models cannot be reached any other way.',
        onChange: rerender,
    }));
    view.append(buildBackendDestinationNote());

    if (getSettings().imageBackend === 'gemini') {
        view.append(buildSettingSelect({
            key: 'geminiImageModel',
            label: 'Gemini Image Model',
            options: GEMINI_IMAGE_MODELS.map(m => ({ value: m, label: m })),
            help: 'Only these models can return an image. Anything else replies with text.',
        }));
        view.append(buildConnectionProfilePicker(rerender, {
            key: 'imageProfileId',
            scope: 'root',
            labelText: 'Image Connection',
            fallbackLabel: 'Whichever Google key is active',
            noteText: 'Whose API key pays for portraits. Only the key and the account are '
                + 'taken from the profile - the model stays the one chosen above, because a '
                + 'connection profile can only name a text model. Left unset, portraits are '
                + 'billed to whichever Google key SillyTavern currently has active, which '
                + 'is the same key your chat is using.',
            unavailableText: 'Connection Manager is not available, so portraits are billed '
                + 'to whichever Google key is active. Enable the Connection Manager '
                + 'extension to choose one.',
        }));
    }

    view.append(buildSettingSelect({
        key: 'portraitShape',
        label: 'Portrait Shape',
        options: Object.entries(PORTRAIT_SHAPES).map(([value, shape]) => ({ value, label: shape.label })),
        help: 'The shape portraits come back in, for both sources. 3:4 is what the chat '
            + 'avatars and character cards are built around. This used to be fixed at '
            + '512x768 for the Image Generation extension and set separately for Gemini, so '
            + 'whatever Resolution you had chosen in SillyTavern was overridden without '
            + 'saying so - the last option is how you keep it.',
        onChange: rerender,
    }));
    
    view.append(buildSettingSelect({ key: 'imgGenContextMessages', advanced: true, label: 'Image Context Length', options: [{value:0,label:'Lore Only'},{value:5,label:'5'},{value:10,label:'10'},{value:20,label:'20'}] }));
    view.append(buildPromptEditor(promptById('image')));
    // Both of these are backend-specific, and the registry entry knows which - so the
    // condition is not written out a second time here.
    for (const id of ['imageReference', 'imageNegative']) {
        const entry = promptById(id);
        if (entry.available()) view.append(buildPromptEditor(entry));
    }

    const pathWrap = document.createElement('div');
    pathWrap.className = 'sillynpc-setting';
    
    const pathRow = document.createElement('label');
    pathRow.className = 'sillynpc-setting-row';
    pathRow.style.fontWeight = 'bold';
    pathRow.textContent = 'Folder Name';

    const fieldWrap = document.createElement('div');
    fieldWrap.className = 'sillynpc-path-field';

    // Shows where the file really lands. The field is not a path and never was: the upload
    // route sanitises ch_name to a single segment server-side, so "images/sillynpc" arrives
    // as "sillynpc". Saying so beats letting the user infer a nesting that does not happen.
    const resolved = document.createElement('small');
    resolved.className = 'notes';
    resolved.style.cssText = 'display:block; margin-top:4px;';
    const showResolved = () => {
        resolved.textContent = describeSaveDestination(getSettings().imageSaveRoute);
    };

    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.className = 'text_pole';
    pathInput.id = 'sillynpc-save-path';
    pathInput.value = getSettings().imageSaveRoute;
    pathInput.addEventListener('input', () => {
        getSettings().imageSaveRoute = pathInput.value;
        showResolved();
        saveSettings();
    });
    // On blur rather than on input: cleaning mid-keystroke would eat the separator as it
    // is typed, so the field could never hold one long enough to explain itself. The line
    // above does the explaining while typing; this settles it once the user has finished.
    pathInput.addEventListener('change', () => {
        const folder = resolveImageFolder(pathInput.value);
        if (pathInput.value === folder) return;
        pathInput.value = folder;
        getSettings().imageSaveRoute = folder;
        showResolved();
        saveSettings();
    });

    const browsePathBtn = document.createElement('button');
    browsePathBtn.type = 'button';
    browsePathBtn.className = 'menu_button browse-path-btn';
    browsePathBtn.title = 'Browse folders';
    browsePathBtn.innerHTML = '<i class="fa-solid fa-folder-open"></i>';
    browsePathBtn.addEventListener('click', async () => {
        // The old handler was a text prompt wearing a folder icon - it asked for the same
        // string the field already held and could not tell you what existed. The server
        // lists the real directories, so offer those.
        const folders = await listUserImageFolders();
        const chosen = await pickImageFolder(folders, getSettings().imageSaveRoute);
        if (!chosen) return;
        // A name picked from the list is already one segment; one typed into the popup is
        // not, and arrives by the same door.
        const folder = resolveImageFolder(chosen);
        getSettings().imageSaveRoute = folder;
        pathInput.value = folder;
        showResolved();
        saveSettings();
    });

    fieldWrap.append(pathInput, browsePathBtn);

    const notes = document.createElement('small');
    notes.className = 'notes';
    notes.textContent = 'One folder name under user/images/, not a path - portraits are '
        + 'written there rather than stored inline in your settings file.';

    showResolved();
    pathWrap.append(pathRow, fieldWrap, resolved, notes);
    view.append(pathWrap);

    // Portraits were written here long before the extension kept a list of them, so a
    // character can have several pictures in the folder and know about one.
    const scanWrap = document.createElement('div');
    scanWrap.className = 'sillynpc-setting';

    const scanBtn = document.createElement('button');
    scanBtn.type = 'button';
    scanBtn.className = 'menu_button';
    scanBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Find existing images';
    scanBtn.addEventListener('click', async () => {
        scanBtn.disabled = true;
        try {
            const { scanned, added, characters } = await scanFolderForCharacterImages();
            if (!added) {
                toastr.info(`Looked at ${scanned} file${scanned === 1 ? '' : 's'}; nothing new to add.`, 'SillyNPC');
            } else {
                toastr.success(
                    `Added ${added} image${added === 1 ? '' : 's'} to ${characters} character${characters === 1 ? '' : 's'}.`,
                    'SillyNPC',
                );
            }
        } catch (err) {
            toastr.error(err.message, 'SillyNPC');
        } finally {
            scanBtn.disabled = false;
        }
    });

    const scanNote = document.createElement('small');
    scanNote.className = 'notes';
    scanNote.style.cssText = 'display:block; margin-top:4px;';
    scanNote.textContent = 'Matches files in the folder above to characters by the name they '
        + "were saved under, and adds anything missing to that character's image list. "
        + "Only finds images SillyNPC generated: pictures made through SillyTavern's own "
        + 'gallery are named after the character card, so there is nothing in the filename '
        + 'to match them by.';

    scanWrap.append(scanBtn, scanNote);
    view.append(scanWrap);
}

/**
 * The folders that actually exist under user/images/.
 *
 * Returns an empty list rather than throwing when the request fails - a browse button
 * that cannot reach the server should degrade to "type it yourself", not break the
 * settings panel it lives in.
 *
 * @returns {Promise<string[]>}
 */
async function listUserImageFolders() {
    try {
        const response = await fetch('/api/images/folders', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (!response.ok) return [];
        const folders = await response.json();
        return Array.isArray(folders) ? folders.filter(f => typeof f === 'string') : [];
    } catch (err) {
        debugLog('Could not list image folders', err);
        return [];
    }
}

/**
 * Asks which folder to save into, offering the ones that exist.
 *
 * The button used to open a bare text prompt seeded with the value the field already
 * showed, which told the user nothing they did not already know. Listing the real
 * directories is the difference between a browse button and a rename box.
 *
 * A new name is still allowed - the folder is created on first write - so the list is an
 * offer, not a restriction.
 *
 * @param {string[]} folders
 * @param {string} current
 * @returns {Promise<string|null>} The chosen folder, or null if cancelled.
 */
async function pickImageFolder(folders, current) {
    if (!folders.length) {
        const typed = await Popup.show.input(
            'Generated Image Folder',
            'No folders exist under user/images/ yet. Name one to create:',
            current,
        );
        return typed?.trim() || null;
    }

    const wrap = document.createElement('div');
    const label = document.createElement('p');
    label.textContent = 'Choose a folder under user/images/, or type a new name to create one.';

    const list = document.createElement('select');
    list.className = 'text_pole';
    list.size = Math.min(8, folders.length + 1);
    list.style.cssText = 'width:100%; margin:8px 0;';

    const resolvedCurrent = resolveImageFolder(current);
    for (const folder of folders) {
        const option = document.createElement('option');
        option.value = folder;
        option.textContent = folder;
        if (folder === resolvedCurrent) option.selected = true;
        list.append(option);
    }

    const typed = document.createElement('input');
    typed.type = 'text';
    typed.className = 'text_pole';
    typed.placeholder = 'or type a new folder name';
    typed.style.cssText = 'width:100%;';

    wrap.append(label, list, typed);

    const popup = new Popup(wrap, POPUP_TYPE.CONFIRM, "", { okButton: "Use folder", cancelButton: "Cancel" });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;

    // A typed name wins over the selection: someone who took the trouble to type meant it.
    return typed.value.trim() || list.value || null;
}
/**
 * Which connection the last lore generation actually used.
 *
 * Choosing a connection here has never changed what the chat uses - the request carries the
 * profile rather than selecting it - but that was only ever arguable from the code, never
 * checkable from the UI. This turns the next such question into a fact.
 */
function buildLastLoreConnectionNote() {
    const note = document.createElement('small');
    note.className = 'notes';
    note.style.cssText = 'display:block; margin:-6px 0 10px;';

    const last = getLastLoreConnection();
    note.textContent = last
        ? `Last lore request used: ${last.label}. Your chat's own connection is never changed by this.`
        : "No lore generated yet this session. Your chat's own connection is never changed by this.";
    return note;
}

/**
 * What one lore generation would cost, right now, on the open chat.
 *
 * The setting is in characters, the chat is in messages and the bill is in tokens, and no
 * amount of help text bridges those three. Measuring the open chat does: it turns "200000"
 * into "83 of 469 messages, ~49,900 tokens", which is the number the user is actually
 * deciding about.
 *
 * Uses buildLoreExcerpt so this can never disagree with what is really sent - it is the
 * same function, on the same chat, with the same settings.
 *
 * @param {HTMLElement} target
 */
function updateExcerptReadout(target) {
    const chat = getContext()?.chat;
    if (!Array.isArray(chat) || chat.length === 0) {
        target.textContent = 'Open a chat to see what this costs.';
        return;
    }

    const { text, used, available } = buildLoreExcerpt(chat);
    // Four characters per token is the rule of thumb the setting's own help uses; it is
    // an estimate and is labelled as one rather than dressed up as a count.
    const tokens = Math.round(text.length / 4);
    target.textContent = `Right now: ${used} of ${available} messages, `
        + `${text.length.toLocaleString()} characters, ~${tokens.toLocaleString()} tokens per request.`;
}

/**
 * Where portraits will actually be drawn, read live.
 *
 * Both questions this answers were ones the settings could not: whose API the Gemini
 * option uses, and what the /sd option is currently pointed at. Read from SillyTavern's
 * own Image Generation settings rather than described in prose, because prose goes stale
 * and the answer changes whenever that extension is reconfigured.
 */
function buildBackendDestinationNote() {
    const note = document.createElement('small');
    note.className = 'notes';
    note.style.cssText = 'display:block; margin:-6px 0 10px;';

    const settings = getSettings();
    if (settings.imageBackend === 'gemini') {
        // Naming the key is the fact that was missing. Two connection profiles that
        // pin the same secret look completely different by name and identical here,
        // which is the failure that took an evening to find. The label carries a
        // masked value from SillyTavern, never the key itself.
        const secretId = resolveImageSecretId();
        const keyLabel = secretId ? getSecretLabelById(secretId) : '';
        const whichKey = keyLabel
            ? `Billed to: ${keyLabel}.`
            : "Billed to whichever Google key is active - the same one your chat uses.";
        note.textContent = "Sends to SillyTavern's Google AI Studio connection, using the "
            + `key saved there — not whichever API you are chatting with. Model: ${settings.geminiImageModel}, `
            + `aspect ratio ${resolvePortraitShape().gemini}. ${whichKey}`;
        return note;
    }

    const sd = extension_settings.sd || {};
    const where = sd.source
        ? `${sd.source}${sd.model ? ` / ${sd.model}` : ''}`
        : 'not configured yet';

    // The resolution line is the one that was missing from both UIs. The pixels we send
    // do not survive every source - Google converts them to the nearest ratio it accepts
    // and ignores the rest - so this says what is sent, and the shape control above says
    // what shape that works out to.
    const { pixels } = resolvePortraitShape();
    const size = pixels
        ? `Sent at ${pixels.width}x${pixels.height}, overriding its own Resolution setting`
        : `Using its own Resolution setting${sd.width && sd.height ? ` (${sd.width}x${sd.height})` : ''}`;

    note.textContent = `Sends to the Image Generation extension, currently set to: ${where}. `
        + `${size}. Its own prompt prefix and negative prompt are added to yours. `
        + 'The key is whichever SillyTavern has active for that source; SillyNPC cannot choose it on this path.';
    return note;
}

function buildWorldInfoScannerSettings() {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-setting';
    
    const label = document.createElement('label');
    label.className = 'sillynpc-setting-row';
    label.style.fontWeight = 'bold';
    label.textContent = 'World Info to Scan';
    
    const list = document.createElement('div');
    list.className = 'sillynpc-world-list';
    list.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:6px';
    
    const selected = getSettings().scanLorebooks || [];
    (Array.isArray(world_names) ? world_names : []).forEach(name => {
        const item = document.createElement('label');
        item.className = 'checkbox_label';
        
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = selected.includes(name);
        input.addEventListener('change', (e) => {
            if (e.target.checked) { if (!selected.includes(name)) selected.push(name); }
            else { const i = selected.indexOf(name); if (i !== -1) selected.splice(i, 1); }
            getSettings().scanLorebooks = selected; saveSettings();
        });
        
        item.append(input, ` ${name}`);
        list.append(item);
    });
    
    wrap.append(label, list);
    return wrap;
}
