/**
 * "Redraw every message in the chat."
 *
 * The redraw itself lives in index.js, which owns the chat; this is only the handle other
 * modules reach for. It sat in chat.js, which meant asking for a redraw meant importing
 * chat.js - and the panels that most need one cannot, because chat.js imports them. The
 * cast panel is reached as chat.js -> status-ui.js -> ui-cast-panel.js, so deciding
 * somebody is you could not repaint the chat that shows them.
 *
 * Nothing here imports anything, so it can be imported from anywhere. chat.js re-exports
 * both functions, since every existing caller already asks it for them.
 */

let onReprocessMessages = () => {};

/** Redraws every message, so a decision made in a panel shows in the chat at once. */
export function triggerReprocess() {
    onReprocessMessages();
}

/** @param {() => void} callback */
export function setReprocessCallback(callback) {
    onReprocessMessages = callback;
}
