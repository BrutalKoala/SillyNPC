import { getSettings } from './settings.js';
import { loadStateFromMetadata, saveStateToMetadata } from './status-logic.js';
import {
    THREAD_KINDS, getThreads, openThreads, closeThread, reopenThread, addThread, manualThread,
} from './threads.js';
import { scanHistoryForThreads } from './history-scan.js';
import { LOG_PREFIX } from './constants.js';
import { buildSettingToggle, buildSettingNumber } from './ui-shared.js';
import { POPUP_TYPE, Popup } from '../../../../popup.js';

/**
 * The list of what is still outstanding, and a way to correct it.
 *
 * The point of the panel is not really the closing button - the reader closes most of them
 * on its own. It is being able to see what is being sent with every message, because that
 * is the cost of the feature and it should never be a mystery.
 */

const KIND_LABELS = Object.fromEntries(THREAD_KINDS.map(k => [k.id, k.label]));

/** One thread: what it is, where it came from, and the way to settle it. */
function threadRow(thread, state, redraw) {
    const row = document.createElement('div');
    row.className = `sillynpc-thread-row is-${thread.status === 'closed' ? 'closed' : 'open'}`;

    const kind = document.createElement('span');
    kind.className = 'sillynpc-thread-kind';
    kind.textContent = KIND_LABELS[thread.kind] || thread.kind;

    const body = document.createElement('div');
    body.className = 'sillynpc-thread-body';

    const text = document.createElement('div');
    text.className = 'sillynpc-thread-text';
    text.textContent = thread.who ? `${thread.who}: ${thread.text}` : thread.text;

    body.append(text);

    // The line it came from, shown because it is what makes a thread checkable. A thread
    // whose quote does not appear in the story is one the reader invented, and there is no
    // way to notice that without seeing it.
    //
    // One you wrote yourself with no line to point at carries its own text as its quote,
    // and printing the same words twice says nothing.
    if (String(thread.quote ?? '').trim() !== String(thread.text ?? '').trim()) {
        const quote = document.createElement('div');
        quote.className = 'sillynpc-thread-quote';
        quote.textContent = `"${thread.quote}"`;
        body.append(quote);
    }

    const actions = document.createElement('div');
    actions.className = 'sillynpc-thread-actions';

    const settle = document.createElement('button');
    settle.type = 'button';
    settle.className = 'menu_button';
    const isClosed = thread.status === 'closed';
    settle.innerHTML = isClosed
        ? '<i class="fa-solid fa-rotate-left"></i>'
        : '<i class="fa-solid fa-check"></i>';
    settle.title = isClosed ? 'Open it again' : 'Settled - stop sending it';
    settle.addEventListener('click', () => {
        if (isClosed) reopenThread(state, thread.id);
        else closeThread(state, thread.id);
        saveStateToMetadata(state, { label: isClosed ? 'Thread reopened' : 'Thread closed' });
        redraw();
    });

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'menu_button';
    drop.innerHTML = '<i class="fa-solid fa-trash"></i>';
    drop.title = 'Forget it entirely';
    drop.addEventListener('click', () => {
        const list = getThreads(state);
        const at = list.findIndex(t => t.id === thread.id);
        if (at >= 0) list.splice(at, 1);
        saveStateToMetadata(state, { label: 'Thread dropped' });
        redraw();
    });

    actions.append(settle, drop);
    row.append(kind, body, actions);
    return row;
}

/**
 * Asks for a thread you want kept, and adds it.
 *
 * The reader catches what it notices. Something you know matters and it did not - an
 * arrangement made three scenes ago, a name you mean to come back to - had no way in at
 * all, though the ban list has taken things by hand since it was written.
 *
 * @param {() => void} redraw
 */
