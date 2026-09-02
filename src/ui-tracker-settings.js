import { getSettings, saveSettings, defaultSettings } from './settings.js';
import { buildPromptEditor } from './ui-prompts.js';
import { promptById } from './prompts.js';
import { tidyTemplateLabels } from './ui-template-tidy.js';
import { buildSettingToggle, buildSettingTextArea, buildSettingSlider, buildSettingSelect, updateExtensionTheme, repositionCloseButton } from './ui-shared.js';
import { loadStateFromMetadata, saveStateToMetadata, syncPlayerToMaster, applyCheckpointSchedule, getHistoryEntries, restoreHistoryEntry } from './status-logic.js';
import { POPUP_TYPE, Popup } from '../../../../popup.js';
import { eventSource } from '../../../../events.js';
import { triggerReprocess } from './chat.js';
import { updateHUD } from './ui-hud.js';
import { escapeHtml } from './utils.js';
import { cleanChatHistory, measureChatOverhead, estimateTokens } from './status-history.js';
import { buildConnectionProfilePicker } from './ui-connection-profiles.js';

/**
 * The Tracker settings tab, and the two popups it opens.
 *
 * Split out of status-settings.js, which rendered this tab, the HUD tab, System Builder
 * and System Manager from one 2283-line file.
 */

/**
 * Renders the status tracker settings view.
 *
 * Two callbacks, deliberately. Only a handful of controls decide whether *other*
 * controls exist, and only those need the panel rebuilt; everything else saves and lets
 * the chat catch up in place. Rebuilding on every change is what lost your scroll
 * position on each click and made dragging a slider impossible.
 *
 * @param {HTMLElement} container
 */
