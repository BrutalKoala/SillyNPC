/**
 * Working out what an update would change, and which of those changes deserve a look.
 *
 * The reader proposes state; it does not get to impose it. Collections in particular are
 * replaced wholesale (applyCollectionUpdate empties the array and repopulates), so an item
 * the model simply forgets to mention is deleted. Additions and removals are therefore
 * surfaced rather than applied silently.
 *
 * Ordinary movement - HP dropping, a location changing - is left alone. Confirming every
 * one would mean answering a dialog on almost every message, and undo already covers a
 * mistake that slips through.
 */

import { splitValue } from './utils.js';

export { splitValue };

const asNumber = (value) => {
    const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
    return match ? parseFloat(match[0]) : null;
};

/** The primary field of a collection, which identifies an item. */
function primaryFieldName(colDef) {
    return (colDef?.fields || []).find(f => f.isPrimary)?.name || 'name';
}

function itemKey(item, primary) {
    return String(item?.[primary] ?? item?.name ?? '').toLowerCase();
}

function itemLabel(item, primary) {
    return String(item?.[primary] ?? item?.name ?? '(unnamed)');
}

/**
 * Compares one stat before and after, emitting up to two changes: the value and,
 * separately, its ceiling. Keeping them apart matters because they carry different risk -
 * a value moving is ordinary, a ceiling moving is worth seeing.
 */
function diffStat({ scope, actor, label, before, after, settings, policy, threshold }) {
    const changes = [];
    if (String(before ?? '') === String(after ?? '')) return changes;

    const from = splitValue(before);
    const to = splitValue(after);

    if (from.max !== to.max) {
        const fromMax = asNumber(from.max);
        const toMax = asNumber(to.max);
        const decreased = fromMax !== null && toMax !== null && toMax < fromMax;
        changes.push({
            scope, actor, label, kind: 'stat-max',
            before: from.max || '(none)', after: to.max || '(none)',
            // A ceiling going up is a level-up; going down is almost never intentional and
            // is what silently reset a character from 120 back to 80.
            risk: policy === 'review-all' || (policy === 'review-decreases' && decreased)
                ? 'risky' : 'informational',
            reason: decreased ? 'maximum decreased' : 'maximum increased',
        });
    }

    if (from.current !== to.current) {
        const fromNum = asNumber(from.current);
        const toNum = asNumber(to.current);
        const ceiling = asNumber(to.max) ?? asNumber(from.max);
        let risk = 'normal';
        let reason = '';

        if (fromNum !== null && toNum !== null && ceiling) {
            const swing = Math.abs(toNum - fromNum) / Math.abs(ceiling);
            if (swing > threshold) {
                risk = 'risky';
                reason = `changed by more than ${Math.round(threshold * 100)}% of its range`;
            }
        }
        changes.push({
            scope, actor, label, kind: 'stat',
            before: from.current, after: to.current, risk, reason,
        });
    }

    return changes;
}

/** Compares one actor's collections. */
function diffCollections({ scope, actor, before, after, trackerSettings }) {
    const changes = [];
    const ids = new Set([
        ...Object.keys(before?.collections || {}),
        ...Object.keys(after?.collections || {}),
    ]);

    for (const colId of ids) {
        const colDef = (trackerSettings.collections || []).find(c => c.id === colId);
        const primary = primaryFieldName(colDef);
        const beforeItems = before?.collections?.[colId] || [];
        const afterItems = after?.collections?.[colId] || [];

        const beforeByKey = new Map(beforeItems.map(i => [itemKey(i, primary), i]));
        const afterByKey = new Map(afterItems.map(i => [itemKey(i, primary), i]));

        for (const [key, item] of beforeByKey) {
            if (afterByKey.has(key)) continue;
            changes.push({
                scope, actor, label: itemLabel(item, primary), collectionId: colId,
                kind: 'item-remove', before: itemLabel(item, primary), after: '(gone)',
                // Wholesale replacement means an item the model forgot is indistinguishable
                // from one it deliberately dropped.
                risk: 'risky', reason: 'item would be removed',
                item,
            });
        }

        for (const [key, item] of afterByKey) {
            if (beforeByKey.has(key)) continue;
            changes.push({
                scope, actor, label: itemLabel(item, primary), collectionId: colId,
                kind: 'item-add', before: '(none)', after: itemLabel(item, primary),
                risk: 'risky', reason: 'new item',
                item,
            });
        }

        for (const [key, afterItem] of afterByKey) {
            const beforeItem = beforeByKey.get(key);
            if (!beforeItem) continue;
            for (const field of colDef?.fields || []) {
                const a = beforeItem?.[field.name];
                const b = afterItem?.[field.name];
                if (String(a ?? '') === String(b ?? '')) continue;
                changes.push({
                    scope, actor, label: `${itemLabel(afterItem, primary)} · ${field.label || field.name}`,
                    collectionId: colId, field: field.name,
                    kind: 'item-change', before: String(a ?? ''), after: String(b ?? ''),
                    risk: 'normal', reason: '',
                    item: afterItem,
                });
            }
        }
    }

    return changes;
}

