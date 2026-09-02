import { LOG_PREFIX, IMAGE_MAX_DIMENSION, IMAGE_PORTRAIT_MAX_DIMENSION, IMAGE_JPEG_QUALITY, debugLog } from './constants.js';
import { getContext } from '../../../../st-context.js';
import { getSecretLabelById, resolveSecretKey, secret_state } from '../../../../secrets.js';

/**
 * Which connection, model and key the *chat* is about to use.
 *
 * SillyTavern never logs this, and a normal generation sends no secret_id at all - the
 * server falls back to whichever secret is marked active - so there was no way to compare
 * the chat against SillyNPC's own requests. Seeing one without the other is what made two
 * profiles that shared a key look like they were separated.
 *
 * Read the same way the server resolves it: the active entry for whatever secret key the
 * current API maps to. The value SillyTavern hands the browser is already masked.
 *
 * @returns {string}
 */
export function describeChatConnection() {
    const context = getContext();
    const source = context?.chatCompletionSettings?.chat_completion_source || context?.mainApi || 'unknown API';
    let model = '';
    try { model = context?.getChatCompletionModel?.() || ''; } catch { model = ''; }

    const secretKey = resolveSecretKey();
    const saved = secretKey ? secret_state?.[secretKey] : null;
    const active = Array.isArray(saved) ? saved.find(s => s?.active) : null;
    const key = active
        ? `${active.label}${active.value ? ` (${active.value})` : ''}`
        : 'none saved';

    return `Chat -> ${source}${model ? ` / ${model}` : ''}, key: ${key}`;
}

/**
 * Which connection, model and API key a request will actually use.
 *
 * Written for the console, because the panel could only ever say what the *next* request
 * would do. A user running two Google profiles to separate chat from lore spent an evening
 * on it: both profiles pinned the same secret-id, so choosing between them changed the
 * model and nothing else, and nothing anywhere said so.
 *
 * The key label comes from SillyTavern already masked - it is what the Connection Manager
 * shows in its own profile details - so the real key never reaches the console.
 *
 * @param {string} profileId
 * @param {object} [options]
 * @param {boolean} [options.includeModel=true] Portraits take only the key from their
 *   profile - the image model is chosen separately, and naming the profile's text model
 *   beside it reads as two models for one request.
 * @returns {string}
 */
export function describeConnection(profileId, { includeModel = true } = {}) {
    if (!profileId) return 'main API (same as chat), key: whichever is active';

    const profiles = getContext()?.extensionSettings?.connectionManager?.profiles;
    const profile = Array.isArray(profiles) ? profiles.find(p => p?.id === profileId) : null;
    // A profile deleted since it was chosen is the case most likely to look like a bug, so
    // it is named rather than quietly reported as the main API.
    if (!profile) return `profile ${profileId} is missing, so the main API was used`;

    const secretId = profile['secret-id'];
    const keyLabel = secretId ? getSecretLabelById(secretId) : '';
    const key = keyLabel || (secretId ? secretId : 'whichever is active');
    return includeModel
        ? `${profile.name || profileId}${profile.model ? ` / ${profile.model}` : ''}, key: ${key}`
        : `key: ${key} (from "${profile.name || profileId}")`;
}


export function makeId() {
    return (crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/**
 * Load a File into an HTMLImageElement.
 * @param {File} file
 * @returns {Promise<HTMLImageElement>}
 */
function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = String(reader.result);
        };
        reader.readAsDataURL(file);
    });
}

/**
 * Downscale an image to fit within IMAGE_MAX_DIMENSION on its longer side.
 * Uses PNG for files that might have transparency, otherwise JPEG for size.
 * @param {HTMLImageElement} img
 * @param {boolean} usePng
 * @returns {string} data URI
 */
function downscaleImage(img, usePng = false, max = IMAGE_MAX_DIMENSION) {
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    if (usePng) {
        return canvas.toDataURL('image/png');
    }
    return canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);
}

/**
 * @param {object} [options]
 * @param {boolean} [options.fullSize=false] Keep portrait resolution rather than shrinking
 *   to the thumbnail cap. For images written to disk, where the small cap only ever cost
 *   quality; leave it off for anything stored inline in settings.json.
 */
export async function pickAndProcessImage({ fullSize = false } = {}) {
    const picked = await pickAndProcessImages({ fullSize, multiple: false });
    return picked[0] ?? null;
}