export function renderStatusView(container) {
    if (!container) return;
    container.replaceChildren();

    const settings = getSettings().statusTracker;

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = 'Display';
    container.appendChild(title);

    /** Rebuilds the panel. Only for controls that add or remove other controls. */
    const onChange = () => {
        const scrollParent = container.closest('.sillynpc-tab-panel') || container.closest('.popup-body') || container;
        const top = scrollParent.scrollTop;
        renderStatusView(container);
        requestAnimationFrame(() => {
            if (scrollParent) scrollParent.scrollTop = top;
        });
        triggerReprocess();
        updateHUD();
    };

    /** Saves and refreshes the chat, leaving the panel alone. Used by almost everything. */
    const onApply = () => {
        saveSettings();
        triggerReprocess();
        updateHUD();
    };

    const section = (name) => {
        const h = document.createElement('h3');
        h.className = 'sillynpc-section-title';
        h.style.marginTop = '20px';
        h.textContent = name;
        container.appendChild(h);
    };

    /* -- Display ----------------------------------------------------------- */

    container.append(buildSettingToggle({
        key: 'statusTracker.enabled',
        label: 'Enable Status Tracker',
        help: 'Tracks stats, inventories and who is in the scene, and shows them under '
            + 'your messages.',
        onChange
    }));

    // One question, not two: both of these only ever answered "where does the box go".
    container.append(buildPlacementPicker(settings, onApply));

    container.append(buildSettingToggle({
        key: 'statusTracker.showGlobalStats',
        label: 'Show World Stats',
        help: 'Location, time and the rest of your world-level stats.',
        onChange: onApply
    }));

    container.append(buildSettingToggle({
        key: 'statusTracker.showNpcPortraits',
        label: 'Show Portraits',
        help: 'Each character\'s card image beside their name. Put {{portrait}} in your '
            + 'template to place it yourself.',
        onChange: onApply
    }));

    container.append(buildSettingSlider({
        key: 'statusTracker.summaryThreshold',
        label: 'Items Shown Per Collection',
        min: 1,
        max: 20,
        step: 1,
        help: 'How many items the status box lists before summarising the rest as '
            + '"+N more". Display only - the model is always told the whole collection, '
            + 'however this is set.',
        onChange: onApply
    }));


    /* -- How stats are read ------------------------------------------------ */

    section('How Stats Are Read');

    container.append(buildSettingSelect({
        key: 'statusTracker.extractionMode',
        label: 'Method',
        options: [
            { value: 'extract', label: 'A separate pass after each message' },
            { value: 'inline', label: 'Ask for a status block in the reply' },
        ],
        help: 'A separate pass keeps bookkeeping out of the story, so a character card '
            + 'that forbids numbers no longer fights the tracker. It costs one extra '
            + 'request per message.',
        onChange
    }));

    // Which of the two applies is the registry's answer, not a second copy of the same
    // condition. Only shown in the mode that sends it: the system rules used to sit under
    // "AI & Customization" in every mode, quietly collecting text that in extract mode
    // never reached a model at all.
    if (settings.extractionMode === 'extract') {
        container.appendChild(buildConnectionProfilePicker(onApply));
        container.append(buildPromptEditor(promptById('extraction'), { onChange: onApply }));
    } else {
        container.append(buildPromptEditor(promptById('systemRules'), { onChange: onApply }));
    }

    container.append(buildSettingSlider({
        key: 'statusTracker.extractionContextMessages',
        advanced: true,
        label: 'Messages Of Lead-Up',
        min: 0,
        max: 6,
        step: 1,
        help: 'How many earlier messages the reader sees. Needed when a cost is announced '
            + 'in one message and only paid once a roll succeeds two messages later.',
        onChange: onApply
    }));

    container.append(buildSettingSlider({
        key: 'statusTracker.extractionMaxTokens',
        advanced: true,
        label: 'Extraction Reply Budget',
        min: 300,
        max: 4000,
        step: 100,
        help: 'Raise this if updates come back truncated while tracking many stats.',
        onChange: onApply
    }));

    container.append(buildSettingToggle({
        key: 'statusTracker.extractionReasons',
        label: 'Ask Why A Value Changed',
        help: 'The reader explains each change in a clause, shown on the review rows - so '
            + 'a stat that moves for no reason you can see is told apart from one that '
            + 'moved for a good one. It is also asked not to change a value it cannot '
            + 'point at something for, which may cut the invented ones. Costs a few tokens '
            + 'per change; turn off if your extraction model struggles to return prose and '
            + 'clean JSON at once.',
        onChange: onApply
    }));

    container.append(buildSettingToggle({
        key: 'statusTracker.extractionUseSchema',
        advanced: true,
        label: 'Force JSON Schema',
        help: 'Sends a strict schema with the request. Leave off unless you know your '
            + 'backend handles it: some models answer with an empty object rather than '
            + 'refuse a schema they dislike, which loses the update silently.',
        onChange: onApply
    }));

    /* -- History scan ------------------------------------------------------ */

    section('History Scan');

    container.append(buildSettingToggle({
        key: 'statusTracker.scanButtonEnabled',
        label: 'Scan Button On The Send Bar',
        help: 'Reads the story so far and proposes what each character should be carrying '
            + 'and know. Useful when inventories have drifted, or when adopting the '
            + 'tracker part-way through a story.',
        onChange
    }));

    if (settings.scanButtonEnabled !== false) {
        container.append(buildSettingSelect({
            key: 'statusTracker.scanDepth',
            label: 'History To Read',
            options: [
                { value: 50, label: 'Recent - the last 50 messages' },
                { value: 200, label: 'Long - the last 200 messages' },
                { value: 0, label: 'Everything - the whole chat' },
            ],
            help: 'A story too big for one request is read in several passes rather than '
                + 'being cut short. The scan tells you how many messages and how many '
                + 'requests before it spends anything.',
            onChange: onApply
        }));

        container.appendChild(buildConnectionProfilePicker(onApply, {
            key: 'scanProfileId',
            labelText: 'Scan Connection',
            fallbackLabel: 'Same as the extraction connection',
            noteText: 'Reading a whole history is a harder job than a single message. A '
                + 'small model that handles updates well can still return nonsense here, '
                + 'and scans are rare enough to afford a better one.',
            unavailableText: 'Connection Manager is not available, so a scan uses the same '
                + 'connection as the extraction.',
        }));
    }

    container.append(buildSettingSlider({
        key: 'statusTracker.scanMaxTokens',
        advanced: true,
        label: 'Scan Reply Budget',
        min: 1000,
        max: 8000,
        step: 500,
        help: 'A scan lists whole inventories for several characters at once, so it needs '
            + 'more room than a single stat change.',
        onChange: onApply
    }));

    container.append(buildSettingSlider({
        key: 'statusTracker.scanCharBudget',
        advanced: true,
        label: 'Transcript Per Pass',
        min: 10000,
        max: 200000,
        step: 10000,
        help: 'How much text one pass carries. Smaller means more passes over the same '
            + 'story, not less of it read.',
        onChange: onApply
    }));

    container.append(buildSettingSlider({
        key: 'statusTracker.scanMaxChunks',
        advanced: true,
        label: 'Pass Limit',
        min: 0,
        max: 30,
        step: 1,
        help: '0 means as many passes as the history needs. Set a number to cap what one '
            + 'scan may cost, at the price of leaving older messages unread.',
        onChange: onApply
    }));

    /* -- Reviewing changes ------------------------------------------------- */

    section('Reviewing Changes');

    container.append(buildSettingSelect({
        key: 'statusTracker.reviewMode',
        label: 'Ask Before Applying',
        options: [
            { value: 'risky', label: 'Risky changes only' },
            { value: 'all', label: 'Every change' },
            { value: 'off', label: 'Nothing - apply everything' },
        ],
        help: 'An update replaces an inventory wholesale, so an item the AI forgets to '
            + 'mention would vanish. Gained and lost items, and implausible jumps, wait '
            + 'for you in a panel under the message instead. Ordinary movement still '
            + 'applies on its own, and Undo covers the rest.',
        onChange
    }));

    container.append(buildSettingSelect({
        key: 'statusTracker.maxChangePolicy',
        label: 'When A Maximum Moves',
        options: [
            { value: 'free', label: 'Apply it - level-ups vary by system' },
            { value: 'review-decreases', label: 'Ask before a maximum drops' },
            { value: 'review-all', label: 'Ask every time' },
        ],
        help: 'A ceiling rising is usually a level-up. A ceiling falling is almost never '
            + 'intended. Either way it is listed in the review panel, so it stays visible '
            + 'and undoable.',
        onChange: onApply
    }));

    container.append(buildSettingSlider({
        key: 'statusTracker.reviewSwingThreshold',
        advanced: true,
        label: 'Implausible Jump',
        min: 0.1,
        max: 1.0,
        step: 0.05,
        help: 'A value moving by more than this share of its range in one message waits '
            + 'for review. 1.0 turns the check off.',
        onChange: onApply
    }));

    /* -- Time rules -------------------------------------------------------- */

    container.appendChild(buildTimeRulesSection(onApply));

    /* -- Who is in the scene ----------------------------------------------- */

    section('Who Is In The Scene');

    container.append(buildSettingSelect({
        key: 'statusTracker.castMode',
        label: 'Decided By',
        options: [
            { value: 'speakers', label: 'Whoever appears in the message' },
            { value: 'ai', label: "The AI's character list" },
        ],
        help: 'Detecting speakers is reliable and catches characters with no card. '
            + 'Relying on the AI to keep an exact list means a scene change can leave the '
            + 'previous cast behind.',
        onChange
    }));

    if (settings.castMode === 'speakers') {
        container.append(buildSettingSlider({
            key: 'statusTracker.castGraceMessages',
            label: 'Messages Before Leaving',
            min: 0,
            max: 10,
            step: 1,
            help: 'How long a character may go unmentioned before leaving the scene. '
                + 'Higher suits slow conversations; 0 removes anyone who did not appear '
                + 'in the latest message.',
            onChange: onApply
        }));
    }

    if (settings.castMode === 'ai') {
        container.append(buildSettingSelect({
            key: 'statusTracker.sceneBindingStat',
            advanced: true,
            label: 'Scene Binding Stat',
            options: [
                { value: '', label: 'None' },
                ...(settings.globalStats || []).map(stat => ({ value: stat.name, label: stat.name }))
            ],
            help: 'When this world stat changes, characters the AI did not mention are removed '
                + 'from the scene. Only used when the cast comes from the AI\'s list.',
            onChange: onApply
        }));
    }

    /* -- Chat size --------------------------------------------------------- */

    container.appendChild(buildContextReport(onChange));

    /* -- If something goes wrong ------------------------------------------- */

    section('If Something Goes Wrong');

    container.append(buildSettingSlider({
        key: 'statusTracker.systemAutoSaveMinutes',
        advanced: true,
        label: 'Save System State Every',
        min: 0, max: 120, step: 5, suffix: ' min',
        help: "0 turns it off. A system's stored copy is otherwise only rewritten when you "
            + 'switch away from it, so a system you never leave keeps whatever it held the '
            + 'last time you did. Saving on a timer keeps something recent to fall back to. '
            + 'A save that would be identical to the last one is skipped.',
        onChange: () => { onApply(); applyCheckpointSchedule(); },
    }));

    container.append(buildSettingSlider({
        key: 'statusTracker.systemCheckpointsKept',
        advanced: true,
        label: 'Saved States Kept',
        min: 1, max: 20, step: 1,
        help: 'Per system. Each holds a full copy of that system - its characters, item '
            + 'library, persona records and settings - so a large world costs real space in '
            + 'your settings file. Restore them from the System Manager.',
        onChange: onApply,
    }));

    container.append(buildSettingSlider({
        key: 'statusTracker.historyDepth',
        advanced: true,
        label: 'Undo Steps Kept',
        min: 1,
        max: 50,
        step: 1,
        help: 'Each step stores a copy of the tracker state in the chat file, so large '
            + 'values grow the chat.',
        onChange: onApply
    }));

    /* -- Buttons ----------------------------------------------------------- */

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '10px';
    btnRow.style.marginTop = '20px';
    btnRow.style.flexWrap = 'wrap';

    const dashBtn = document.createElement('button');
    dashBtn.type = 'button';
    dashBtn.className = 'menu_button';
    dashBtn.style.flex = '1';
    dashBtn.innerHTML = '<i class="fa-solid fa-gauge-high"></i> Open Session Dashboard';
    dashBtn.addEventListener('click', () => openDashboardPopup());

    const advBtn = document.createElement('button');
    advBtn.type = 'button';
    advBtn.className = 'menu_button';
    advBtn.style.flex = '1';
    advBtn.innerHTML = '<i class="fa-solid fa-code"></i> HTML & CSS Template';
    advBtn.addEventListener('click', () => openAdvancedSettingsPopup());

    btnRow.append(dashBtn, advBtn);
    container.appendChild(btnRow);

}

