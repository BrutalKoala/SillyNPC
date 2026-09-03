import { getSettings } from './settings.js';
import { mentionsName } from './mentions.js';

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

/**
 * The kinds of thing worth catching. Named so the reader is asked about acts, not
 * importance.
 *
 * `weight` is how well the kind survives being left alone, and the differences are about
 * how each one ends. A debt and a promise stay true until they are discharged, and nothing
 * in the story quietly cancels them. A secret stays true until it is told. A deadline is
 * answerable and then expires. A threat is often rhetoric that the scene moves past. A plan
 * is the one most often silently superseded - people say what they intend to do and then do
 * something else, and nobody narrates the change of mind.
 */
export const THREAD_KINDS = [
    { id: 'promise', label: 'Promise', hint: 'somebody undertook to do something', weight: 1.0 },
    { id: 'threat', label: 'Threat', hint: 'somebody said what would happen if', weight: 0.6 },
    { id: 'debt', label: 'Debt', hint: 'somebody owes or is owed', weight: 1.0 },
    { id: 'secret', label: 'Secret', hint: 'something was told in confidence, or discovered', weight: 0.9 },
    { id: 'deadline', label: 'Deadline', hint: 'something must happen by a time or an event', weight: 0.8 },
    { id: 'plan', label: 'Plan', hint: 'somebody set out to do something later', weight: 0.5 },
];

const KIND_IDS = new Set(THREAD_KINDS.map(k => k.id));
const KIND_WEIGHTS = new Map(THREAD_KINDS.map(k => [k.id, k.weight]));

/** The list, always an array. */
export function getThreads(state) {
    return Array.isArray(state?.threads) ? state.threads : [];
}

