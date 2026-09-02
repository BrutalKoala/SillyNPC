import { getSettings } from './settings.js';

/**
 * Things said and done that are not finished with.
 *
 * WHY THIS IS NOT A MEMORY FEATURE, because it looks like one and is not.
 *
 * Summarising is lossy at the moment of summarising: it keeps what looked important then,
 * so a line that matters four hundred messages later was already dropped. Vector search
 * needs the query to resemble the answer, which is why a search finds a scene about a
 * river and misses the promise made beside one. Neither is a tuning problem; both are
 * what those tools are.
 *
 * The way past it is not to search a haystack better. It is not to make a haystack. You
 * cannot ask a model "will this matter later" - that is the question nobody can answer at
 * the time - but you can ask "did anything here create a promise, a threat, a debt, a
 * secret told, a deadline, a plan". Those are speech acts. They are recognisable as they
 * happen, they are few, and they are what comes back.
 *
 * So a thread is caught when it opens, kept verbatim, injected while it is open, and
 * closed when it resolves. Nothing is retrieved, because nothing was ever filed away.
 */

/** The kinds of thing worth catching. Named so the reader is asked about acts, not importance. */
export const THREAD_KINDS = [
    { id: 'promise', label: 'Promise', hint: 'somebody undertook to do something' },
    { id: 'threat', label: 'Threat', hint: 'somebody said what would happen if' },
    { id: 'debt', label: 'Debt', hint: 'somebody owes or is owed' },
    { id: 'secret', label: 'Secret', hint: 'something was told in confidence, or discovered' },
    { id: 'deadline', label: 'Deadline', hint: 'something must happen by a time or an event' },
    { id: 'plan', label: 'Plan', hint: 'somebody set out to do something later' },
];

const KIND_IDS = new Set(THREAD_KINDS.map(k => k.id));

/** The list, always an array. */
export function getThreads(state) {
    return Array.isArray(state?.threads) ? state.threads : [];
}

/** Still open, oldest first - the order they are injected in when the cap bites. */
export function openThreads(state) {
    return getThreads(state).filter(t => t && t.status !== 'closed');
}

/**
 * Turns what the reader proposed into a thread, or refuses it.
 *
 * A thread that cannot quote the line it came from is refused. That one rule is what
 * separates this from a model inventing plot: the quote is checkable against the message,
 * and something with no source is something nobody said.
 *
 * @returns {object|null} Null when it is not usable.
 */
export function coerceThread(raw, { messageId = null } = {}) {
    if (!raw || typeof raw !== 'object') return null;

    const text = String(raw.text ?? '').trim();
    const quote = String(raw.quote ?? '').trim();
    if (!text || !quote) return null;

    const kind = String(raw.kind ?? '').trim().toLowerCase();

    return {
        id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        kind: KIND_IDS.has(kind) ? kind : 'plan',
        text,
        quote,
        who: String(raw.who ?? '').trim(),
        opened: messageId,
        status: 'open',
    };
}

/**
 * A thread you wrote yourself.
 *
 * The quote rule exists to catch the reader inventing obligations: a thread whose words do
 * not appear in the story is one nothing said, and there is no way to notice that without
 * seeing the line. None of that applies to a thread you typed - you are the source - so
 * the quote is optional here, and stands in as the text when it is left out.
 *
 * Not merely cosmetic: the quote is a thread's identity, and addThread refuses one it has
 * already seen. A manual thread with no quote at all could be added over and over.
 *
 * @param {{ kind?: string, text?: string, quote?: string, who?: string }} raw
 * @returns {object|null} Null when there is no text, which is the one thing required.
 */
export function manualThread(raw) {
    const text = String(raw?.text ?? '').trim();
    const quote = String(raw?.quote ?? '').trim();
    // No check for empty text here: with the quote standing in for it, a thread saying
    // nothing arrives at coerceThread with both blank and is refused there. One place
    // decides what a thread must have.
    return coerceThread({ ...raw, text, quote: quote || text });
}

/**
 * Adds a thread, unless the same one is already open.
 *
 * Matched on the quote rather than the description: the reader will word the same
 * obligation differently on two passes, and the line it came from is the stable part.
 *
 * @returns {boolean} Whether anything was added.
 */
export function addThread(state, thread) {
    if (!thread) return false;
    if (!Array.isArray(state.threads)) state.threads = [];

    const key = thread.quote.toLowerCase();
    const already = state.threads.some(t => String(t?.quote ?? '').toLowerCase() === key);
    if (already) return false;

    state.threads.push(thread);
    return true;
}

/**
 * Closes a thread by id.
 *
 * Closed rather than deleted. A resolved thread stops being sent but stays in the record,
 * so a wrong close can be undone and the list can show what it has been carrying.
 *
 * @returns {boolean} Whether anything changed.
 */
export function closeThread(state, id) {
    const thread = getThreads(state).find(t => t?.id === id);
    if (!thread || thread.status === 'closed') return false;
    thread.status = 'closed';
    return true;
}

/** Reopens one that was closed too early. */
export function reopenThread(state, id) {
    const thread = getThreads(state).find(t => t?.id === id);
    if (!thread || thread.status !== 'closed') return false;
    thread.status = 'open';
    return true;
}

/**
 * The open threads as a block for the story prompt.
 *
 * Capped, because the failure mode is fifty of them injected every turn until the feature
 * costs more than it is worth. Oldest first when it bites: an obligation that has been
 * open for two hundred messages is the one at risk of being forgotten, and a fresh one is
 * still in the chat the model can see.
 *
 * @returns {string} Empty when there is nothing open, so the caller can leave it out.
 */
export function describeThreads(state) {
    const settings = getSettings().statusTracker;
    if (settings.threadsEnabled === false) return '';

    const cap = Number(settings.threadsInjectedMax);
    const limit = Number.isFinite(cap) && cap > 0 ? cap : 8;

    const open = openThreads(state).slice(0, limit);
    if (!open.length) return '';

    const lines = open.map(t => {
        const who = t.who ? `${t.who}: ` : '';
        return `- ${who}${t.text} ("${t.quote}")`;
    });
    return `Open threads:\n${lines.join('\n')}`;
}