/**
 * Where the tracker box goes.
 *
 * Two settings used to ask this: a toggle for whether older messages get one, and a
 * select for above or below. They were always answered together and never made sense
 * apart, so they are one question with four answers.
 */
function buildPlacementPicker(settings, onApply) {
    const KEY = 'sillynpc-placement';
    const value = (settings.showOnlyAtBottom === false ? 'every-' : 'last-')
        + (settings.renderPosition === 'top' ? 'top' : 'bottom');

    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-setting';

    const row = document.createElement('div');
    row.className = 'sillynpc-setting-row';
    const label = document.createElement('label');
    label.className = 'sillynpc-setting-label';
    label.textContent = 'Where To Show It';

    const select = document.createElement('select');
    select.className = 'text_pole';
    select.id = KEY;
    for (const [v, text] of [
        ['last-bottom', 'Below the last message'],
        ['last-top', 'Above the last message'],
        ['every-bottom', 'Below every message'],
        ['every-top', 'Above every message'],
    ]) {
        const option = document.createElement('option');
        option.value = v;
        option.textContent = text;
        option.selected = v === value;
        select.appendChild(option);
    }
    select.addEventListener('change', () => {
        const st = getSettings().statusTracker;
        st.showOnlyAtBottom = select.value.startsWith('last-');
        st.renderPosition = select.value.endsWith('top') ? 'top' : 'bottom';
        onApply();
    });

    row.append(label, select);
    wrap.appendChild(row);

    const help = document.createElement('small');
    help.className = 'notes';
    help.style.cssText = 'margin-top:4px; display:block;';
    help.textContent = 'Under every message, each one shows the values as they stood at '
        + 'that point in the story rather than today’s.';
    wrap.appendChild(help);

    return wrap;
}