async function askForThread(redraw) {
    const wrap = document.createElement('div');
    wrap.className = 'sillynpc-thread-add';

    const heading = document.createElement('h3');
    heading.textContent = 'Something to keep hold of';
    wrap.append(heading);

    const kindLabel = document.createElement('label');
    kindLabel.className = 'sillynpc-thread-add-field';
    kindLabel.textContent = 'What kind';
    const kind = document.createElement('select');
    kind.className = 'text_pole';
    for (const entry of THREAD_KINDS) {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = `${entry.label} - ${entry.hint}`;
        kind.append(option);
    }
    kindLabel.append(kind);
    wrap.append(kindLabel);

    const textLabel = document.createElement('label');
    textLabel.className = 'sillynpc-thread-add-field';
    textLabel.textContent = 'What is outstanding';
    const text = document.createElement('textarea');
    text.className = 'text_pole';
    text.rows = 2;
    text.placeholder = 'She agreed to meet him at the north gate before dawn';
    textLabel.append(text);
    wrap.append(textLabel);

    const whoLabel = document.createElement('label');
    whoLabel.className = 'sillynpc-thread-add-field';
    whoLabel.textContent = 'Whose it is (optional)';
    const who = document.createElement('input');
    who.type = 'text';
    who.className = 'text_pole';
    who.placeholder = 'Vesper';
    whoLabel.append(who);
    wrap.append(whoLabel);

    const quoteLabel = document.createElement('label');
    quoteLabel.className = 'sillynpc-thread-add-field';
    quoteLabel.textContent = 'The line it came from (optional)';
    const quote = document.createElement('input');
    quote.type = 'text';
    quote.className = 'text_pole';
    quote.placeholder = 'Before dawn. The north gate.';
    quoteLabel.append(quote);
    wrap.append(quoteLabel);

    const note = document.createElement('small');
    note.className = 'notes';
    note.textContent = 'The line is what makes a thread checkable later, so it is worth '
        + 'pasting when there is one. A thread the reader found always has it; one you '
        + 'wrote does not need it.';
    wrap.append(note);

    const popup = new Popup(wrap, POPUP_TYPE.CONFIRM, '', { okButton: 'Keep it', cancelButton: 'Cancel' });
    if (!await popup.show()) return;

    const thread = manualThread({
        kind: kind.value,
        text: text.value,
        who: who.value,
        quote: quote.value,
    });
    if (!thread) {
        toastr.warning('A thread needs to say what is outstanding.', 'SillyNPC');
        return;
    }

    const state = loadStateFromMetadata();
    if (!addThread(state, thread)) {
        toastr.info('Something with that line is already being kept.', 'SillyNPC');
        return;
    }
    // Labelled, so it is an undo step - the same as closing or dropping one. A
    // deliberate action of yours should be reversible; the reader's own finds are not
    // recorded that way, because they arrive with the message rather than from a click.
    saveStateToMetadata(state, { label: 'Thread added' });
    redraw();
}