/** Still open, in the order they were caught. Ranking for injection is rankedThreads. */
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
export function coerceThread(raw, { messageId = null, pinned = false } = {}) {
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
        // When the story last had anything to do with this. Set again by touchThreads
        // whoever it is about walks back into a scene, which is what keeps a long-running
        // obligation from being scored as cold merely for being old.
        touched: messageId,
        // Exempt from ageing and from pruning. Nothing sets this automatically except a
        // thread the reader wrote themselves.
        // Never read from `raw`: that object is the model's own JSON, and a reply that
        // set pinned would exempt itself from every cap here.
        pinned: pinned === true,
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
    //
    // Pinned, because you wrote it on purpose. Scoring exists to guess which threads still
    // matter, and there is nothing to guess about one somebody typed out by hand - so it is
    // never aged out and never pruned.
    return coerceThread({ ...raw, text, quote: quote || text }, { pinned: true });
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

/** A setting that must be a positive number, or the shipped default. */
function positive(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The caps, in one place, so the UI and the pruning cannot disagree about them. */
export function threadLimits() {
    const settings = getSettings().statusTracker || {};
    return {
        active: positive(settings.threadsInjectedMax, 8),
        openMax: positive(settings.threadsOpenMax, 20),
        closedKeep: positive(settings.threadsClosedKeep, 10),
        halfLife: positive(settings.threadsHalfLife, 60),
    };
}

/**
 * How much a thread is still worth, from 0 up.
 *
 * Ordering these by age alone was the thing that did not work. Age is a poor proxy on its
 * own in both directions: it treated a debt from three hundred messages ago as no different
 * from a plan somebody mentioned once and forgot, and with eighty open it pinned the same
 * eight ancient entries forever so nothing from the current scene was ever carried.
 *
 *     score = kind weight / (1 + messages since touched / half-life)
 *
 * The weight says how well the kind survives neglect. The divisor says the story has moved
 * on without it. A thread is touched when it opens and again whenever whoever it is about
 * walks back into a scene, so a long-running obligation that keeps coming up stays near its
 * full weight however old it is - which is the case ageing alone got wrong.
 *
 * A pin is not a large number, it is Infinity: the reader has answered the question this
 * function exists to guess at, so there is nothing left to weigh.
 *
 * @param {object} thread
 * @param {number} now Index of the latest message.
 * @param {number} [halfLife] Messages until a thread is worth half its kind weight.
 */
export function threadScore(thread, now, halfLife = threadLimits().halfLife) {
    if (!thread) return 0;
    if (thread.pinned) return Infinity;

    const weight = KIND_WEIGHTS.get(thread.kind) ?? 0.5;

    // Threads from before this existed have no `touched`, and a manual one has no message
    // to have opened at. Both fall back in the reader's favour - treated as current rather
    // than as infinitely old, so nothing is pruned merely for predating the field.
    const last = Number(thread.touched ?? thread.opened);
    const age = Number.isFinite(last) && Number.isFinite(now) ? Math.max(0, now - last) : 0;

    return weight / (1 + age / halfLife);
}

/** Open threads, best first. Ties keep their existing order, so the list does not jitter. */
export function rankedThreads(state, now) {
    const { halfLife } = threadLimits();
    return openThreads(state)
        .map((thread, index) => ({ thread, index, score: threadScore(thread, now, halfLife) }))
        .sort((a, b) => (b.score - a.score) || (a.index - b.index))
        .map(entry => entry.thread);
}

/** The ones that ride along with the story: the highest scoring, up to the active cap. */
export function activeThreads(state, now) {
    return rankedThreads(state, now).slice(0, threadLimits().active);
}

/**
 * Every way one of these names might be written in a thread's `who`.
 *
 * The whole name, and each part of it that is long enough to identify somebody. The
 * tracker's name for a character is whatever the extractor first reported - often the full
 * "Varga Elza" - while the same reply writes `who` as "Elza", so the whole name on its own
 * matches nothing.
 *
 * The three-character floor is on the parts only, never on the whole name. A two-letter
 * fragment pulled out of somebody's name is a coincidence waiting to happen, but a
 * character actually called "Bo" is called that, and the word boundaries already stop them
 * matching inside "Bob".
 */
function nameForms(name) {
    const whole = String(name || '').trim().toLowerCase();
    if (!whole) return [];
    const parts = whole.split(/\s+/).filter(p => p.length >= 3 && p !== whole);
    return [whole, ...parts];
}

/**
 * Records that the story has just dealt with whoever these threads are about.
 *
 * Called with the characters the extractor found in a message. Matching on `who` is coarse
 * - a thread about a place or an object has nobody to match - but it costs nothing, since
 * the extractor already knows who was in the scene, and it is the difference between
 * scoring a live obligation as live and scoring it as cold.
 *
 * `who` is free text the model wrote, so this is a search rather than a comparison. It
 * used to be `present.has(who)`, an exact match of the whole string, and in a real chat
 * that matched almost nothing: `who` is written "Elza" where the tracker holds "Varga
 * Elza", and a thread about the whole party arrives as "Kristof, Elza, and David", which
 * can never equal one name. Those are the threads the story is most actively engaged with,
 * and they were the ones ageing fastest.
 *
 * Word boundaries on both sides, the same rule charactersMentionedIn uses, so "Ann" does
 * not touch a thread about "Annamaria".
 *
 * @param {string[]} names Who appeared.
 * @param {number} messageId The message they appeared in.
 * @returns {number} How many threads were touched.
 */
export function touchThreads(state, names, messageId) {
    const forms = [...new Set((names || []).flatMap(nameForms))];
    if (!forms.length) return 0;

    let touched = 0;
    for (const thread of openThreads(state)) {
        const who = String(thread.who || '').trim();
        if (!who || !forms.some(form => mentionsName(who, form))) continue;
        thread.touched = messageId;
        touched += 1;
    }
    return touched;
}

/** Pins or unpins one, by id. @returns {boolean} Whether anything changed. */
export function setThreadPinned(state, id, pinned) {
    const thread = getThreads(state).find(t => t?.id === id);
    if (!thread || thread.pinned === !!pinned) return false;
    thread.pinned = !!pinned;
    return true;
}

/**
 * Enforces the caps, deleting what falls outside them.
 *
 * Deletion, not another status. A third resting place would only move the pile: the reason
 * eighty accumulated is that nothing ever left, and closing merely flipped a flag.
 *
 * Open threads go by score, so what survives is what is still worth carrying rather than
 * whatever happens to be recent. Settled ones go by age, because a closed thread is only a
 * record of what was carried and the newest records are the useful ones. Pinned threads are
 * not counted against the open cap and are never removed - the reader has said they matter,
 * and a cap that could overrule that would make pinning worthless.
 *
 * @returns {{ open: number, closed: number }} How many of each were deleted.
 */
export function pruneThreads(state, now) {
    const all = getThreads(state);
    if (!all.length) return { open: 0, closed: 0 };

    const { openMax, closedKeep } = threadLimits();

    // Pinned ones are kept and are not counted, so pinning three does not quietly cost
    // three of the slots the rest are competing for. Counting them would make the cap
    // punish the very threads the reader singled out as the ones to keep.
    let counted = 0;
    const keptOpen = new Set(
        rankedThreads(state, now)
            .filter(thread => thread.pinned || counted++ < openMax)
            .map(t => t.id));

    // Newest first by the message they were opened at, so the tail dropped is the oldest.
    const keptClosed = new Set(
        all.filter(t => t?.status === 'closed')
            .sort((a, b) => (Number(b?.opened) || 0) - (Number(a?.opened) || 0))
            .slice(0, closedKeep)
            .map(t => t.id));

    let open = 0;
    let closed = 0;
    state.threads = all.filter(thread => {
        if (!thread) return false;
        if (thread.status === 'closed') {
            if (keptClosed.has(thread.id)) return true;
            closed += 1;
            return false;
        }
        if (keptOpen.has(thread.id)) return true;
        open += 1;
        return false;
    });

    return { open, closed };
}

/**
 * The active threads as a block for the story prompt.
 *
 * Capped, because the failure mode is fifty of them injected every turn until the feature
 * costs more than it is worth. Which ones is decided by threadScore rather than by
 * position: see the note there for why age on its own picked badly at both ends.
 *
 * @returns {string} Empty when there is nothing open, so the caller can leave it out.
 */
export function describeThreads(state, now) {
    const settings = getSettings().statusTracker;
    if (settings.threadsEnabled === false) return '';

    const active = activeThreads(state, now);
    if (!active.length) return '';

    // "About X - " rather than "X: ". A name, a colon, then a sentence is the speaker-label
    // shape - see speaker-labels.js, which exists because a narrator writing "**Cost**: 3
    // Energy" was read as somebody speaking. But `who` is who the thread is ABOUT, so that
    // shape said the opposite of what it meant, on a line that also carries a verbatim
    // quote and is injected a message or two from the live scene.
    const lines = active.map(t => {
        const who = t.who ? `About ${t.who} - ` : '';
        return `- ${who}${t.text} ("${t.quote}")`;
    });
    // Said outright, for the same reason: this is what was already said, not what to say.
    const header = 'Open threads (raised earlier in the story, already said - context, '
        + 'not lines to repeat):';
    return `${header}\n${lines.join('\n')}`;
}