/**
 * Shows how much of the current chat is tracker data, and offers to remove it.
 *
 * The extension used to hide its status blocks in the DOM but leave them in the stored
 * message, so they were re-sent on every later turn. On a real 317-message chat that came
 * to 71% of the entire transcript. New messages are cleaned automatically; this recovers
 * what earlier ones left behind.
 */
function buildContextReport(onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-setting';

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.style.marginTop = '20px';
    title.textContent = 'Chat Size';
    wrap.appendChild(title);

    const body = document.createElement('div');
    wrap.appendChild(body);

    const render = () => {
        body.replaceChildren();

        let stats;
        try {
            stats = measureChatOverhead();
        } catch {
            const note = document.createElement('small');
            note.className = 'notes';
            note.textContent = 'No chat is open.';
            body.appendChild(note);
            return;
        }

        const totalTokens = estimateTokens(stats.totalChars);
        const blockTokens = estimateTokens(stats.blockChars);
        const share = stats.totalChars ? (stats.blockChars / stats.totalChars * 100) : 0;

        const summary = document.createElement('small');
        summary.className = 'notes';
        summary.style.display = 'block';
        summary.style.marginBottom = '8px';
        summary.textContent = `${stats.messages} messages, roughly ${totalTokens.toLocaleString()} tokens. `
            + (stats.blockMessages
                ? `${stats.blockMessages} of them still carry tracker data: about ${blockTokens.toLocaleString()} tokens (${share.toFixed(1)}%), re-sent on every turn.`
                : 'No leftover tracker data - nothing is being re-sent.');
        body.appendChild(summary);

        if (!stats.blockMessages) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button';
        button.innerHTML = '<i class="fa-solid fa-broom"></i> Remove tracker data from this chat';
        button.addEventListener('click', async () => {
            const ok = await Popup.show.confirm(
                'Clean this chat?',
                `This removes the tracker's own JSON from ${stats.blockMessages} message(s), `
                + `recovering roughly ${blockTokens.toLocaleString()} tokens on every future request. `
                + 'The story text is untouched, and the removed data is kept hidden on each '
                + 'message so it can still be re-applied. Back up the chat first if you are unsure.');
            if (!ok) return;

            const result = cleanChatHistory();
            toastr.success(
                `Cleaned ${result.cleaned} message(s), recovering about `
                + `${estimateTokens(result.removedChars).toLocaleString()} tokens.`,
                'SillyNPC');
            render();
            onChange?.();
        });
        body.appendChild(button);
    };

    render();
    return wrap;
}

