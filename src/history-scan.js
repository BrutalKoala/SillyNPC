import { getContext } from '../../../../st-context.js';
import { getSettings } from './settings.js';
import { THREAD_KINDS } from './threads.js';
import { LOG_PREFIX, debugLog } from './constants.js';
import { loadStateFromMetadata, applyUpdate } from './status-logic.js';
import { requestExtraction, coerceToUpdate, describeCollections, applyThreadsFromReply } from './status-extractor.js';
import { computeStateDiff, partitionChanges } from './status-diff.js';
import { setPendingChanges, isItemDecided, getItemRules, DISMISSED_KEY, PLAYER_ACTOR } from './status-review.js';

/**
 * Bringing collections up to date from the story so far.
 *
 * The per-message extractor only ever sees one message, so an item picked up fifty
 * messages ago and never mentioned since is invisible to it. This reads the history in
 * one pass and proposes what each character should be holding.
 *
 * The difficulty is not finding items - it is *not* finding the ones that are gone. A
 * naive pass returns everything ever mentioned, which quietly resurrects every sword
 * sold and every potion drunk. Three separate guards keep that from happening:
 *
 *  - the prompt asks for the state at the END of the history, and says outright that
 *    anything acquired and later lost must not be listed;
 *  - the dismissal list is sent along, and named as items that must never be proposed;
 *  - every row still goes through the review panel, so nothing lands unseen.
 *
 * The request goes through the tracker's own connection profile, so the story model is
 * not involved and its context is untouched.
 */

export const SCAN_SYSTEM_PROMPT = [
    'You read a roleplay transcript and report what each character is CARRYING and KNOWS',
    'at the END of it. You are taking an inventory, not writing a summary.',
    '',
    'Reply with ONE JSON object and nothing else. No explanation before it, no repeat of',
    'it afterwards, no code fence. Stop as soon as the object is closed.',
    '',
    'Use ONLY the collection ids given under COLLECTIONS. Never invent a key such as',
    '"holds" or "knows". Never use a character name as a top-level key - characters go in',
    'the "characters" array, each with its own "name".',
    'Every collection is an ARRAY of objects. Never an object, never a list of bare',
    'strings, never true/false.',
    '',
    'THE ONE RULE THAT MATTERS:',
    '- Report the FINAL state. Not everything the transcript ever mentioned.',
    '- If something was acquired and later dropped, sold, spent, consumed, destroyed,',
    '  stolen, given away, broken, or left behind - DO NOT LIST IT. It is gone.',
    '- If a spell or skill was lost, forgotten, sealed or replaced by a better version,',
    '  list only what remains.',
    '- A thing merely talked about, offered, or seen is not owned.',
    '',
    'Other rules:',
    '- Never list an item named under DO NOT PROPOSE. Those were already decided against.',
    '- Ignore HP, mana, and every other number. Stats are not your job.',
    '- Include a character only if the transcript shows what they carry or know.',
    '- An abstract fact is not a skill. List a named ability, not "the importance of',
    '  control" or "the history of the Council".',
    '- If an item was upgraded and renamed, give the current name once, not both.',
].join('\n');

/**
 * A filled-in example of the exact reply wanted, in the ids and fields actually
 * configured.
 *
 * Describing the shape in prose is not enough for a small model. Given a description, a
 * 3B model replied with invented "holds" and "knows" keys, character names as top-level
 * keys, and collections as objects of booleans - none of it usable, and it looped until
 * it ran out of tokens. A worked example in the user's own schema is the difference
 * between a reply that parses and one that does not.
 */
function buildOutputTemplate(trackerSettings) {
    const cols = trackerSettings.collections || [];

    // Angle brackets so a placeholder cannot be mistaken for content: a small model will
    // copy an example verbatim given half a chance. The text stays identical for player
    // and characters, and says nothing a collection id has to be bent to fit - it only
    // has to show the shape, and repeat the one rule that matters.
    const sample = (col) => {
        const item = {};
        for (const field of col.fields || [{ name: 'name' }]) {
            if (field.isPrimary || field.name === 'name') {
                item[field.name] = '<exact name - must still be held at the end>';
            } else if (field.type === 'number') {
                item[field.name] = 1;
            } else {
                item[field.name] = '<optional>';
            }
        }
        return item;
    };

    const forTarget = (exclude) => {
        const out = {};
        for (const col of cols.filter(c => c.target !== exclude)) out[col.id] = [sample(col)];
        return out;
    };

    return JSON.stringify({
        player: { collections: forTarget('npc') },
        characters: [{ name: '<their exact name>', collections: forTarget('player') }],
    }, null, 2);
}

