import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles, main_api } from '../../../../../script.js';
import { textgenerationwebui_settings } from '../../../../textgen-settings.js';
import { getContext } from '../../../../st-context.js';
import { getSettings, saveSettings } from './settings.js';
import { requestExtraction, coerceToUpdate } from './status-extractor.js';
import { normaliseSpeakerLabel } from './speaker-labels.js';
import { debugLog } from './constants.js';

/**
 * Phrases the model leans on, stopped rather than asked about.
 *
 * SillyTavern already has a real mechanism for this and it is not a prompt: a text
 * completion backend is sent `banned_strings`, and the sampler cannot emit them. The other
 * extension that ships a "ban list" does not use it - it writes the phrases into the prompt
 * as an instruction, every turn, at that cost, and a model that was going to lean on a
 * phrase is exactly the model that ignores being asked not to.
 *
 * HOW THE REAL BAN IS REACHED, because it is not obvious:
 *
 *   `{{banned "phrase"}}` is a SillyTavern macro. Expanding it pushes the phrase onto
 *   `textgenerationwebui_banned_in_macros` and renders to an empty string.
 *   `getExtensionPrompt` runs `substituteParams` over what it returns, so a macro carried
 *   in an extension prompt is expanded like any other - and getCustomTokenBans reads that
 *   array when it builds the request, then clears it.
 *
 * So the carrier is invisible, costs nothing, never touches the user's own banned-tokens
 * setting, and cannot accumulate. It goes at IN_PROMPT rather than IN_CHAT because that is
 * the position whose text is definitely substituted; where it sits does not matter when
 * the text is empty by the time anyone sees it.
 */

/** The key SillyTavern files the carrier under. */
export const BANLIST_KEY = 'sillynpc-banlist';

/** Phrases that have been approved. Anything proposed and not ticked is not here. */
export function bannedPhrases() {
    const list = getSettings().banList;
    return Array.isArray(list) ? list.map(p => String(p ?? '').trim()).filter(Boolean) : [];
}

/**
 * Whether a real ban can be sent, and if not, why.
 *
 * Two conditions, and both are somebody else's switch, so neither may fail quietly - a
 * ban list that is silently doing nothing is worse than no ban list, because you stop
 * looking for the phrase.
 *
 * @returns {{ mode: 'sampler'|'prompt', reason: string }}
 */
export function banMode() {
    if (main_api !== 'textgenerationwebui') {
        return {
            mode: 'prompt',
            reason: 'This API takes no banned strings, so the phrases are asked for in the '
                + 'prompt instead. That is a request, not a ban, and models do ignore it.',
        };
    }
    if (!textgenerationwebui_settings?.send_banned_tokens) {
        return {
            mode: 'prompt',
            reason: 'Ban Tokens is switched off in SillyTavern\'s sampler settings, so a real '
                + 'ban would be dropped. Turn it on there and this becomes a ban; until then '
                + 'the phrases are asked for in the prompt.',
        };
    }
    return { mode: 'sampler', reason: 'Sent to the sampler. The model cannot emit these.' };
}

/**
 * The carrier: one macro per phrase, which expands to nothing.
 *
 * Quotes inside a phrase would close the macro's own argument early and leave the rest of
 * it in the prompt as visible text, so a phrase carrying one is dropped rather than half
 * banned. Rare enough to be worth the simplicity of not escaping it.
 */
export function buildBanMacros(phrases) {
    return phrases
        .filter(phrase => !phrase.includes('"'))
        .map(phrase => `{{banned "${phrase}"}}`)
        .join('');
}

/** What is asked for when the sampler cannot be told. */
export function buildBanInstruction(phrases) {
    if (!phrases.length) return '';
    return [
        '### PHRASES TO AVOID',
        'Do not use these words or phrases, or close variations of them:',
        ...phrases.map(phrase => `- ${phrase}`),
    ].join('\n');
}