/**
 * Connection Profile picker for the extraction request.
 *
 * Connection Manager is an extension and can be disabled, in which case
 * getSupportedProfiles() throws - so this degrades to an explanatory note rather than
 * breaking the settings panel. An empty selection means "use the main API".
 */
/**
 * The Time Rules section.
 *
 * What elapsed time does on its own - Energy recovering while the party rests, a torch
 * burning down, hunger climbing. The extension computes these from the clock the
 * narrator already writes, so they are exact and cost nothing; the model is never asked
 * to do the arithmetic.
 */
function buildTimeRulesSection(onChange) {
    const settings = getSettings().statusTracker;
    const section = document.createElement('div');

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.style.marginTop = '20px';
    title.textContent = 'Time Rules';
    section.appendChild(title);

    const note = document.createElement('small');
    note.className = 'notes';
    note.style.cssText = 'display:block; margin-bottom:10px;';
    note.textContent = 'What the passing of time changes on its own. Worked out from the '
        + 'clock in your world stats, so the result is exact and identical on a re-roll. '
        + 'These apply without asking, and appear in the message’s change record like '
        + 'anything else, so you can see and undo them.';
    section.appendChild(note);

    const globalNames = (settings.globalStats || []).map(s => s.name).filter(Boolean);
    section.append(buildSettingSelect({
        key: 'statusTracker.clockStat',
        label: 'Clock',
        options: globalNames.length
            ? globalNames.map(n => ({ value: n, label: n }))
            : [{ value: 'Time', label: 'Time' }],
        help: 'Which world stat holds the time. Values like "14 January 2012, 05:30 AM", '
            + '"Day 3, 14:20" or "06:15" are read; anything vaguer, such as "Morning", '
            + 'simply means no measurable time passed and nothing is applied.',
        onChange
    }));

    section.append(buildSettingSlider({
        key: 'statusTracker.clockMaxElapsedMinutes',
        advanced: true,
        label: 'Maximum Time Per Message',
        suffix: ' min',
        min: 60,
        max: 10080,
        step: 60,
        help: 'Ceiling in minutes on what a single message can be worth. A mistyped year '
            + 'or a sudden time skip would otherwise refill or drain everything at once. '
            + 'The default of 1440 is a full day; when the limit bites it is named in the '
            + 'change record rather than hidden.',
        onChange
    }));

    const list = document.createElement('div');
    list.className = 'sillynpc-time-rules';
    section.appendChild(list);

    const redraw = () => {
        list.innerHTML = '';
        const rules = settings.timeRules || [];
        if (!rules.length) {
            const empty = document.createElement('p');
            empty.className = 'notes';
            empty.style.opacity = '0.6';
            empty.textContent = 'No time rules yet.';
            list.appendChild(empty);
        }
        rules.forEach((rule, index) => list.appendChild(buildTimeRuleRow(rule, index, redraw, onChange)));
    };
    redraw();

    const addWrap = document.createElement('div');
    addWrap.className = 'sillynpc-setting';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'menu_button';
    add.innerHTML = '<i class="fa-solid fa-plus"></i> Add Time Rule';
    add.addEventListener('click', () => {
        if (!Array.isArray(settings.timeRules)) settings.timeRules = [];
        settings.timeRules.push({
            id: `rule-${Date.now().toString(36)}`,
            enabled: true,
            scope: 'player',
            stat: (settings.playerStats || [])[0]?.name || '',
            amount: 1,
            perMinutes: 60,
            conditionStat: '',
            conditionValue: '',
        });
        saveSettings();
        redraw();
        onChange?.();
    });
    addWrap.appendChild(add);
    section.appendChild(addWrap);

    return section;
}

/** Which stat list a rule's scope draws from. */
function statNamesForScope(scope) {
    const settings = getSettings().statusTracker;
    const list = scope === 'global' ? settings.globalStats
        : scope === 'characters' ? settings.npcStats
            : settings.playerStats;
    return (list || []).map(s => s.name).filter(Boolean);
}

