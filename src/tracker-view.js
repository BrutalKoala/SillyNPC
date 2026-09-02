/**
 * How much of the tracker box is on screen right now.
 *
 * Deliberately not a setting. Turning the box off in the menu turns off the whole Status
 * Tracker - the prompt injection, the chat decorations, the scan button - because that is
 * what `statusTracker.enabled` means. This answers the smaller question of what to draw,
 * it is expected to be flicked back and forth while reading, and it resets on reload, so
 * writing it to settings.json would put a session's worth of churn through a ~1 MB
 * serialize for something nobody wants remembered.
 *
 * No imports on purpose: settings.js, status-ui.js and chat.js all reach for this, and it
 * has nothing to say back to any of them.
 */

/** Full box, header only, nothing - in the order the eye cycles through them. */
export const TRACKER_VIEWS = ['full', 'globals', 'hidden'];

let current = 'full';

/**
 * @returns {'full'|'globals'|'hidden'}
 */
export function getTrackerView() {
    return current;
}

/**
 * @param {string} view Anything unrecognised falls back to the full box.
 */
export function setTrackerView(view) {
    current = TRACKER_VIEWS.includes(view) ? view : 'full';
}

/**
 * The next state in the cycle.
 *
 * An unrecognised state lands on 'full' rather than staying put, so a click always does
 * something: a control that can get stuck is worse than one that starts over.
 *
 * @param {string} view
 * @returns {'full'|'globals'|'hidden'}
 */
export function nextTrackerView(view) {
    // -1 for an unrecognised state, which +1 lands on the first one. An explicit guard
    // for that case said the same thing twice; this is the line that decides it.
    const at = TRACKER_VIEWS.indexOf(view);
    return TRACKER_VIEWS[(at + 1) % TRACKER_VIEWS.length];
}

/** Reset, for tests and for a fresh session. */
export function resetTrackerView() {
    current = 'full';
}