/**
 * The same, for as many files as the user cares to choose at once.
 *
 * Filling a pool of fallback faces one file at a time is six trips through the file
 * dialog to do one thing.
 *
 * One bad file does not lose the rest: each is read on its own and the ones that fail are
 * counted rather than thrown, since a folder of pictures may well hold something that is
 * not one.
 *
 * @param {object} [options]
 * @param {boolean} [options.fullSize=false] See pickAndProcessImage.
 * @param {boolean} [options.multiple=true]
 * @returns {Promise<string[]>} Data URIs, in the order chosen.
 */
export async function pickAndProcessImages({ fullSize = false, multiple = true } = {}) {
    return new Promise(resolve => {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        if (multiple) fileInput.multiple = true;
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', async () => {
            const files = Array.from(fileInput.files || []);
            fileInput.remove();
            if (!files.length) return resolve([]);

            const cap = fullSize ? IMAGE_PORTRAIT_MAX_DIMENSION : IMAGE_MAX_DIMENSION;
            const out = [];
            let failed = 0;
            for (const file of files) {
                try {
                    const img = await loadImageFromFile(file);
                    const usePng = file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/gif';
                    out.push(downscaleImage(img, usePng, cap));
                } catch (err) {
                    failed++;
                    console.error(LOG_PREFIX, 'image load failed', file?.name, err);
                }
            }
            if (failed) {
                toastr.error(
                    files.length === 1 ? 'Could not read that image.'
                        : `Could not read ${failed} of ${files.length} images.`,
                    'SillyNPC');
            }
            resolve(out);
        }, { once: true });
        document.body.appendChild(fileInput);
        fileInput.click();
    });
}

/**
 * The single folder name a configured save route collapses to.
 *
 * The upload route sanitises this into one segment under user/images/, so anything
 * path-like loses all but its last part: "images/sillynpc" is written to
 * user/images/sillynpc, not user/images/images/sillynpc.
 *
 * One rule, shared by everything that touches the setting - the writer, the scanner that
 * has to look in the same place, the panel that reports the destination, and the
 * normaliser that cleans what is stored. Here rather than in api.js because settings.js
 * needs it too and cannot import api.js, which imports settings.js.
 *
 * @param {string} configured
 * @returns {string}
 */
export function resolveImageFolder(configured) {
    return String(configured || '').split(/[\\/]/).map(part => part.trim()).filter(Boolean).pop() || 'sillynpc';
}

/**
 * Where a configured save route will actually put a portrait, said out loud.
 *
 * Separate from the panel so the wording can be checked without building one, and because
 * showing the answer is not the same as saying the answer differs from the question:
 * someone typing a full path has the wrong idea about this field, and a grey line quietly
 * showing a different folder does not correct one.
 *
 * @param {string} configured
 * @returns {string}
 */
export function describeSaveDestination(configured) {
    const typed = String(configured ?? '').trim();
    const folder = resolveImageFolder(configured);
    const where = folder
        ? `Saved to: user/images/${folder}/`
        : 'Saved to: user/images/ (no folder set)';
    // Only when it was not taken as written. Saying it every time teaches people to stop
    // reading the line.
    return typed && typed !== folder
        ? `${where} — not a path: only the last part is used.`
        : where;
}

/**
 * Moves one entry of a list up or down, in place.
 *
 * The order of a list in System Builder is the order everything downstream shows: the
 * tracker renders fields in it, the character page lists overrides in it, the extraction
 * schema and prompt name them in it. So moving the entry is the whole of reordering -
 * there is nothing else to keep in step.
 *
 * One rule rather than a swap written out at each control: collections had a pair of
 * buttons with the swap inline, and adding the same pair to stat rows and to collection
 * fields would have made four copies of it to keep right.
 *
 * @param {Array} list Mutated in place.
 * @param {number} index
 * @param {number} delta -1 for up, 1 for down.
 * @returns {boolean} False when the move would fall off either end, so a caller can leave
 *   its control disabled rather than offering a press that does nothing.
 */
export function moveInList(list, index, delta) {
    if (!Array.isArray(list)) return false;
    const from = Number(index);
    const to = from + Number(delta);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || from >= list.length || to < 0 || to >= list.length) return false;
    // Swapping an entry with itself is not a move, and saying it was would have the
    // caller save the settings and redraw the whole editor for nothing.
    if (from === to) return false;

    [list[from], list[to]] = [list[to], list[from]];
    return true;
}

