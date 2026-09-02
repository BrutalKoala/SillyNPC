import { getSettings, saveSettings } from './settings.js';
import { countTokens } from './tokens.js';
import { debugLog } from './constants.js';

/**
 * The generators worth counting, in the order they are shown.
 *
 * `sends` says whether a run costs reply tokens: an image model answers with a picture,
 * so counting reply tokens for it would be inventing a number.
 */
export const USAGE_KINDS = [
    { id: 'extraction', label: 'Tracker Extraction', sends: 'text',
      note: 'One per message, when the tracker is set to a separate pass.' },
    { id: 'lore', label: 'Lore Generation', sends: 'text',
      note: 'One per lore entry you generate.' },
    { id: 'scan', label: 'History Scan', sends: 'text',
      note: 'Several per scan - a long story is read in passes.' },
    { id: 'fill', label: 'Character Fill', sends: 'text',
      // One per stage, not one per character: Fill offers the profile, the lore, the
      // stats and a portrait, and the ones you pick run as separate requests. The profile
      // and the stats both land here, so a character filled completely is two runs on
      // this card, one on Lore Generation and one on Portrait Generation.
      note: 'One per stage of a fill - the profile and the stats are separate requests, '
          + 'so filling a character completely counts twice here.' },
    { id: 'banscan', label: 'Ban List Scan', sends: 'text',
      note: 'One per scan, from the Ban List tab. It reads recent narration, so it costs '
          + 'about what a short scan does.' },
    { id: 'image', label: 'Portrait Generation', sends: 'image',
      note: 'The reply is a picture, so only what was sent is counted.' },
];

function blank() {
    return { runs: 0, promptTokens: 0, replyTokens: 0, lastWhen: 0, lastTotal: 0 };
}

/** The counters, creating any that are missing. */
export function getUsage() {
    const settings = getSettings();
    if (!settings.usage || typeof settings.usage !== 'object') settings.usage = {};
    for (const kind of USAGE_KINDS) {
        if (!settings.usage[kind.id]) settings.usage[kind.id] = blank();
    }
    return settings.usage;
}

/**
 * Records one run.
 *
 * Counting asks the tokenizer, which can be slow or unavailable, so this is deliberately
 * not awaited by the generators: a failure to count must never fail a generation, and a
 * counter is not worth a moment of the user's waiting. Errors are logged and dropped.
 *
 * @param {string} kindId One of USAGE_KINDS.
 * @param {{ prompt?: string, reply?: string }} texts
 * @returns {Promise<void>}
 */
export async function recordUsage(kindId, { prompt = '', reply = '' } = {}) {
    try {
        const kind = USAGE_KINDS.find(k => k.id === kindId);
        if (!kind) return;

        const promptTokens = (await countTokens(prompt)).count;
        const replyTokens = kind.sends === 'text' ? (await countTokens(reply)).count : 0;

        const entry = getUsage()[kindId];
        entry.runs += 1;
        entry.promptTokens += promptTokens;
        entry.replyTokens += replyTokens;
        entry.lastTotal = promptTokens + replyTokens;
        entry.lastWhen = Date.now();
        saveSettings();
    } catch (err) {
        debugLog('Could not record usage', err);
    }
}

/** Averages for one generator. Zero runs means no average, not zero. */
export function averageFor(kindId) {
    const entry = getUsage()[kindId] || blank();
    if (!entry.runs) return null;
    return {
        runs: entry.runs,
        prompt: Math.round(entry.promptTokens / entry.runs),
        reply: Math.round(entry.replyTokens / entry.runs),
        total: Math.round((entry.promptTokens + entry.replyTokens) / entry.runs),
        lastWhen: entry.lastWhen,
        lastTotal: entry.lastTotal,
    };
}

/** Starts every counter again from zero. */
export function resetUsage() {
    const settings = getSettings();
    settings.usage = {};
    getUsage();
    saveSettings();
}