/**
 * Everything an update would change.
 *
 * @param {object} before Current state.
 * @param {object} after State the update would produce (from applyUpdate dryRun).
 * @param {object} trackerSettings
 * @returns {Array<object>} Flat list of changes, each with a `risk`.
 */
export function computeStateDiff(before, after, trackerSettings) {
    const policy = trackerSettings.maxChangePolicy || 'free';
    const threshold = Number(trackerSettings.reviewSwingThreshold ?? 0.6);
    const changes = [];

    const globalKeys = new Set([
        ...Object.keys(before?.global || {}),
        ...Object.keys(after?.global || {}),
    ]);
    for (const key of globalKeys) {
        changes.push(...diffStat({
            scope: 'global', actor: null, label: key,
            before: before?.global?.[key], after: after?.global?.[key],
            settings: trackerSettings, policy, threshold,
        }));
    }

    const playerStatKeys = new Set([
        ...Object.keys(before?.player?.stats || {}),
        ...Object.keys(after?.player?.stats || {}),
    ]);
    for (const key of playerStatKeys) {
        changes.push(...diffStat({
            scope: 'player', actor: null, label: key,
            before: before?.player?.stats?.[key], after: after?.player?.stats?.[key],
            settings: trackerSettings, policy, threshold,
        }));
    }
    changes.push(...diffCollections({
        scope: 'player', actor: null,
        before: before?.player, after: after?.player, trackerSettings,
    }));

    // Characters are matched by name; presence itself is decided elsewhere, so a
    // character appearing or leaving is not reported here as a change to review.
    const byName = (list) => new Map((list || []).map(c => [String(c.name).toLowerCase(), c]));
    const beforeChars = byName(before?.characters);
    const afterChars = byName(after?.characters);

    for (const [key, afterChar] of afterChars) {
        // A character the update introduces has everything to say and nothing to compare
        // against, so treat them as starting empty rather than skipping them. Skipping
        // meant a scan could learn an NPC's whole spell list and produce no rows at all,
        // which read as "nothing to change".
        const beforeChar = beforeChars.get(key) || { name: afterChar.name, stats: {}, collections: {} };
        const statKeys = new Set([
            ...Object.keys(beforeChar.stats || {}),
            ...Object.keys(afterChar.stats || {}),
        ]);
        for (const stat of statKeys) {
            changes.push(...diffStat({
                scope: 'character', actor: afterChar.name, label: stat,
                before: beforeChar.stats?.[stat], after: afterChar.stats?.[stat],
                settings: trackerSettings, policy, threshold,
            }));
        }
        changes.push(...diffCollections({
            scope: 'character', actor: afterChar.name,
            before: beforeChar, after: afterChar, trackerSettings,
        }));
    }

    return changes;
}

/** Splits a diff into what may apply now and what needs a look. */
/** One key, however it was spelled: case folded, and a space read as the separator. */
const reasonKey = (text) => String(text ?? '').trim().toLowerCase().replace(/\s+/g, '.');

/**
 * The keys a change row could be named by.
 *
 * The bare label as well as the qualified one, because a reader that has only one Health
 * in front of it will often write "Health" and mean the character's.
 */
function reasonKeysFor(change) {
    const label = reasonKey(change?.label);
    if (!label) return [];
    const actor = change?.actor ? reasonKey(change.actor) : '';
    if (change?.scope === 'player') return [`player.${label}`, label];
    if (actor) return [`${actor}.${label}`, label];
    return [label];
}

/**
 * Puts the reader's own account of a change on the row it explains.
 *
 * Kept as `note`, separate from `reason`: that one is the extension's risk assessment -
 * "large swing", "maximum decreased" - and the reader's account of itself must not
 * overwrite the reason the row was held back in the first place.
 *
 * A qualified key is preferred over a bare one, so "Elza.Health" and "Health" arriving
 * together do not both land on Elza.
 *
 * @param {Array<object>} changes Mutated in place.
 * @param {Record<string, string>} why As returned by the reader.
 * @returns {string[]} The reasons that matched nothing, so they can be shown rather than
 *   silently dropped - a key spelled wrongly is exactly when the reason is worth reading.
 */
export function attachReasons(changes, why) {
    if (!why || typeof why !== 'object' || Array.isArray(why)) return [];

    const remaining = new Map();
    for (const [key, text] of Object.entries(why)) {
        const clause = String(text ?? '').trim();
        if (clause) remaining.set(reasonKey(key), clause);
    }

    // Qualified first, so a bare label cannot claim a row a fuller key was meant for.
    for (const pass of [0, 1]) {
        for (const change of changes || []) {
            if (change.note) continue;
            const keys = reasonKeysFor(change);
            const key = pass === 0 ? keys[0] : keys[1];
            if (!key || !remaining.has(key)) continue;
            change.note = remaining.get(key);
            remaining.delete(key);
        }
    }

    return [...remaining.values()];
}