export function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escapes the five HTML-significant characters so untrusted text (AI output,
 * persona fields, user-typed names) can be interpolated into markup — or into
 * an attribute value — without breaking out of it.
 *
 * The previous map had its entity strings HTML-decoded by a bad edit
 * (`{ '&': '&', '<': '<', ... }`), which made this a no-op for
 * everything except the single quote. Every caller was effectively unescaped.
 */
export function escapeHtml(unsafe) {
    if (unsafe === undefined || unsafe === null) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    };
    return String(unsafe).replace(/[&<>"']/g, m => map[m]);
}

/**
 * Robustly extracts a JSON object from text using brace matching.
 * @param {string} text 
 * @returns {string|null}
 */
export function extractJSON(text) {
    if (!text) return null;
    let i = text.indexOf('{');
    if (i === -1) return null;

    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let start = i;

    for (let j = i; j < text.length; j++) {
        const char = text[j];
        if (escapeNext) {
            escapeNext = false;
        } else if (char === '\\') {
            escapeNext = true;
        } else if (char === '"') {
            inString = !inString;
        } else if (!inString) {
            if (char === '{') depth++;
            else if (char === '}') {
                depth--;
                if (depth === 0) {
                    return text.substring(start, j + 1);
                }
            }
        }
    }
    
    // Fallback: if no matching brace, return from start to last }
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace > start) {
        return text.substring(start, lastBrace + 1);
    }
    
    return null;
}

function closeOpenStructures(str) {
    let repaired = str.trim();
    let inString = false;
    let escapeNext = false;
    const stack = [];

    for (let i = 0; i < repaired.length; i++) {
        const char = repaired[i];
        if (escapeNext) {
            escapeNext = false;
        } else if (char === '\\') {
            escapeNext = true;
        } else if (char === '"') {
            inString = !inString;
        } else if (!inString) {
            if (char === '{') {
                stack.push('}');
            } else if (char === '[') {
                stack.push(']');
            } else if (char === '}') {
                if (stack[stack.length - 1] === '}') {
                    stack.pop();
                }
            } else if (char === ']') {
                if (stack[stack.length - 1] === ']') {
                    stack.pop();
                }
            }
        }
    }

    if (inString) {
        repaired += '"';
    }

    repaired = repaired.replace(/,\s*$/, '');
    repaired = repaired.replace(/:\s*$/, '');

    // Close open structures in reverse order of the stack
    for (let i = stack.length - 1; i >= 0; i--) {
        repaired += stack[i];
    }

    return repaired;
}

function tryRepairAndParse(str) {
    let candidate = closeOpenStructures(str);
    try {
        return JSON.parse(candidate);
    } catch (e) {
        let current = str;
        for (let attempt = 0; attempt < 10; attempt++) {
            const lastComma = current.lastIndexOf(',');
            const lastOpenBrace = current.lastIndexOf('{');
            const lastOpenBracket = current.lastIndexOf('[');
            const cutIdx = Math.max(lastComma, lastOpenBrace, lastOpenBracket);
            
            if (cutIdx <= 0) break;
            
            current = current.substring(0, cutIdx);
            if (current.endsWith(',')) {
                current = current.slice(0, -1);
            }
            
            candidate = closeOpenStructures(current);
            try {
                return JSON.parse(candidate);
            } catch (err) {
                // Continue trimming
            }
        }
    }
    return null;
}

/**
 * Simple JSON repair for common AI mistakes
 * @param {string} jsonStr 
 * @returns {any}
 */
export function safeJsonParse(jsonStr) {
    if (!jsonStr) return null;
    let repaired = jsonStr.trim();
    
    // Remove trailing commas in objects and arrays
    repaired = repaired.replace(/,(\s*[\]}])/g, '$1');
    
    try {
        return JSON.parse(repaired);
    } catch (e) {
        // Try truncated repair
        const fixed = tryRepairAndParse(repaired);
        if (fixed) return fixed;

        // Try more aggressive repair if needed, or just fail
        try {
            // Fix missing quotes on keys (simple cases)
            let fixedQuotes = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
            return JSON.parse(fixedQuotes);
        } catch (e2) {
            debugLog('JSON parse failed even after repair', e2, repaired);
            return null;
        }
    }
}

/**
 * Splits a "current/maximum" value into its halves. A plain value has no maximum.
 *
 * Lived in five places at once - status-diff, status-extractor, status-logic,
 * status-snapshots and here - and the copies had already drifted: some trimmed the whole
 * string before splitting, some trimmed the halves afterwards. What each caller does with
 * the halves is still its own business; only the parsing is shared.
 *
 * @param {*} value
 * @returns {{ current: string, max: string }}
 */