/** Puts the ban in front of the model, whichever kind it can be, or takes it away. */
export function applyBanList() {
    const settings = getSettings();
    const phrases = bannedPhrases();
    const off = !settings.enabled || !settings.banListEnabled || phrases.length === 0;

    const clear = () => {
        setExtensionPrompt(BANLIST_KEY, '', extension_prompt_types.IN_PROMPT, 0, false);
    };

    if (off) {
        clear();
        return;
    }

    const { mode } = banMode();
    const text = mode === 'sampler'
        ? buildBanMacros(phrases)
        : buildBanInstruction(phrases);

    setExtensionPrompt(
        BANLIST_KEY,
        text,
        extension_prompt_types.IN_PROMPT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
    debugLog(`Ban list sent as ${mode}: ${phrases.length} phrase(s)`);
}

/* ─── Finding what to ban ─────────────────────────────────────────────────── */

/** What the reader is told when it goes looking. */
export const BAN_SCAN_SYSTEM_PROMPT = [
    'You are reviewing a roleplaying chat log for a writer who wants to stop their model',
    'repeating itself.',
    'Reply with a JSON object and nothing else. No prose, no markdown, no code fences.',
    '',
    'Shape:',
    '  { "phrases": ["..."], "notPeople": ["..."] }',
    '',
    '- "phrases" are wordings the narration leans on: stock descriptions, filler beats,',
    '  and turns of phrase that appear again and again. Quote them exactly as written,',
    '  short enough to be a phrase rather than a sentence.',
    '- Do not list ordinary words, names, or anything specific to this story. Banning',
    '  those would stop the model writing about its own setting.',
    '- "notPeople" are labels written as if somebody were speaking - a word followed by a',
    '  colon - that are not a character: dice terms, stat names, section headings.',
    '- Both lists may be empty. An empty list is a real answer.',
].join('\n');

/**
 * Reads the recent chat and proposes what to ban.
 *
 * Nothing here bans anything. It returns two lists for the panel to offer, because a
 * phrase banned by mistake is a phrase the model can no longer write at all - the sampler
 * does not know it was a mistake, and the failure looks like the model going strange
 * rather than like a setting.
 *
 * @returns {Promise<{ phrases: string[], notPeople: string[], read: number }>}
 */
export async function scanForBanCandidates() {
    const settings = getSettings();
    const chat = getContext()?.chat || [];

    const depth = Number(settings.banScanDepth) || 50;
    // Only what the model wrote. The user's own turns are their voice, and a writer's own
    // habits are not what this is for.
    const written = chat.filter(m => !m?.is_user && String(m?.mes ?? '').trim());
    const recent = depth > 0 ? written.slice(-depth) : written;

    if (recent.length === 0) {
        return { phrases: [], notPeople: [], read: 0 };
    }

    const prompt = [
        '### CHAT LOG',
        recent.map(m => String(m.mes)).join('\n\n'),
        '',
        '### TASK',
        'List the phrases this narration leans on, and any labels it writes as speakers '
            + 'that are not characters.',
    ].join('\n');

    const raw = await requestExtraction(
        prompt, null, settings.statusTracker, BAN_SCAN_SYSTEM_PROMPT, { usageKind: 'banscan' });
    const parsed = coerceToUpdate(raw);

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('The reader replied with something that could not be read.');
    }

    return {
        phrases: cleanList(parsed.phrases),
        notPeople: cleanList(parsed.notPeople),
        read: recent.length,
    };
}

/**
 * Trims a proposed list into something offerable.
 *
 * A phrase carrying a double quote is dropped here rather than at send time: the macro
 * that carries a ban is quoted, and half a ban reaching the prompt as visible text is the
 * kind of failure nobody would connect back to this.
 */
function cleanList(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        const text = String(raw ?? '').trim();
        if (!text || text.includes('"')) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

/** Adds approved phrases to the list, skipping any already on it. */
export function addBannedPhrases(phrases) {
    const settings = getSettings();
    if (!Array.isArray(settings.banList)) settings.banList = [];

    const have = new Set(settings.banList.map(p => String(p).toLowerCase()));
    let added = 0;
    for (const phrase of cleanList(phrases)) {
        if (have.has(phrase.toLowerCase())) continue;
        settings.banList.push(phrase);
        have.add(phrase.toLowerCase());
        added += 1;
    }
    if (added) saveSettings();
    return added;
}

/**
 * Adds approved labels to the Not Speakers list.
 *
 * That setting is a newline-or-comma separated string rather than an array - it is
 * something people type into - so this appends to it in the same shape rather than
 * rewriting it into a form the box would then show differently.
 */
export function addNotPeople(labels) {
    const settings = getSettings();
    const current = String(settings.speakerIgnoreList ?? '');
    const have = new Set(
        current.split(/[\n,]/).map(w => normaliseSpeakerLabel(w)).filter(Boolean),
    );

    const wanted = [];
    for (const label of cleanList(labels)) {
        const key = normaliseSpeakerLabel(label);
        if (!key || have.has(key)) continue;
        have.add(key);
        wanted.push(label);
    }
    if (!wanted.length) return 0;

    settings.speakerIgnoreList = current.trim()
        ? `${current.trim()}\n${wanted.join('\n')}`
        : wanted.join('\n');
    saveSettings();
    return wanted.length;
}
