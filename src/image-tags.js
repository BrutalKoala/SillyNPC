/**
 * Which of a character's pictures means which field value.
 *
 * A card can hold a dozen portraits and `imageUrl` names the one in use. This says what
 * the others are *for*: "this one is Elza wounded", "this one is Elza calm". A tag is a
 * fact about the card, so it lives on the card - beside the picture it describes, carried
 * by every copy of the settings, and removed when the picture is.
 *
 * Nothing in SillyNPC acts on a tag. Deciding *which* field wins when two of them name a
 * picture is policy, and policy belongs to whatever is asking - see registerImageTagFields.
 * This module answers only the question it owns: given a field and a value, which picture.
 *
 * Imports settings and nothing else, so the whole of it runs in the Node harness.
 */

import { getSettings, saveSettings } from './settings.js';

/**
 * Who wants pictures tagged, and by which fields.
 *
 * SillyNPC has no use for tags of its own, so the character page draws no tagging control
 * until something registers an interest. That is the whole reason it is a registration
 * rather than a check for a particular extension: this file is told "these fields want
 * tagging", never "such-and-such is installed", so no addon's name appears here and the
 * next one to want the same thing needs no edit. A check in the test suite asserts that
 * nothing in SillyNPC names an addon, because a comment is the first step towards code.
 *
 * A function rather than a list, because the fields are a setting on the other side and
 * asking each time is the difference between a live answer and a copy taken at load.
 *
 * @type {(() => string[]) | null}
 */
let fieldProvider = null;

/**
 * @param {(() => string[]) | null} provider Ordered field names, or null to withdraw.
 */
export function registerImageTagFields(provider) {
    fieldProvider = typeof provider === 'function' ? provider : null;
}

/**
 * The fields pictures should be tagged by, in the order whoever registered wants them.
 *
 * Empty when nothing has registered, which every caller reads as "draw no control".
 *
 * @returns {string[]}
 */
export function taggedFields() {
    if (!fieldProvider) return [];
    try {
        const fields = fieldProvider();
        return Array.isArray(fields) ? fields.filter(f => typeof f === 'string' && f) : [];
    } catch {
        // A broken provider must not take the character page down with it.
        return [];
    }
}

/** The tag map, created only when something is actually being written into it. */
function tagsFor(char, { create = false } = {}) {
    if (!char) return null;
    if (!char.imageTags || typeof char.imageTags !== 'object') {
        if (!create) return null;
        char.imageTags = {};
    }
    return char.imageTags;
}

/**
 * What this picture means for this field, or '' when it means nothing.
 *
 * @param {object} char
 * @param {string} path One of char.images.
 * @param {string} field A stat name.
 * @returns {string}
 */
export function getImageTag(char, path, field) {
    if (!path || !field) return '';
    const value = tagsFor(char)?.[path]?.[field];
    return typeof value === 'string' ? value : '';
}

/**
 * Says what this picture means, or unsays it.
 *
 * An empty value clears the tag, and clearing the last one on a picture takes the
 * picture's entry with it - so a card nobody has tagged carries no key rather than a tree
 * of empty objects, and the settings file does not grow a map per portrait per character
 * for a feature nobody turned on.
 *
 * @param {object} char
 * @param {string} path
 * @param {string} field
 * @param {string} value '' to clear.
 * @returns {boolean} Whether anything changed.
 */
export function setImageTag(char, path, field, value) {
    if (!char || !path || !field) return false;

    const clean = String(value ?? '').trim();
    const existing = getImageTag(char, path, field);
    if (existing === clean) return false;

    if (!clean) {
        const tags = tagsFor(char);
        if (!tags?.[path]) return false;
        delete tags[path][field];
        if (Object.keys(tags[path]).length === 0) delete tags[path];
        if (Object.keys(tags).length === 0) delete char.imageTags;
    } else {
        const tags = tagsFor(char, { create: true });
        if (!tags[path] || typeof tags[path] !== 'object') tags[path] = {};
        tags[path][field] = clean;
    }

    saveSettings();
    return true;
}

/**
 * The picture this card wears when `field` holds `value`, or '' when none does.
 *
 * **Gallery order decides**, when two pictures carry the same tag. That is the order the
 * carousel steps through and the order the tag grid draws in, so which one wins is
 * something the reader can see rather than something they have to know - and it is stable,
 * where iterating the tag map would depend on the order the tags happened to be written.
 *
 * Case-insensitive on the value, matching how stored stat keys are looked up everywhere
 * else here: the model writes "Wounded" and "wounded" on different days.
 *
 * @param {object} char
 * @param {string} field
 * @param {string} value
 * @returns {string} A path from char.images, or ''.
 */
export function imageForTag(char, field, value) {
    const wanted = String(value ?? '').trim().toLowerCase();
    if (!char || !field || !wanted) return '';

    const tags = tagsFor(char);
    if (!tags) return '';

    for (const path of Array.isArray(char.images) ? char.images : []) {
        const tagged = tags[path]?.[field];
        if (typeof tagged === 'string' && tagged.trim().toLowerCase() === wanted) return path;
    }
    return '';
}

/**
 * Drops every tag on a picture that is no longer on the card.
 *
 * Called from removeCharacterImage rather than left to a sweep: the tag map is keyed by
 * path, so a stale entry would come back to life the moment the same file was adopted
 * again - and adopting the same file again is the ordinary case, since removing a picture
 * from a character does not delete it.
 *
 * @param {object} char
 * @param {string} path
 * @returns {boolean} Whether anything was removed.
 */
export function forgetImageTags(char, path) {
    const tags = tagsFor(char);
    if (!tags || !path || !tags[path]) return false;

    delete tags[path];
    if (Object.keys(tags).length === 0) delete char.imageTags;
    return true;
}

/**
 * The values a tagging control should offer for a field.
 *
 * Only character stats, and only ones with an Allowed values list. A field whose values
 * are not enumerated has no list to tag against - you cannot say "this picture is the
 * angry one" when anything at all counts as a value - which is why the picker on the other
 * side offers only these in the first place. Asked here too so the control cannot be
 * handed a field it has no options for.
 *
 * @param {string} field
 * @returns {string[]}
 */
export function valuesForField(field) {
    const stats = getSettings().statusTracker?.npcStats || [];
    const stat = stats.find(s => String(s?.name ?? '') === field);
    return Array.isArray(stat?.options) ? stat.options.filter(Boolean).map(String) : [];
}