function buildTimeRuleRow(rule, index, redraw, onChange) {
    const settings = getSettings().statusTracker;
    const row = document.createElement('div');
    row.className = 'sillynpc-time-rule';

    const commit = () => { saveSettings(); onChange?.(); };

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = rule.enabled !== false;
    enabled.title = 'Apply this rule';
    enabled.addEventListener('change', () => { rule.enabled = enabled.checked; commit(); });

    const scope = document.createElement('select');
    scope.className = 'text_pole';
    for (const [value, label] of [['player', 'Player'], ['characters', 'Characters'], ['global', 'World']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.selected = (rule.scope || 'player') === value;
        scope.appendChild(option);
    }
    scope.title = 'Who the rule applies to. Characters means everyone currently in the scene.';
    scope.addEventListener('change', () => {
        rule.scope = scope.value;
        // The old stat almost certainly does not exist on the new scope's list.
        rule.stat = statNamesForScope(rule.scope)[0] || '';
        commit();
        redraw();
    });

    const stat = document.createElement('select');
    stat.className = 'text_pole';
    const names = statNamesForScope(rule.scope || 'player');
    for (const name of names) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        option.selected = rule.stat === name;
        stat.appendChild(option);
    }
    if (!names.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '(no stats configured)';
        stat.appendChild(option);
    }
    stat.addEventListener('change', () => { rule.stat = stat.value; commit(); });

    const amount = document.createElement('input');
    amount.type = 'number';
    amount.className = 'text_pole';
    amount.style.width = '70px';
    amount.value = rule.amount ?? 1;
    amount.title = 'How much each interval is worth. A negative number drains instead, '
        + 'which is how hunger, fatigue or a burning torch are written.';
    amount.addEventListener('input', () => { rule.amount = Number(amount.value); commit(); });

    const per = document.createElement('input');
    per.type = 'number';
    per.className = 'text_pole';
    per.style.width = '80px';
    per.min = '1';
    per.value = rule.perMinutes ?? 60;
    per.title = 'The interval, in minutes. Time left over is carried, so a rule set to '
        + 'every 10 minutes is not lost by messages that only advance the clock by seven.';
    per.addEventListener('input', () => { rule.perMinutes = Number(per.value); commit(); });

    const conditionStat = document.createElement('input');
    conditionStat.type = 'text';
    conditionStat.className = 'text_pole';
    conditionStat.style.width = '120px';
    conditionStat.placeholder = 'always';
    conditionStat.value = rule.conditionStat || '';
    conditionStat.title = 'Optional gate. Name a stat - the character’s own, or a world '
        + 'stat - and the rule only applies while it matches the value beside it. Leave '
        + 'empty for a rule that always applies.';
    conditionStat.addEventListener('input', () => { rule.conditionStat = conditionStat.value; commit(); });

    const conditionValue = document.createElement('input');
    conditionValue.type = 'text';
    conditionValue.className = 'text_pole';
    conditionValue.style.width = '120px';
    conditionValue.placeholder = 'value';
    conditionValue.value = rule.conditionValue || '';
    conditionValue.title = 'Matched loosely: "Resting" also matches "Resting (light sleep)", '
        + 'and case is ignored.';
    conditionValue.addEventListener('input', () => { rule.conditionValue = conditionValue.value; commit(); });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'menu_button delete-btn';
    remove.innerHTML = '<i class="fa-solid fa-trash"></i>';
    remove.title = 'Delete this rule';
    remove.addEventListener('click', () => {
        settings.timeRules.splice(index, 1);
        commit();
        redraw();
    });

    const label = (text) => {
        const el = document.createElement('small');
        el.className = 'sillynpc-time-rule-label';
        el.textContent = text;
        return el;
    };

    row.append(enabled, scope, stat, label('by'), amount, label('every'), per,
        label('min, while'), conditionStat, label('is'), conditionValue, remove);
    return row;
}

/**
 * Which settings object a connection picker works on.
 *
 * The connection settings do not all live together: the tracker's are under
 * statusTracker, lore writing's is at the root beside the prompt it belongs to.
 */