/** What each actor currently holds, so the reply is a correction rather than a guess. */
function describeCurrentCollections(state) {
    const lines = [];
    const describe = (who, collections) => {
        const parts = [];
        for (const [colId, items] of Object.entries(collections || {})) {
            const names = (items || []).map(i => i?.name).filter(Boolean);
            if (names.length) parts.push(`  ${colId}: ${names.join(', ')}`);
        }
        if (parts.length) lines.push(`${who}:`, ...parts);
    };
    describe(state.player?.name || 'Player', state.player?.collections);
    for (const character of state.characters || []) describe(character.name, character.collections);
    return lines.join('\n');
}

/**
 * The items already decided against, which must never be proposed again.
 *
 * Only the "never add this" list is worth sending. The protected list says what must not
 * be taken away, and a scan proposes what people own rather than what they lost, so
 * naming those items here would read as a hint to propose them.
 *
 * @param {object} state Used to name the player, whose entries are stored under a slot.
 */
function describeDismissed(state) {
    const lines = [];
    for (const [slot, collections] of Object.entries(getItemRules(DISMISSED_KEY))) {
        const who = slot === PLAYER_ACTOR ? (state?.player?.name || 'Player') : slot;
        for (const [colId, names] of Object.entries(collections || {})) {
            if (names?.length) lines.push(`  ${who} - ${colId}: ${names.join(', ')}`);
        }
    }
    return lines.join('\n');
}

/**
 * The transcript to read, newest-biased and bounded.
 *
 * Two limits, because they fail differently: a message count keeps a scan cheap on a
 * long chat, and a character budget keeps one enormous message from blowing the context
 * on its own.
 *
 * @returns {{ text: string, used: number, chars: number, truncated: boolean }}
 */
export function collectHistory(trackerSettings) {
    const chunks = collectHistoryChunks(trackerSettings);
    const chat = getContext()?.chat || [];
    const depth = Number(trackerSettings.scanDepth ?? 50);
    const eligible = (depth > 0 ? chat.slice(-depth) : chat)
        .filter(m => m && typeof m.mes === 'string' && m.mes.trim()).length;

    const used = chunks.reduce((n, c) => n + c.used, 0);
    return {
        text: chunks[0]?.text || '',
        used,
        chars: chunks.reduce((n, c) => n + c.chars, 0),
        // Whether anything was left unread, which is what the user needs to know - not
        // how the reading was divided up.
        truncated: used < eligible,
        eligible,
        chunks: chunks.length,
    };
}

/**
 * The history split into passes that each fit the budget.
 *
 * One request could not read a long story: 525 messages of this chat are 426,000
 * characters, so a single pass at any sane budget saw the most recent two hundred and
 * silently ignored the rest - which is why spells established early were never found.
 * Several smaller passes read all of it, and cost a handful of requests instead of one
 * enormous one.
 *
 * Ordered oldest-first overall, but built newest-first so that if a limit does bite it
 * is the distant past that is dropped, not what just happened.
 *
 * @returns {Array<{ text: string, used: number, chars: number }>} Oldest chunk first.
 */
function collectHistoryChunks(trackerSettings) {
    const chat = getContext()?.chat || [];
    const depth = Number(trackerSettings.scanDepth ?? 50);
    const budget = Math.max(1000, Number(trackerSettings.scanCharBudget ?? 60000));
    // 0 means as many passes as the history needs. A ceiling here silently decided how
    // much of a long chat was read at all: 525 messages came back as the most recent 200.
    const chunkLimit = Number(trackerSettings.scanMaxChunks ?? 0);
    const maxChunks = chunkLimit > 0 ? chunkLimit : Infinity;

    // 0 means the whole chat.
    const wanted = depth > 0 ? chat.slice(-depth) : chat.slice();

    const chunks = [];
    let parts = [];
    let chars = 0;

    const flush = () => {
        if (!parts.length) return;
        parts.reverse();
        chunks.push({ text: parts.join('\n\n'), used: parts.length, chars });
        parts = [];
        chars = 0;
    };

    for (let i = wanted.length - 1; i >= 0; i--) {
        const message = wanted[i];
        if (!message || typeof message.mes !== 'string' || !message.mes.trim()) continue;
        const who = message.is_user ? 'Player' : (message.name || 'Narrator');
        const line = `[${who}] ${message.mes.trim()}`;

        if (chars + line.length > budget) {
            flush();
            if (chunks.length >= maxChunks) break;
        }
        // A single message longer than the whole budget still has to go somewhere.
        parts.push(line);
        chars += line.length;
    }
    flush();

    return chunks.reverse();
}

