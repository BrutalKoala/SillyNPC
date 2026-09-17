/**
 * The string hashes the extension uses, one copy of each.
 *
 * There are three recipes here and not one, on purpose. Each of them already decides
 * something a person can see or relies on - which shade a speaker is drawn in, which
 * fallback face a stranger wears, whether a redraw can be skipped - and swapping one recipe
 * for another would quietly recolour and re-face everybody in every existing chat. So they
 * were gathered into one file without changing a single result, and each says what it is
 * for.
 *
 * Imports nothing, so anything can use it.
 */

/**
 * FNV-1a, 32 bits, as an unsigned number. Spreads a change of one character well.
 * Used to fingerprint image URLs for the chat redraw signature.
 *
 * @param {string} text
 * @returns {number}
 */
export function fnv1a(text) {
    const value = String(text ?? '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * `hash * 31 + c`, kept to 32 signed bits. Used for a stranger's steady fallback face.
 *
 * @param {string} text
 * @returns {number} May be negative; take Math.abs before using it as an index.
 */
export function hash31(text) {
    const value = String(text ?? '');
    let hash = 0;
    for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
    return hash;
}

/**
 * djb2 (`hash * 33 + c`), 32 signed bits. Used to spot a saved state that has not changed.
 *
 * @param {string} text
 * @returns {number}
 */
export function djb2(text) {
    const value = String(text ?? '');
    let hash = 5381;
    for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
    return hash;
}

/**
 * The palette index a name starts from: `index * 31 + code point`, reduced as it goes.
 *
 * By code point rather than UTF-16 unit, which is not the same as hash31 for a name with a
 * character outside the basic plane - and names can carry emoji. Kept exactly as it was
 * for that reason.
 *
 * @param {string} name
 * @param {number} size The palette's length.
 * @returns {number} 0 .. size - 1, or 0 for an empty palette.
 */
export function paletteIndexFor(name, size) {
    if (!(size > 0)) return 0;
    let index = 0;
    for (const ch of String(name ?? '')) {
        index = (index * 31 + ch.codePointAt(0)) % size;
    }
    return index;
}
