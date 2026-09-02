import { getSettings } from './settings.js';

/**
 * Which labels are not people.
 *
 * Lived in chat.js, where only the chat decorator could reach it - so a name you had
 * excluded was still admitted to the tracker's cast by the extractor, which reports
 * whoever it thinks is present without consulting the setting at all. status-logic.js
 * needs it now and cannot import chat.js, because chat.js imports status-logic.js.
 *
 * Nothing here reaches for the DOM or the chat, so it can be imported from anywhere.
 */

/**
 * Labels that must never be mistaken for a speaker.
 *
 * The speaker test is "bold or italic, followed by a colon", which is exactly how a
 * tabletop narrator writes a roll: "**Cost**: 3 Energy", "**DC**: 15". Those became
 * characters with default avatars, and since a detected speaker is reported as present,
 * they joined the tracker's cast as well.
 *
 * Two sources, because they cover different halves of the problem. Anything you named in
 * System Builder is a property of a character rather than a character, so every configured
 * stat and collection is excluded automatically - that is what stops a stat literally
 * called "Defense Difficulty:" being read as somebody speaking. The rest are terms the
 * narrator uses that the extension has no way to know about, so they are yours to list.
 *
 * Only unknown labels are tested. A name with a card is always a speaker, so a character
 * genuinely called "Guide" is unaffected by "guide" appearing here.
 *
 * @returns {Set<string>} Normalised labels.
 */
export function getIgnoredSpeakerLabels() {
    const settings = getSettings();
    const tracker = settings.statusTracker || {};
    const labels = new Set();

    const add = (raw) => {
        const name = normaliseSpeakerLabel(raw);
        if (name) labels.add(name);
    };

    for (const key of ['globalStats', 'playerStats', 'npcStats']) {
        for (const stat of tracker[key] || []) add(stat?.name);
    }
    for (const collection of tracker.collections || []) {
        add(collection?.id);
        add(collection?.name);
        for (const field of collection?.fields || []) add(field?.name);
    }
    for (const word of String(settings.speakerIgnoreList || '').split(/[\n,]/)) add(word);

    return labels;
}

/** Trims a label down to what it would be called, so "Attack Difficulty: " matches "Attack Difficulty". */
export function normaliseSpeakerLabel(raw) {
    return String(raw ?? '').trim().replace(/[:：\s]+$/, '').trim().toLowerCase();
}