async function openAdvancedSettingsPopup() {
    const container = document.createElement('div');
    container.className = 'sillynpc sillynpc-manage'; // Use manage class for theme background
    container.style.padding = '20px';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '20px';
    container.style.height = '100%';

    const templateField = buildSettingTextArea({ 
        key: 'statusTracker.template', 
        label: 'HTML Template', 
        help: 'Use {{StatName}} for global stats and {{#characters}}...{{/characters}} for characters.' 
    });
    container.append(templateField);

    // A label typed into the template cannot follow the field it names, so this offers to
    // take it out and let the field's own Format supply one instead.
    const tidyBtn = document.createElement('button');
    tidyBtn.type = 'button';
    tidyBtn.className = 'menu_button sillynpc-tidy-labels-btn';
    tidyBtn.innerHTML = '<i class="fa-solid fa-broom"></i> <span>Tidy labels</span>';
    tidyBtn.title = 'Find words written beside a field reference, like "HP [{{Health}}]", '
        + 'and offer to remove them so the label comes from the field.';
    tidyBtn.addEventListener('click', () => tidyTemplateLabels(() => {
        // The box on screen is still showing the text as it was a moment ago, and typing
        // into it afterwards would write the stale copy straight back.
        const box = templateField.querySelector('textarea');
        if (box) box.value = getSettings().statusTracker.template;
        triggerReprocess();
    }));
    container.append(tidyBtn);

    // A template written when references were placements has leftovers no cleanup makes
    // pretty. Replacing it is more predictable than surgery, and the old text is kept.
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'menu_button sillynpc-reset-layout-btn';
    resetBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> <span>Reset layout</span>';
    resetBtn.title = 'Replace the template with the default one, which holds the structure '
        + 'and lets your fields decide the rest. Your current template is kept.';
    resetBtn.addEventListener('click', async () => {
        const tracker = getSettings().statusTracker;
        const ok = await Popup.show.confirm('Reset the layout',
            'The template goes back to the default: the box structure, with your fields '
            + 'filling it in the order the builder lists them. Your current template is '
            + 'kept and can be pasted back from the backup.');
        if (!ok) return;

        tracker.templateBackup = tracker.template;
        tracker.template = defaultSettings.statusTracker.template;
        saveSettings();
        const box = templateField.querySelector('textarea');
        if (box) box.value = tracker.template;
        triggerReprocess();
        toastr.success('Layout reset. Your old template is kept as a backup.', 'SillyNPC');
    });
    container.append(resetBtn);

    container.append(buildSettingTextArea({ 
        key: 'statusTracker.customCSS', 
        label: 'Custom CSS', 
        help: 'Additional styles for your status box.' 
    }));

    const settings = getSettings();
    const isMobile = window.innerWidth <= 768;
    const width = isMobile ? 95 : (settings.popupWidth ?? 80);
    const height = isMobile ? 90 : (settings.popupHeight ?? 80);
    const visualContent = container;
    const popup = new Popup(container, POPUP_TYPE.DISPLAY, '', { 
        allowVerticalScrolling: true,
        onOpen: (p) => {
            if (p.dlg) {
                p.dlg.style.setProperty('width', `${width}vw`, 'important');
                p.dlg.style.setProperty('max-width', '98vw', 'important');
                p.dlg.style.setProperty('height', `${height}vh`, 'important');
                p.dlg.style.setProperty('max-height', '98vh', 'important');
                if (isMobile) p.dlg.style.setProperty('margin', '2vh auto', 'important');
            }
            updateExtensionTheme(container, p);
            repositionCloseButton(p, visualContent);
        }
    
    });
    await popup.show();
}

async function openDashboardPopup() {
    const container = document.createElement('div');
    container.className = 'sillynpc sillynpc-manage';
    container.style.padding = '20px';
    container.style.height = '100%';
    
    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = 'Current Session Status (Manual Override)';
    container.appendChild(title);
    
    const dashboardContainer = document.createElement('div');
    dashboardContainer.appendChild(buildStatusDashboard());
    container.appendChild(dashboardContainer);
    
    const settings = getSettings();
    const isMobile = window.innerWidth <= 768;
    const width = isMobile ? 95 : (settings.popupWidth ?? 80);
    const height = isMobile ? 90 : (settings.popupHeight ?? 80);
    const visualContent = container;
    const popup = new Popup(container, POPUP_TYPE.DISPLAY, '', { 
        allowVerticalScrolling: true,
        onOpen: (p) => {
            if (p.dlg) {
                p.dlg.style.setProperty('width', `${width}vw`, 'important');
                p.dlg.style.setProperty('max-width', '98vw', 'important');
                p.dlg.style.setProperty('height', `${height}vh`, 'important');
                p.dlg.style.setProperty('max-height', '98vh', 'important');
                if (isMobile) p.dlg.style.setProperty('margin', '2vh auto', 'important');
            }
            updateExtensionTheme(container, p);
            repositionCloseButton(p, visualContent);
        }
    });
    await popup.show();
}