/** What a scan will cost before one is sent, for the confirmation. */
export function estimateScan(trackerSettings = getSettings().statusTracker) {
    const { used, chars, truncated, eligible, chunks } = collectHistory(trackerSettings);
    return {
        messages: used, chars, approxTokens: Math.round(chars / 4),
        truncated, eligible, passes: chunks,
    };
}

function buildScanPrompt(state, trackerSettings, history) {
    const dismissed = describeDismissed(state);
    return [
        '### COLLECTIONS',
        describeCollections(trackerSettings) || '(none configured)',
        '',
        '### REPLY EXACTLY IN THIS SHAPE',
        buildOutputTemplate(trackerSettings),
        '',
        '### CURRENTLY RECORDED',
        describeCurrentCollections(state) || '(nothing recorded yet)',
        dismissed ? '\n### DO NOT PROPOSE\n' + dismissed : '',
        '',
        '### TRANSCRIPT',
        history.text,
        '',
        '### TASK',
        'List what each character holds and knows at the END of the transcript, as JSON.',
    ].filter(Boolean).join('\n');
}

/**
 * Reads the history and files everything it finds for review.
 *
 * Nothing is applied here. Even an addition the scan is certain about goes to the panel,
 * because the whole point of a scan is that it is guessing from prose.
 *
 * @returns {Promise<{ ok: boolean, pending?: number, reason?: string, messages?: number }>}
 */
export async function scanHistoryForCollections(onProgress) {
    const trackerSettings = getSettings().statusTracker;
    const context = getContext();
    const chat = context?.chat || [];

    if (!chat.length) return { ok: false, reason: 'This chat is empty.' };
    if (!(trackerSettings.collections || []).length) {
        return { ok: false, reason: 'No collections are configured to fill.' };
    }

    const chunks = collectHistoryChunks(trackerSettings);
    if (!chunks.length) return { ok: false, reason: 'Nothing readable in the history.' };

    const state = loadStateFromMetadata();
    const merged = { player: { collections: {} }, characters: [] };
    const failures = [];
    let messages = 0;

    // A long story does not fit one request, so it is read in passes and the findings
    // are pooled. Oldest first, so a later pass describing the same character overwrites
    // an earlier one - the end of the story is what the collections should reflect.
    for (const [index, chunk] of chunks.entries()) {
        onProgress?.({ chunk: index + 1, of: chunks.length });
        debugLog(`Scanning pass ${index + 1}/${chunks.length}: ${chunk.used} messages, ${chunk.chars} chars`);

        let raw;
        try {
            raw = await requestExtraction(
                buildScanPrompt(state, trackerSettings, chunk), null,
                {
                    ...trackerSettings,
                    // A scan lists whole inventories at once; the per-message budget cut
                    // the reply off mid-object.
                    extractionMaxTokens: trackerSettings.scanMaxTokens ?? 3000,
                    // Falls back to the extraction connection when unset.
                    extractionProfileId: trackerSettings.scanProfileId || trackerSettings.extractionProfileId,
                },
                SCAN_SYSTEM_PROMPT, { usageKind: 'scan' });
        } catch (err) {
            console.error(LOG_PREFIX, `History scan pass ${index + 1} failed.`, err);
            failures.push(String(err?.message || err));
            continue;
        }

        const parsed = coerceToUpdate(raw);
        if (!parsed) {
            failures.push(looksTruncated(raw) ? 'a reply ran out of room' : 'a reply was not JSON');
            continue;
        }

        const update = stripStats(parsed);
        if (!hasAnyCollection(update)) {
            failures.push(describeShapeFailure(parsed, trackerSettings));
            continue;
        }

        mergeFindings(merged, update);
        messages += chunk.used;
    }

    if (!hasAnyCollection(merged)) {
        console.warn(LOG_PREFIX, 'History scan found nothing usable.', failures);
        return {
            ok: false,
            reason: failures[0] || 'The scan found nothing it could read.',
            failures: failures.length,
        };
    }

    // A scan is about the whole cast, not the current scene, so it may reach characters
    // who are off stage - otherwise everything it learns about them is dropped in silence.
    // allowReplace because a scan is a correction: it reads the whole story and returns
    // what each character should be holding, so a list here really does mean "this is
    // everything". A per-message reply never gets this - there, a list is a mistake.
    // Nothing is written regardless; this is a dry run whose diff goes to the review panel.
    const wouldBe = applyUpdate(merged, { dryRun: true, admitCharacters: true, allowReplace: true });
    // Characters with no card have nowhere to keep what a scan learns. Naming them is
    // the difference between a considered limit and a silent loss.
    const skipped = wouldBe.offstageSkipped || [];
    const changes = computeStateDiff(state, wouldBe, trackerSettings)
        .filter(row => row.kind !== 'stat' && row.kind !== 'stat-max')
        // A row covered by a standing decision never reaches the panel. Both kinds are
        // honoured, not just additions: a scan reading three hundred messages is exactly
        // where an item the story stopped mentioning looks lost, so a protected item
        // needs the guard here more than anywhere.
        .filter(row => !isItemDecided(row));

    const result = {
        ok: true, messages, passes: chunks.length, failures: failures.length,
        skipped: [...new Set(skipped)],
    };
    if (!changes.length) return { ...result, pending: 0 };

    // Everything a scan finds is a proposal, however confident it looks.
    const { pending } = partitionChanges(changes, { ...trackerSettings, reviewMode: 'all' });
    setPendingChanges(chat.length - 1, pending);

    return { ...result, pending: pending.length };
}

