import { getSettings } from './settings.js';
import { debugLog } from './constants.js';
import { loadStateFromMetadata, applyUpdate, saveStateToMetadata } from './status-logic.js';
import { splitValue, buildUpdateFromChanges } from './status-diff.js';
import { parseClock, elapsedMinutes, describeDuration, DAY_MINUTES } from './status-clock.js';

/**
 * What the passage of time does on its own.
 *
 * Energy recovering while the party rests is not something to read out of prose - it is
 * arithmetic on a clock the narrator already wrote. Asking a model to do it gives a
 * different answer on every swipe and costs tokens forever; doing it here gives the same
 * answer every time and costs nothing.
 *
 * Rules are deliberately small: an amount per interval, optionally gated on another
 * stat. That covers passive regeneration and rest-only regeneration, which is most
 * systems, without anyone having to learn a formula language to configure it.
 */

/** Where the last reading of the clock is kept, so elapsed time survives a reload. */
const CLOCK_KEY = 'clock';

const asNumber = (value) => {
    const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
    return match ? parseFloat(match[0]) : null;
};

/**
 * Does the gate hold for this actor?
 *
 * Looks at the actor's own stats first and then the world's, so a rule can be gated on
 * "Condition is Resting" or on "Location is Camp" without saying which it meant. The
 * match is a case-insensitive substring, because a narrator writes "Resting (light
 * sleep)" and means resting.
 */
function conditionHolds(rule, actor, state) {
    const statName = String(rule.conditionStat ?? '').trim();
    if (!statName) return true;

    const wanted = String(rule.conditionValue ?? '').trim().toLowerCase();
    const findStat = (stats) => {
        if (!stats) return undefined;
        const key = Object.keys(stats).find(k => k.toLowerCase() === statName.toLowerCase());
        return key === undefined ? undefined : stats[key];
    };

    const actual = findStat(actor?.stats) ?? findStat(state?.global);
    if (actual === undefined) return false;
    if (!wanted) return String(actual).trim() !== '';
    return String(actual).toLowerCase().includes(wanted);
}

/** Everyone a rule applies to, as { actor, scope, name } entries. */
function targetsFor(rule, state) {
    if (rule.scope === 'global') return [{ actor: null, scope: 'global', name: null }];
    if (rule.scope === 'characters') {
        return (state.characters || []).map(c => ({ actor: c, scope: 'character', name: c.name }));
    }
    return [{ actor: state.player, scope: 'player', name: null }];
}

/** The stat value a rule reads and writes. */
function readStat(rule, target, state) {
    if (rule.scope === 'global') return state.global?.[rule.stat];
    return target.actor?.stats?.[rule.stat];
}

/**
 * The ceiling actually in play: the value's own denominator, and nothing else.
 *
 * It used to fall back to the configured maximum, which is a starting value - so a stat
 * whose ceiling had been cleared went on being clamped to a number nothing displayed and
 * nobody could change. Regeneration stopping at an invisible limit is the sort of thing
 * that reads as the rule being broken rather than as a setting still applying.
 */
function ceilingFor(rule, live) {
    return asNumber(splitValue(live).max);
}

/** The floor, if the schema names one. */
function floorFor(rule, trackerSettings) {
    const schema = rule.scope === 'global' ? trackerSettings.globalStats
        : rule.scope === 'characters' ? trackerSettings.npcStats
            : trackerSettings.playerStats;
    const statDef = (schema || []).find(s => s.name === rule.stat);
    return asNumber(statDef?.min);
}

/**
 * How much time this message is worth, and the anchor to store afterwards.
 *
 * Measured against the last clock actually read rather than the previous message, so a
 * run of unparseable values does not lose the thread: "05:30 AM", "Morning", "Morning
 * (before first bell)", "07:00 AM" is ninety minutes, not nothing.
 *
 * @returns {{ minutes: number, capped: boolean, anchor: object|null, raw: string }}
 */
function measureElapsed(state, trackerSettings, messageId) {
    const clockStat = trackerSettings.clockStat || 'Time';
    const raw = state.global?.[clockStat];
    const current = parseClock(raw);

    const stored = state[CLOCK_KEY];
    // Already paid for this message. A re-render or a swipe must not pay twice.
    if (stored && String(stored.messageId) === String(messageId)) {
        return { minutes: 0, capped: false, anchor: null, raw: String(raw ?? '') };
    }

    if (!current) {
        // Not a clock. Leave the anchor alone so the next real timestamp still measures
        // from the last real one.
        return { minutes: 0, capped: false, anchor: null, raw: String(raw ?? '') };
    }

    const previous = stored ? { minutes: stored.minutes, kind: stored.kind } : null;
    const rawElapsed = elapsedMinutes(previous, current);

    const cap = Math.max(0, Number(trackerSettings.clockMaxElapsedMinutes ?? DAY_MINUTES));
    const capped = cap > 0 && rawElapsed > cap;
    const minutes = capped ? cap : rawElapsed;

    return {
        minutes,
        capped,
        anchor: { minutes: current.minutes, kind: current.kind, raw: String(raw ?? ''), messageId: String(messageId) },
        raw: String(raw ?? ''),
    };
}

