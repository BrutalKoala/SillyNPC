import { getSettings } from './settings.js';
import { USAGE_KINDS, averageFor, resetUsage } from './usage.js';
import { countTokens } from './tokens.js';
import { PROMPTS } from './prompts.js';
import { estimateTokens } from './status-history.js';
import { SCAN_SYSTEM_PROMPT } from './history-scan.js';
import { FILL_SYSTEM_PROMPT, PROFILE_SYSTEM_PROMPT } from './character-fill.js';
import { BAN_SCAN_SYSTEM_PROMPT } from './banlist.js';
import { getContext } from '../../../../st-context.js';
import { SYSTEM_PROMPT } from './constants.js';
import { Popup } from '../../../../popup.js';

/** The text a generator sends every time, whatever the message. */
function fixedPromptFor(kindId) {
    const settings = getSettings();
    const tracker = settings.statusTracker;
    const byKey = (key) => PROMPTS.find(p => p.key === key);

    if (kindId === 'extraction') return tracker.extractionPrompt || SYSTEM_PROMPT;
    if (kindId === 'scan') return SCAN_SYSTEM_PROMPT;
    // Two prompts share this counter - the profile fill and the stat fill are separate
    // requests recorded under one kind. The card states a ceiling, so it is the longer of
    // the two: naming one of them would under-report every run of the other.
    if (kindId === 'fill') {
        return PROFILE_SYSTEM_PROMPT.length > FILL_SYSTEM_PROMPT.length
            ? PROFILE_SYSTEM_PROMPT
            : FILL_SYSTEM_PROMPT;
    }
    if (kindId === 'banscan') return BAN_SCAN_SYSTEM_PROMPT;
    if (kindId === 'lore') return settings.generationPrompt || byKey('generationPrompt').recommended();
    if (kindId === 'image') {
        const template = settings.imgGenPrompt || byKey('imgGenPrompt').recommended();
        const negative = settings.imageBackend === 'gemini' ? '' : (settings.imgGenNegativePrompt || '');
        return `${template} ${negative}`;
    }
    return '';
}

/** The reply budget a generator is allowed, or 0 where a reply is not text. */
function replyBudgetFor(kindId) {
    const settings = getSettings();
    const tracker = settings.statusTracker;
    if (kindId === 'extraction') return Number(tracker.extractionMaxTokens) || 1200;
    if (kindId === 'scan') return Number(tracker.scanMaxTokens) || 3000;
    if (kindId === 'fill') return Number(tracker.extractionMaxTokens) || 1200;
    if (kindId === 'banscan') return Number(tracker.extractionMaxTokens) || 1200;
    if (kindId === 'lore') return Number(settings.loreMaxTokens) || 1200;
    return 0;
}

/**
 * How much narration a ban scan would send if it ran now.
 *
 * The same slice scanForBanCandidates takes: only what the model wrote, only the last
 * banScanDepth of those. Zero with no chat open, which reads correctly on the card -
 * there is nothing to scan.
 */
function banScanChars() {
    const chat = getContext()?.chat || [];
    const depth = Number(getSettings().banScanDepth) || 50;
    const written = chat.filter(m => !m?.is_user && String(m?.mes ?? '').trim());
    const recent = depth > 0 ? written.slice(-depth) : written;
    return recent.reduce((sum, m) => sum + String(m.mes).length, 0);
}

/**
 * What one run can cost at most.
 *
 * The parts are shown rather than only the sum, because the sum on its own does not say
 * which setting to change. A ceiling that is mostly reply budget and one that is mostly
 * transcript are the same number and want opposite fixes.
 *
 * @returns {Promise<{ total: number, parts: Array<{ label: string, tokens: number }> }>}
 */