/**
 * Pools one pass's findings into the running total.
 *
 * Later passes cover later parts of the story, so where they disagree about an item the
 * later one wins; where they simply saw different things, both are kept. A pass that
 * never mentions a character says nothing about them rather than denying them.
 */
function mergeFindings(merged, update) {
    const mergeCollections = (into, from) => {
        for (const [colId, items] of Object.entries(from || {})) {
            if (!Array.isArray(items)) continue;
            const existing = into[colId] || [];
            const byName = new Map(existing.map(i => [String(i?.name ?? '').toLowerCase(), i]));
            for (const item of items) {
                const key = String(item?.name ?? '').trim().toLowerCase();
                if (!key) continue;
                byName.set(key, { ...byName.get(key), ...item });
            }
            into[colId] = [...byName.values()];
        }
    };

    mergeCollections(merged.player.collections, update.player?.collections);

    for (const character of update.characters || []) {
        if (!character?.name) continue;
        let entry = merged.characters.find(
            c => c.name.toLowerCase() === String(character.name).toLowerCase());
        if (!entry) {
            entry = { name: character.name, collections: {} };
            merged.characters.push(entry);
        }
        mergeCollections(entry.collections, character.collections);
    }
}

/**
 * A reply that was cut off mid-object, or that gave up and repeated itself.
 *
 * A model too small for the task tends to emit the same block over and over until the
 * budget runs out, which reads as a parse failure but has a different remedy.
 */
function looksTruncated(raw) {
    const text = typeof raw === 'string' ? raw : '';
    if (!text) return false;
    const opens = (text.match(/{/g) || []).length;
    const closes = (text.match(/}/g) || []).length;
    if (opens > closes) return true;
    // The same opening line several times over is a loop, not an answer.
    const first = text.indexOf('"player"') !== -1 ? '"player"' : '"characters"';
    return text.split(first).length > 3;
}

/** Did anything usable survive the strip? */
function hasAnyCollection(update) {
    if (Object.keys(update.player?.collections || {}).length) return true;
    return (update.characters || []).some(c => Object.keys(c.collections || {}).length);
}

/**
 * Says what was wrong with a reply, in terms the user can act on.
 *
 * "The scan failed" sends someone hunting through their settings. Naming the keys the
 * model actually produced points straight at the model.
 */
function describeShapeFailure(parsed, trackerSettings) {
    const ids = (trackerSettings.collections || []).map(c => c.id);
    const got = Object.keys(parsed || {}).slice(0, 6);
    const detail = got.length ? `It returned ${got.map(k => `"${k}"`).join(', ')}` : 'It returned nothing usable';
    return `${detail}, not the expected ${ids.map(i => `"${i}"`).join(', ')}. `
        + 'This usually means the extraction model is too small for a whole-history pass - '
        + 'try a stronger connection profile for the tracker, or a smaller Messages To Read.';
}

/**
 * Removes anything that is not a collection, at every level.
 *
 * The row filter downstream would catch a stat change too; this stops one being built in
 * the first place. Cheap, and it keeps "a scan does not touch stats" true of the request
 * rather than only of its result.
 */