export function partitionChanges(changes, trackerSettings) {
    const mode = trackerSettings.reviewMode || 'risky';
    if (mode === 'off') return { auto: changes, pending: [] };
    if (mode === 'all') return { auto: [], pending: changes };
    return {
        auto: changes.filter(c => c.risk !== 'risky'),
        pending: changes.filter(c => c.risk === 'risky'),
    };
}

/**
 * Rebuilds a minimal update object from a set of accepted changes.
 *
 * Feeding the result back through applyUpdate keeps every accepted row on the normal
 * validation path rather than writing to the state directly.
 *
 * @param {Array<object>} changes Accepted rows, each optionally carrying an edited `after`.
 * @param {object} currentState Needed to rebuild whole collections around a single item.
 * @param {object} trackerSettings
 */
export function buildUpdateFromChanges(changes, currentState, trackerSettings, cards = []) {
    const update = {};
    /** Collections are rebuilt in full and marked as a replacement when they are written. */
    const collectionWork = new Map();

    const actorOf = (change) => {
        if (change.scope === 'player') return currentState?.player;
        if (change.scope !== 'character') return null;

        const inScene = (currentState?.characters || [])
            .find(c => String(c.name).toLowerCase() === String(change.actor).toLowerCase());
        if (inScene) return inScene;

        // Off stage. Their card is where their belongings live, and rebuilding a
        // collection without it would replace everything they own with the single row
        // being accepted.
        const card = (cards || [])
            .find(c => String(c.name || '').toLowerCase() === String(change.actor).toLowerCase());
        return card ? { name: card.name, collections: card.statusCollections || {} } : null;
    };

    for (const change of changes) {
        if (change.kind === 'stat' || change.kind === 'stat-max') {
            // Re-join the halves so a max-only acceptance does not drop the current value.
            const live = change.scope === 'global'
                ? currentState?.global?.[change.label]
                : actorOf(change)?.stats?.[change.label];
            const parts = splitValue(live);
            const value = change.kind === 'stat'
                ? (parts.max ? `${change.after}/${parts.max}` : String(change.after))
                : (change.after && change.after !== '(none)' ? `${parts.current}/${change.after}` : parts.current);

            if (change.scope === 'global') {
                update.global ||= {};
                update.global[change.label] = value;
            } else if (change.scope === 'player') {
                update.player ||= {}; update.player.stats ||= {};
                update.player.stats[change.label] = value;
            } else {
                update.characters ||= [];
                let entry = update.characters.find(c => c.name === change.actor);
                if (!entry) { entry = { name: change.actor, stats: {} }; update.characters.push(entry); }
                entry.stats[change.label] = value;
            }
            continue;
        }

        // Item rows: gather per actor+collection, resolve once below.
        //
        // Keyed on the destination the row carries, not the one it was proposed with, so
        // moving a row from inventory to spells rebuilds spells and leaves inventory
        // alone - the old collection is never named, so it is never replaced.
        const mapKey = `${change.scope}|${change.actor || ''}|${change.collectionId}`;
        if (!collectionWork.has(mapKey)) collectionWork.set(mapKey, { change, rows: [] });
        collectionWork.get(mapKey).rows.push(change);
    }

    for (const [, { change: sample, rows }] of collectionWork) {
        const actor = actorOf(sample);
        const colDef = (trackerSettings.collections || []).find(c => c.id === sample.collectionId);
        const primary = primaryFieldName(colDef);
        const items = (actor?.collections?.[sample.collectionId] || []).map(i => ({ ...i }));

        for (const row of rows) {
            const key = itemKey(row.item, primary);
            const index = items.findIndex(i => itemKey(i, primary) === key);
            if (row.kind === 'item-add' && index === -1) items.push({ ...row.item });
            else if (row.kind === 'item-remove' && index !== -1) items.splice(index, 1);
            else if (row.kind === 'item-change' && index !== -1) items[index][row.field] = row.after;
        }

        // Marked as a replacement, not left as a bare list. A bare list is read as
        // additions - which is right for a model that ignored the delta format, and
        // exactly wrong here, where the rows have been reviewed and the list is the
        // answer, removals included.
        const rebuilt = { replace: items };

        if (sample.scope === 'player') {
            update.player ||= {}; update.player.collections ||= {};
            update.player.collections[sample.collectionId] = rebuilt;
        } else {
            update.characters ||= [];
            let entry = update.characters.find(c => c.name === sample.actor);
            if (!entry) { entry = { name: sample.actor }; update.characters.push(entry); }
            entry.collections ||= {};
            entry.collections[sample.collectionId] = rebuilt;
        }
    }

    return update;
}