export async function ceilingFor(kindId) {
    const parts = [];

    const fixed = (await countTokens(fixedPromptFor(kindId))).count;
    parts.push({ label: kindId === 'image' ? 'prompt template' : 'instructions', tokens: fixed });

    if (kindId === 'scan') {
        // A pass carries this much story text, and that is the bulk of what a scan pays
        // for - counted from the character budget rather than measured, since the
        // transcript is different every time.
        const perPass = Number(getSettings().statusTracker.scanCharBudget) || 30000;
        parts.push({ label: 'transcript per pass', tokens: estimateTokens(perPass) });
    }

    if (kindId === 'banscan') {
        // Unlike the history scan there is no character budget to read the size off:
        // it takes a count of messages, whatever length they happen to be. So this is
        // measured from the chat that is open - what a scan started now would send,
        // rather than a number invented for the card.
        parts.push({ label: 'narration read', tokens: estimateTokens(banScanChars()) });
    }

    const budget = replyBudgetFor(kindId);
    if (budget) parts.push({ label: 'reply budget', tokens: budget });

    return { total: parts.reduce((sum, p) => sum + p.tokens, 0), parts };
}

function describeWhen(when) {
    if (!when) return 'never';
    const minutes = Math.round((Date.now() - when) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    return new Date(when).toLocaleDateString();
}

function row(label, value) {
    const line = document.createElement('div');
    line.className = 'sillynpc-stat-row';

    const name = document.createElement('span');
    name.className = 'sillynpc-stat-name';
    name.textContent = label;

    const amount = document.createElement('span');
    amount.className = 'sillynpc-stat-value';
    amount.textContent = value;

    line.append(name, amount);
    return line;
}

function buildKindCard(kind) {
    const card = document.createElement('div');
    card.className = 'sillynpc-stat-card';

    const heading = document.createElement('h4');
    heading.className = 'sillynpc-stat-title';
    heading.textContent = kind.label;
    card.append(heading);

    const note = document.createElement('small');
    note.className = 'notes';
    note.textContent = kind.note;
    card.append(note);

    const ceiling = row('Most one run can cost', 'counting...');
    card.append(ceiling);

    ceilingFor(kind.id).then(({ total, parts }) => {
        const breakdown = parts.map(p => `${p.tokens.toLocaleString()} ${p.label}`).join(' + ');
        ceiling.querySelector('.sillynpc-stat-value').textContent =
            `${total.toLocaleString()} tokens  (${breakdown})`;
    }).catch(() => {
        ceiling.querySelector('.sillynpc-stat-value').textContent = 'unavailable';
    });

    const measured = averageFor(kind.id);
    if (!measured) {
        // Counting began when this was built, so an empty counter is not the same claim
        // as "you have never used this".
        card.append(row('Used', 'not since counting started'));
        return card;
    }

    card.append(row('Times used', measured.runs.toLocaleString()));
    card.append(row('Average per run', kind.sends === 'text'
        ? `${measured.total.toLocaleString()} tokens  (${measured.prompt.toLocaleString()} sent, ${measured.reply.toLocaleString()} back)`
        : `${measured.prompt.toLocaleString()} tokens sent`));
    card.append(row('Last run', `${describeWhen(measured.lastWhen)}, ${measured.lastTotal.toLocaleString()} tokens`));

    return card;
}

/**
 * The Stats tab.
 *
 * @param {HTMLElement} view
 */
export function renderStatsView(view) {
    if (!view) return;
    view.replaceChildren();

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = 'Stats';
    view.append(title);

    const intro = document.createElement('small');
    intro.className = 'notes';
    intro.textContent = 'What each generator can cost at most, and what yours has actually '
        + 'cost. Counting started when this was added, so anything done before that is not '
        + 'in these numbers.';
    view.append(intro);

    const cards = document.createElement('div');
    cards.className = 'sillynpc-stat-cards';
    for (const kind of USAGE_KINDS) cards.append(buildKindCard(kind));
    view.append(cards);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'menu_button';
    reset.innerHTML = '<i class="fa-solid fa-arrow-rotate-left"></i> <span>Start counting again</span>';
    reset.addEventListener('click', async () => {
        const ok = await Popup.show.confirm('Start counting again',
            'The run counts and averages go back to zero. Your prompts and settings are untouched.');
        if (!ok) return;
        resetUsage();
        renderStatsView(view);
    });
    view.append(reset);
}
