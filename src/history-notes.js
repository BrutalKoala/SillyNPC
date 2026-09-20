import { GLOBALS_KEY } from './status-snapshots.js';

/**
 * The world state, on each message of the history the story model reads.
 *
 * The tracker has recorded the world's fields on every message since it was switched on,
 * and until now only the tracker box read them. The model saw a wall of messages with no
 * time and no place on any of them, so a conversation about what happened two days ago had
 * nothing to go on unless somebody had said the date out loud.
 *
 * The history this writes into is SillyTavern's own copy, handed to extensions by
 * runGenerationInterceptors just before the prompt is built (script.js). The entries are
 * copies carrying their own `extra`, so the snapshot is right there on the message and the
 * chat file is never touched.
 *
 * Both functions are given everything they need, so neither reads settings and both can be
 * exercised on their own.
 */

/**
 * The fields of one snapshot, in the order the system declares them.
 *
 * Empty values are left out: a field nobody has filled in says nothing, and it would say it
 * on every message.
 *
 * @param {Record<string, string>} globals What the world held at that message.
 * @param {string[]} names The fields to show, in order.
 * @returns {string} "Location: Streets | Time: 2007/12/31 17:33", or '' when none apply.
 */
export function noteFields(globals, names) {
    if (!globals || typeof globals !== 'object') return '';
    return (names || [])
        .map(name => [name, globals[name]])
        .filter(([, value]) => String(value ?? '').trim() !== '')
        .map(([name, value]) => `${name}: ${String(value).trim()}`)
        .join(' | ');
}

/**
 * Puts each message's world state at the top of that message.
 *
 * At the top rather than the bottom, so the model knows when and where it is before it
 * reads what happened.
 *
 * Three things are left alone: a message with no snapshot (everything before the record
 * began), a message whose note would be empty, and a message that already carries its note -
 * an interceptor can be asked to run twice over the same array, and a doubled note is worse
 * than none.
 *
 * @param {Array<{ mes?: string, extra?: object }>} chat SillyTavern's copy of the history.
 * @param {{ names: string[], render: (fields: string) => string }} how
 * @returns {number} How many messages were given a note.
 */
export function noteHistory(chat, { names, render }) {
    let added = 0;
    for (const message of Array.isArray(chat) ? chat : []) {
        const fields = noteFields(message?.extra?.[GLOBALS_KEY], names);
        if (!fields) continue;
        const note = String(render(fields) ?? '').trim();
        if (!note) continue;
        const text = String(message.mes ?? '');
        if (text.startsWith(note)) continue;
        message.mes = `${note}\n${text}`;
        added++;
    }
    return added;
}

/**
 * The world fields to show, in System Builder's order, minus the ones you unticked.
 *
 * Kept as the fields to leave out rather than the fields to show, so a field added later is
 * shown without anybody going back to tick it.
 *
 * @param {object} trackerSettings
 * @returns {string[]}
 */
export function noteFieldNames(trackerSettings) {
    const skipped = new Set((trackerSettings?.historyNoteSkip || [])
        .map(name => String(name).trim().toLowerCase()));
    return (trackerSettings?.globalStats || [])
        .map(stat => String(stat?.name ?? '').trim())
        .filter(name => name && !skipped.has(name.toLowerCase()));
}