/** Renders the panel into a container, redrawing itself as things are settled. */
export function renderThreads(container) {
    if (!container) return;
    container.replaceChildren();
    container.className = 'sillynpc-threads-panel';

    const redraw = () => renderThreads(container);

    let state;
    try {
        state = loadStateFromMetadata();
    } catch {
        const none = document.createElement('p');
        none.className = 'notes';
        none.textContent = 'No chat open.';
        container.append(none);
        return;
    }

    const all = getThreads(state);
    const open = openThreads(state);

    const summary = document.createElement('div');
    summary.className = 'notes';
    const cap = Number(getSettings().statusTracker.threadsInjectedMax) || 8;
    summary.textContent = all.length === 0
        ? 'Nothing outstanding yet. Threads are caught as they open, so this fills up as '
            + 'the story goes rather than all at once.'
        : `${open.length} open, ${all.length - open.length} settled. `
            + `The oldest ${Math.min(open.length, cap)} ride along with every message.`;
    container.append(summary);

    // Threads accumulate as a story is played, so a chat that predates the feature has
    // none. This is the way to catch up without replaying it.
    const scan = document.createElement('button');
    scan.type = 'button';
    scan.className = 'menu_button sillynpc-thread-scan';
    scan.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i> Read the story so far';
    scan.title = 'Look back through this chat for anything still unfinished.';
    scan.addEventListener('click', async () => {
        scan.disabled = true;
        scan.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Reading...';
        try {
            const result = await scanHistoryForThreads(({ chunk, of }) => {
                scan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Pass ${chunk} of ${of}...`;
            });
            if (!result.ok) toastr.error(result.reason, 'SillyNPC');
            else if (!result.opened) toastr.info('Nothing left hanging that it could find.', 'SillyNPC');
            else toastr.success(`Found ${result.opened} across ${result.read} message(s).`, 'SillyNPC');
        } catch (err) {
            console.error(LOG_PREFIX, 'Thread scan failed', err);
            toastr.error(String(err?.message || err), 'SillyNPC');
        } finally {
            redraw();
        }
    });
    const byHand = document.createElement('button');
    byHand.type = 'button';
    byHand.className = 'menu_button';
    byHand.innerHTML = '<i class="fa-solid fa-plus"></i> Add by hand';
    byHand.title = 'Keep hold of something yourself, whether or not the reader noticed it.';
    byHand.addEventListener('click', () => {
        askForThread(redraw).catch(err => {
            console.error(LOG_PREFIX, 'Adding a thread failed', err);
            toastr.error(String(err?.message || err), 'SillyNPC');
        });
    });

    // One row: both are ways of getting a thread in that the reader did not find as the
    // story went past.
    const gather = document.createElement('div');
    gather.className = 'sillynpc-thread-gather';
    gather.append(scan, byHand);
    container.append(gather);

    if (!all.length) return;

    const list = document.createElement('div');
    list.className = 'sillynpc-thread-list';
    // Open first, and oldest first within that - the order they are sent in, so what is on
    // screen is what the model is being told.
    for (const thread of [...open, ...all.filter(t => t.status === 'closed')]) {
        list.append(threadRow(thread, state, redraw));
    }
    container.append(list);
}

/**
 * The whole tab: what a thread is, the switch, the cap, and the list.
 *
 * It has a page of its own because the switch spent its first version inside the Tracker
 * tab's Advanced block - the one introduced as "limits and budgets, the defaults suit most
 * setups" - which is the last place anybody would look for a feature.
 *
 * It explains itself at the top, which the other tabs do not need to: this one is off by
 * default, so anybody reading it has never seen it work and has no idea what it would do.
 *
 * @param {HTMLElement} container
 */
export function renderThreadsView(container) {
    if (!container) return;
    container.replaceChildren();

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = 'Open Threads';
    container.append(title);

    const blurb = document.createElement('p');
    blurb.className = 'notes sillynpc-threads-blurb';
    blurb.textContent = 'Promises, threats, debts, secrets, deadlines and plans - caught as '
        + 'they are made, kept with the words they came from, and sent with every message '
        + 'until they are settled. This is the thing a summary cannot do: a summary keeps '
        + 'what looked important when it was written, so the line that turns out to matter '
        + 'four hundred messages later was already thrown away. Nothing is searched for '
        + 'here, because nothing was ever filed away.';
    container.append(blurb);

    const cost = document.createElement('p');
    cost.className = 'notes sillynpc-threads-blurb';
    cost.textContent = 'It costs a little on every message: a few lines added to what the '
        + 'reader is asked, and a few sent back with the scene. Off by default for that '
        + 'reason, and because a reader that over-reports turns eight useful lines into '
        + 'fifty. The list below is exactly what is being sent, so that never has to be '
        + 'guessed at.';
    container.append(cost);

    container.append(buildSettingToggle({
        key: 'statusTracker.threadsEnabled',
        label: 'Track What Is Not Finished With',
        help: 'Asks the reader, on every message, whether anything in it opened one of the '
            + 'six above - and whether anything closed one.',
        onChange: () => renderThreadsView(container),
    }));

    if (!getSettings().statusTracker.threadsEnabled) return;

    container.append(buildSettingNumber({
        key: 'statusTracker.threadsInjectedMax',
        advanced: true,
        label: 'How Many Ride Along',
        suffix: 'threads',
        help: 'The oldest open ones are sent, up to this many. Oldest because something '
            + 'open for two hundred messages is what is at risk of being forgotten - a '
            + 'fresh one is still in the chat the model can see.',
        onChange: () => renderThreadsView(container),
    }));

    const kinds = document.createElement('div');
    kinds.className = 'sillynpc-thread-kinds';
    for (const kind of THREAD_KINDS) {
        const row = document.createElement('div');
        row.className = 'sillynpc-thread-kind-row';
        const name = document.createElement('span');
        name.className = 'sillynpc-thread-kind';
        name.textContent = kind.label;
        const hint = document.createElement('span');
        hint.className = 'notes';
        hint.textContent = kind.hint;
        row.append(name, hint);
        kinds.append(row);
    }
    container.append(kinds);

    const list = document.createElement('div');
    container.append(list);
    renderThreads(list);
}