export function splitValue(value) {
    const text = value === undefined || value === null ? '' : String(value).trim();
    const slash = text.indexOf('/');
    if (slash === -1) return { current: text, max: '' };
    return { current: text.slice(0, slash).trim(), max: text.slice(slash + 1).trim() };
}

/**
 * Works out how to draw a stat as a meter.
 *
 * Lives here rather than in ui-shared so it stays dependency-free and testable: the
 * HUD and the in-chat tracker both need it, and ui-shared already participates in an
 * import cycle with ui-hud.
 *
 * Handles the shapes stats actually arrive in: "8/10", a bare "42", a negative value
 * for ranges like an affinity of -100..100, and prose the model invented. The old HUD
 * maths used /(\d+)/ which silently read "-40" as 40 - fine for HP, wrong for anything
 * that can go below zero.
 *
 * @see splitValue - the "cur/max" parsing itself, which five modules were each doing
 * their own slightly different way.
 *
 * @param {{ rawValue?: any, min?: any, max?: any }} input
 * @returns {{ current: number, min: number, max: number, percent: number, numeric: boolean }}
 */
export function computeStatBar({ rawValue, min, max }) {
    // "8/10" - take the numerator, and the denominator as a max if none was configured.
    const { current: currentText, max: maxText } = splitValue(rawValue);
    const rhs = parseFloat(maxText);
    const impliedMax = Number.isFinite(rhs) ? rhs : null;

    const signed = String(currentText).match(/-?\d+(?:\.\d+)?/);
    const current = signed ? parseFloat(signed[0]) : NaN;

    const lower = Number.isFinite(parseFloat(min)) ? parseFloat(min) : 0;
    let upper = Number.isFinite(parseFloat(max)) ? parseFloat(max) : impliedMax;
    if (!Number.isFinite(upper)) upper = Number.isFinite(current) ? Math.max(current, lower + 1) : lower + 1;

    if (!Number.isFinite(current) || upper <= lower) {
        return { current: 0, min: lower, max: upper, percent: 0, numeric: false };
    }

    const clamped = Math.min(upper, Math.max(lower, current));
    const percent = ((clamped - lower) / (upper - lower)) * 100;
    return { current, min: lower, max: upper, percent, numeric: true };
}

/**
 * Fills in a field's Format string.
 *
 * `{{name}}` is what makes a label follow its field: it resolves to the field's current
 * name at render time, so renaming can never leave a label saying something the rest of
 * the extension has stopped calling it. A label written as literal text - "HP [{{HP}}]"
 * in a display template - is prose, and prose does not know it was renamed.
 *
 * The caller passes strings that are already fit for where they are going: the tracker box
 * hands in an HTML span for the value and escapes the name, the HUD hands in plain text.
 * Escaping here would have to guess which.
 *
 * @param {string} format e.g. `{{name}}: {{value}}`. Empty means just the value.
 * @param {{ value?: string, name?: string, max?: string }} parts
 * @returns {string}
 */
export function applyStatFormat(format, { value = '', name = '', max = '' } = {}) {
    let out = String(format || '{{value}}');
    out = out.split('{{value}}').join(value);
    out = out.split('{{name}}').join(name);
    // Only when there is one: a format asking for {{max}} on a stat without a ceiling
    // should not print the placeholder at people.
    out = out.split('{{max}}').join(max);
    return out;
}

/**
 * The persona filename behind a message's avatar, whatever shape it was written in.
 *
 * SillyTavern stamps the persona that wrote a message onto it as `force_avatar`, in one of
 * two forms: a thumbnail URL, `/thumbnail?type=persona&file=x.png`, which is what messages
 * carry now, and a plain `User Avatars/x.png` in older chats. Anything else - a character
 * portrait, a system avatar - is not a persona and comes back empty.
 *
 * @param {string} src
 * @returns {string} '' when this is not a persona avatar.
 */
export function personaFileFromAvatar(src) {
    const text = String(src ?? '');
    if (!text) return '';

    const query = text.indexOf('?');
    if (query >= 0) {
        const params = new URLSearchParams(text.slice(query + 1));
        if (params.get('type') !== 'persona') return '';
        return params.get('file') || '';
    }

    const prefix = 'User Avatars/';
    const at = text.indexOf(prefix);
    if (at < 0) return '';
    try {
        return decodeURIComponent(text.slice(at + prefix.length));
    } catch {
        // A stray % in a filename is not an escape, and is not worth throwing over.
        return text.slice(at + prefix.length);
    }
}
