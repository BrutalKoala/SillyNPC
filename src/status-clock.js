/**
 * Reading the narrator's clock.
 *
 * The story already keeps time - "14 January 2012, 05:30 AM" becomes "06:15 AM" a
 * message later - and nothing ever read it. Turning that into elapsed minutes is what
 * lets the extension compute regeneration itself instead of asking a language model to
 * do date arithmetic it will get wrong on a swipe.
 *
 * Date.parse alone is not safe here. It reads "Day 3, 14:20" as March 2001 and "Day 4"
 * as April, so a single in-fiction day would measure as thirty-one and silently refill
 * every regenerating stat in the game. The explicit patterns are therefore tried first,
 * and Date.parse only sees strings that actually carry a date.
 *
 * Everything here is deliberately willing to fail. "Morning" is not a clock, and
 * returning null for it is the right answer - no elapsed time, no regeneration - rather
 * than guessing a number.
 */

/** Minutes in a day. */
export const DAY_MINUTES = 1440;

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december'
    + '|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';

/** "Day 3", "day 12 -", but not "Tuesday" or "someday". */
const DAY_PATTERN = /(?:^|[^a-z])day\s*[#:]?\s*(\d{1,5})\b/i;

/** "05:30 AM", "14:20", "5:30pm". Seconds are accepted and ignored. */
const TIME_PATTERN = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\b/i;

/** A bare "3 PM" with no colon. */
const HOUR_ONLY_PATTERN = /\b(\d{1,2})\s*(am|pm)\b/i;

/** Anything that looks like a real date, and is therefore safe to hand to Date.parse. */
const LOOKS_DATED = new RegExp(`(${MONTHS})|\\d{1,4}[/-]\\d{1,2}[/-]\\d{1,4}`, 'i');

/**
 * Minutes since midnight, or null when the text carries no time of day.
 * @param {string} text
 * @returns {number|null}
 */
function timeOfDayMinutes(text) {
    const withColon = TIME_PATTERN.exec(text);
    if (withColon) {
        let hours = parseInt(withColon[1], 10);
        const minutes = parseInt(withColon[2], 10);
        const meridiem = withColon[3]?.toLowerCase();
        if (hours > 23 || minutes > 59) return null;
        if (meridiem === 'pm' && hours < 12) hours += 12;
        if (meridiem === 'am' && hours === 12) hours = 0;
        return hours * 60 + minutes;
    }

    const hourOnly = HOUR_ONLY_PATTERN.exec(text);
    if (hourOnly) {
        let hours = parseInt(hourOnly[1], 10);
        if (hours > 12) return null;
        const meridiem = hourOnly[2].toLowerCase();
        if (meridiem === 'pm' && hours < 12) hours += 12;
        if (meridiem === 'am' && hours === 12) hours = 0;
        return hours * 60;
    }

    return null;
}

/**
 * Reads a clock value into an absolute minute count.
 *
 * `kind` matters to the caller: an absolute clock can be subtracted from any other
 * absolute clock, while a bare time of day only says where in the day it is, so
 * comparing two of them needs a rule about midnight.
 *
 * @param {string} text
 * @returns {{ minutes: number, kind: 'day'|'date'|'time' }|null}
 */
export function parseClock(text) {
    const value = String(text ?? '').trim();
    if (!value) return null;

    // First, because Date.parse turns "Day 3" into a month.
    const day = DAY_PATTERN.exec(value);
    if (day) {
        const dayNumber = parseInt(day[1], 10);
        // Day 1 is the first day, so it starts at zero.
        const base = Math.max(0, dayNumber - 1) * DAY_MINUTES;
        return { minutes: base + (timeOfDayMinutes(value) ?? 0), kind: 'day' };
    }

    // Only strings that actually carry a date, so prose cannot fall through to a
    // plausible-looking but invented timestamp.
    if (LOOKS_DATED.test(value)) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return { minutes: Math.floor(parsed / 60000), kind: 'date' };
    }

    const timeOnly = timeOfDayMinutes(value);
    if (timeOnly !== null) return { minutes: timeOnly, kind: 'time' };

    // "Morning", "Before first bell", "Later that evening". Not a clock.
    return null;
}

/**
 * Minutes between two parsed clocks.
 *
 * A clock that runs backwards pays nothing. A flashback, a retcon or a model slip must
 * never be worth free regeneration, and refusing to pay is always recoverable where
 * paying twice is not.
 *
 * Two bare times are the one exception: going backwards there almost always means the
 * next morning, so it rolls over. The caller's per-message cap is what bounds the damage
 * when that guess is wrong.
 *
 * @param {{minutes: number, kind: string}|null} previous
 * @param {{minutes: number, kind: string}|null} current
 * @returns {number} Elapsed minutes, never negative.
 */
export function elapsedMinutes(previous, current) {
    if (!previous || !current) return 0;

    const delta = current.minutes - previous.minutes;
    if (delta >= 0) return delta;

    if (previous.kind === 'time' && current.kind === 'time') {
        return delta + DAY_MINUTES;
    }

    return 0;
}

/** A rough "45 minutes" / "2 hours 5 minutes", for change records and logs. */
export function describeDuration(minutes) {
    const total = Math.max(0, Math.round(minutes));
    if (total < 60) return `${total} minute${total === 1 ? '' : 's'}`;

    const hours = Math.floor(total / 60);
    const rest = total % 60;
    if (hours < 24) {
        return rest ? `${hours}h ${rest}m` : `${hours} hour${hours === 1 ? '' : 's'}`;
    }

    const days = Math.floor(hours / 24);
    const spareHours = hours % 24;
    return spareHours ? `${days}d ${spareHours}h` : `${days} day${days === 1 ? '' : 's'}`;
}