function buildStatusDashboard() {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-status-dashboard';
    wrap.style.padding = '10px';
    wrap.style.background = 'var(--sillynpc-bg-secondary)';
    wrap.style.borderRadius = '8px';
    
    const state = loadStateFromMetadata();
    const settings = getSettings().statusTracker;
    
    const globalSection = document.createElement('div');
    globalSection.innerHTML = '<strong>Global Stats</strong>';
    settings.globalStats.forEach(stat => {
        const key = stat.name;
        const value = state.global[key] || stat.defaultValue || '';
        const row = document.createElement('div');
        row.className = 'sillynpc-setting-row';
        row.style.margin = '5px 0';
        row.innerHTML = `<span style="width:100px; display:inline-block">${escapeHtml(key)}:</span> <input type="text" class="text_pole" style="width:200px" value="${escapeHtml(value)}">`;
        row.querySelector('input').addEventListener('blur', (e) => {
            state.global[key] = e.target.value;
            saveStateToMetadata(state, { label: 'Manual edit' });
            eventSource.emit('sillynpc-status-updated', state);
        });
        globalSection.appendChild(row);
    });

    const playerSection = document.createElement('div');
    playerSection.style.marginTop = '15px';
    playerSection.innerHTML = '<strong>Player Stats</strong>';
    settings.playerStats.forEach(stat => {
        const key = stat.name;
        const value = state.player.stats[key] || stat.defaultValue || '';
        const row = document.createElement('div');
        row.className = 'sillynpc-setting-row';
        row.style.margin = '5px 0';
        row.innerHTML = `<span style="width:100px; display:inline-block">${escapeHtml(key)}:</span> <input type="text" class="text_pole" style="width:200px" value="${escapeHtml(value)}">`;
        row.querySelector('input').addEventListener('blur', (e) => {
            state.player.stats[key] = e.target.value;
            saveStateToMetadata(state, { label: 'Manual edit' });
            syncPlayerToMaster(state, { authoritative: true });
            eventSource.emit('sillynpc-status-updated', state);
        });
        playerSection.appendChild(row);
    });
    
    const charSection = document.createElement('div');
    charSection.style.marginTop = '15px';
    charSection.innerHTML = '<strong>Characters</strong>';
    state.characters.forEach((char, charIdx) => {
        const charWrap = document.createElement('div');
        charWrap.style.marginBottom = '10px';
        charWrap.style.padding = '5px';
        charWrap.style.border = '1px solid var(--sillynpc-border)';
        charWrap.innerHTML = `<div><strong>${escapeHtml(char.name)}</strong></div>`;
        
        settings.npcStats.forEach(stat => {
            const key = stat.name;
            const value = char.stats[key] || stat.defaultValue || '';
            const row = document.createElement('div');
            row.className = 'sillynpc-setting-row';
            row.style.margin = '2px 0';
            row.innerHTML = `<span style="width:100px; display:inline-block">${escapeHtml(key)}:</span> <input type="text" class="text_pole" style="width:150px" value="${escapeHtml(value)}">`;
            row.querySelector('input').addEventListener('blur', (e) => {
                char.stats[key] = e.target.value;
                saveStateToMetadata(state, { label: 'Manual edit' });
                eventSource.emit('sillynpc-status-updated', state);
            });
            charWrap.appendChild(row);
        });
        charSection.appendChild(charWrap);
    });

    const historySection = document.createElement('div');
    historySection.style.marginTop = '15px';
    historySection.innerHTML = '<strong>Undo History</strong>';
    const entries = getHistoryEntries();
    if (entries.length === 0) {
        const none = document.createElement('div');
        none.className = 'notes';
        none.style.opacity = '0.6';
        none.textContent = 'No changes recorded yet in this chat.';
        historySection.appendChild(none);
    } else {
        // Newest first reads better, but restoreHistoryEntry indexes the raw array.
        entries.slice().reverse().forEach((entry, revIdx) => {
            const index = entries.length - 1 - revIdx;
            const row = document.createElement('div');
            row.className = 'sillynpc-setting-row';
            row.style.margin = '4px 0';
            row.style.gap = '10px';

            const when = new Date(entry.timestamp);
            const label = document.createElement('span');
            label.style.flex = '1';
            label.textContent = `${entry.label} - ${when.toLocaleTimeString()}`;

            const where = document.createElement('small');
            where.style.opacity = '0.6';
            const loc = entry.state?.global ? Object.values(entry.state.global)[0] : '';
            where.textContent = loc ? String(loc) : '';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'menu_button';
            btn.textContent = 'Restore';
            btn.title = 'Return to this point, discarding everything after it';
            btn.addEventListener('click', async () => {
                const ok = await Popup.show.confirm('Restore this point?',
                    `Everything recorded after "${entry.label}" will be discarded.`);
                if (!ok) return;
                restoreHistoryEntry(index);
                const dashRoot = wrap.parentElement;
                dashRoot.replaceChildren();
                dashRoot.appendChild(buildStatusDashboard());
            });

            row.append(label, where, btn);
            historySection.appendChild(row);
        });
    }

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'menu_button';
    refreshBtn.style.marginTop = '10px';
    refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> Reload from Metadata';
    refreshBtn.addEventListener('click', () => {
        const dashRoot = wrap.parentElement;
        dashRoot.replaceChildren();
        dashRoot.appendChild(buildStatusDashboard());
    });
    
    wrap.append(globalSection, playerSection, charSection, historySection, refreshBtn);
    return wrap;
}