/**
 * Works out what elapsed time changes, without changing anything.
 *
 * Returns rows in the same shape computeStateDiff produces, so they apply and record
 * through the machinery that already exists.
 *
 * @param {object} state Current state, after the message's own update has landed.
 * @param {string|number} messageId
 * @returns {{ rows: object[], minutes: number, capped: boolean, anchor: object|null }}
 */
function evaluateTimeRules(state, messageId) {
    const trackerSettings = getSettings().statusTracker;

    /* A rule whose stat has been deleted from the system is dead, and had to be said out
       loud: readStat reaches into the stored state, where the deleted value is still
       sitting, so the rule went on regenerating a number nobody could see and writing a
       history entry for it every time the clock moved. */
    const declaredIn = (scope) => new Set(
        (trackerSettings[scope === 'global' ? 'globalStats'
            : scope === 'characters' ? 'npcStats' : 'playerStats'] || [])
            .map(s => String(s?.name ?? '').trim().toLowerCase()).filter(Boolean));

    const rules = (trackerSettings.timeRules || []).filter(r =>
        r && r.enabled !== false && r.stat
        && declaredIn(r.scope).has(String(r.stat).trim().toLowerCase()));

    const { minutes, capped, anchor, raw } = measureElapsed(state, trackerSettings, messageId);
    if (!rules.length || minutes <= 0) return { rows: [], minutes, capped, anchor };

    const carry = { ...(state[CLOCK_KEY]?.carry || {}) };
    const rows = [];

    for (const rule of rules) {
        const interval = Math.max(1, Number(rule.perMinutes) || 0);
        const amount = Number(rule.amount);
        if (!Number.isFinite(amount) || amount === 0) continue;

        for (const target of targetsFor(rule, state)) {
            const carryKey = `${rule.id}|${target.name || rule.scope}`;

            /* Before the time is banked, not after it is spent. Time spent outside the
               condition is spent, not banked - otherwise a character who rests for a
               minute is paid for the hour they spent fighting.

               This used to sit below the tick calculation, where it could only be reached
               once a whole interval had accumulated. Messages are almost always shorter
               than an interval, so the usual path banked the elapsed time and moved on
               without ever asking - and fifty minutes of fighting paid out on the first
               ten minutes of rest. */
            if (!conditionHolds(rule, target.actor, state)) {
                carry[carryKey] = 0;
                continue;
            }

            const available = minutes + (Number(carry[carryKey]) || 0);
            const ticks = Math.floor(available / interval);

            if (ticks <= 0) { carry[carryKey] = available; continue; }
            carry[carryKey] = available - ticks * interval;

            const live = readStat(rule, target, state);
            const parts = splitValue(live);
            const before = asNumber(parts.current);
            if (before === null) continue;

            const ceiling = ceilingFor(rule, live);
            const floor = floorFor(rule, trackerSettings);

            let after = before + ticks * amount;
            if (ceiling !== null && after > ceiling) { after = ceiling; carry[carryKey] = 0; }
            if (floor !== null && after < floor) { after = floor; carry[carryKey] = 0; }
            if (after === before) continue;

            rows.push({
                scope: target.scope,
                actor: target.name,
                label: rule.stat,
                kind: 'stat',
                before: String(before),
                after: String(after),
                risk: 'normal',
                reason: describeReason(rule, minutes, capped),
            });
        }
    }

    const nextAnchor = anchor ? { ...anchor, carry } : null;
    if (rows.length) {
        debugLog(`Time rules: ${describeDuration(minutes)} elapsed`, rows.map(r => `${r.label} ${r.before}->${r.after}`));
    }
    return { rows, minutes, capped, anchor: nextAnchor, raw };
}

function describeReason(rule, minutes, capped) {
    const rate = `${rule.amount > 0 ? '+' : ''}${rule.amount} per ${describeDuration(rule.perMinutes)}`;
    const base = `${describeDuration(minutes)} elapsed (${rate})`;
    return capped ? `${base}; time skip trimmed to the per-message limit` : base;
}

/**
 * Works out what elapsed time did, applies it, and remembers where the clock got to.
 *
 * Called once the message's own update has landed, so the clock has already moved.
 * Regeneration applies as its own `applyUpdate` rather than being folded into the story's
 * changes, so it can be undone on its own - reversing a regeneration should not reverse
 * the blow that was struck in the same message.
 *
 * The anchor is stored whether or not anything regenerated. It is what makes elapsed time
 * measurable at all, and what stops a re-render or a swipe paying twice.
 *
 * @param {string|number} messageId
 * @returns {{ rows: object[], minutes: number, capped: boolean }}
 */
export function applyTimeRules(messageId) {
    const trackerSettings = getSettings().statusTracker;
    const state = loadStateFromMetadata();

    const { rows, minutes, capped, anchor } = evaluateTimeRules(state, messageId);

    if (rows.length) {
        applyUpdate(buildUpdateFromChanges(rows, state, trackerSettings),
            { label: 'Time', partOfMessage: true });
    }

    if (anchor) {
        // After the update, or applyUpdate's own write would drop it. Not a history
        // entry of its own: reading the clock is bookkeeping, not a change to undo.
        const fresh = loadStateFromMetadata();
        fresh[CLOCK_KEY] = anchor;
        saveStateToMetadata(fresh, { recordHistory: false });
    }

    return { rows, minutes, capped };
}

export { CLOCK_KEY };