export function stripStats(parsed) {
    const out = {};
    if (parsed.player?.collections) out.player = { collections: parsed.player.collections };
    if (Array.isArray(parsed.characters)) {
        out.characters = parsed.characters
            .filter(c => c?.name && c.collections)
            .map(c => ({ name: c.name, collections: c.collections }));
    }
    return out;
}

/* ─── Reading a story that is already written ─────────────────────────────── */

/**
 * What the reader is told when it goes looking for what is unfinished.
 *
 * Its own prompt rather than a section added to the inventory scan's. That one opens with
 * "You are taking an inventory, not writing a summary" and every rule under it is about
 * what somebody is holding at the end; asking it for obligations in the same breath makes
 * both jobs vaguer, and the inventory is the one that already works.
 */
export const THREAD_SCAN_SYSTEM_PROMPT = [
    'You read a roleplay transcript and report what is still UNFINISHED at the end of it.',
    '',
    'Reply with ONE JSON object and nothing else. No explanation, no code fence.',
    '  { "threads": [ { "kind": "...", "text": "...", "quote": "...", "who": "..." } ] }',
    '',
    'A thread is one of these, and nothing else:',
    ...THREAD_KINDS.map(k => `  ${k.id} - ${k.hint}`),
    '',
    'THE RULES THAT MATTER:',
    '- "quote" must be words that appear in the transcript. If you cannot quote it, do',
    '  not list it. This is what separates something somebody said from something you',
    '  have inferred.',
    '- Report only what is still OUTSTANDING. A promise that was kept, a debt that was',
    '  paid, a plan that was carried out - leave them out. They are finished.',
    '- Do not list events, or what happened. Only what is owed, threatened, promised,',
    '  hidden, planned, or due.',
    '- Few is right. A long transcript usually leaves a handful of things hanging.',
].join('\n');

/**
 * Reads the story so far and records what is still open.
 *
 * Threads accumulate as a story is played, so a chat that predates the feature has none.
 * This is the way to catch up without replaying five hundred messages - the same chunking
 * the inventory scan uses, because the reason for it is the same: a long story does not
 * fit in one request.
 *
 * Nothing is held for review. A thread costs a line in the prompt and closing a wrong one
 * is a click, and a review panel with forty rows in it is not a decision anybody makes.
 *
 * @param {(progress: { chunk: number, of: number }) => void} [onProgress]
 * @returns {Promise<{ ok: boolean, opened?: number, read?: number, reason?: string, failures?: number }>}
 */
export async function scanHistoryForThreads(onProgress) {
    const trackerSettings = getSettings().statusTracker;
    if (trackerSettings.threadsEnabled !== true) {
        return { ok: false, reason: 'Threads are switched off.' };
    }

    const chunks = collectHistoryChunks(trackerSettings);
    if (!chunks.length) return { ok: false, reason: 'Nothing readable in the history.' };

    const failures = [];
    let opened = 0;
    let read = 0;

    for (const [index, chunk] of chunks.entries()) {
        onProgress?.({ chunk: index + 1, of: chunks.length });

        let raw;
        try {
            raw = await requestExtraction(
                [
                    '### TRANSCRIPT',
                    chunk.text,
                    '',
                    '### TASK',
                    'List what is still unfinished at the end of this, quoting the line each',
                    'one came from.',
                ].join('\n'),
                null,
                {
                    ...trackerSettings,
                    extractionMaxTokens: trackerSettings.scanMaxTokens ?? 3000,
                    extractionProfileId: trackerSettings.scanProfileId || trackerSettings.extractionProfileId,
                },
                THREAD_SCAN_SYSTEM_PROMPT, { usageKind: 'scan' });
        } catch (err) {
            console.error(LOG_PREFIX, `Thread scan pass ${index + 1} failed.`, err);
            failures.push(String(err?.message || err));
            continue;
        }

        const parsed = coerceToUpdate(raw);
        if (!parsed) {
            failures.push(looksTruncated(raw) ? 'a reply ran out of room' : 'a reply was not JSON');
            continue;
        }

        // Applied per pass rather than pooled. addThread already refuses a quote it has
        // seen, so two passes finding the same promise cannot record it twice, and a
        // failure late in a long scan does not throw away what the earlier ones found.
        opened += applyThreadsFromReply(parsed, null).opened;
        read += chunk.used;
    }

    if (!opened && failures.length) {
        return { ok: false, reason: failures[0], failures: failures.length };
    }
    return { ok: true, opened, read, failures: failures.length };
}
