import { POPUP_TYPE, POPUP_RESULT, Popup } from '../../../../popup.js';
// The chat shows this picture beside every line the character speaks, so changing
// it has to redraw. reprocess.js rather than chat.js: chat.js imports this file.
import { triggerReprocess } from './reprocess.js';
import { saveSettings } from './settings.js';
import { pickAndProcessImage } from './utils.js';
import { adoptImageForCharacter, removeCharacterImage } from './api.js';
import { generateCharacterImage } from './ui-api.js';

/**
 * The picture, full size, over the page.
 *
 * Shared with the read-only character page, which shows the same portrait at the same
 * cropped size and wants the same way out of it. One implementation, so the two cannot
 * end up with different close buttons.
 *
 * @param {string} src
 */
export function openLightbox(src) {
    if (!src) return;
    const box = document.createElement('div');
    box.className = 'sillynpc-lightbox';
    const big = document.createElement('img');
    big.src = src;
    box.append(big);
    new Popup(box, POPUP_TYPE.TEXT, '', { okButton: 'Close', cancelButton: false }).show();
}

/**
 * The portrait column: the picture, the gallery it belongs to, and the ways to change it.
 *
 * Lifted out of the character editor so the player's sheet can have the same one. It had
 * to be shared rather than copied - it is four controls, a three-way delete and a
 * carousel, and a second copy would have started drifting from the first immediately.
 *
 * Everything here works on any object shaped like a character card: imageUrl, images and
 * name. The player's card is stored with those field names for exactly this reason.
 *
 * @param {object} char The card to edit, mutated in place and saved.
 * @param {{ onChange: () => void }} options Redraws whatever is showing the block.
 * @returns {{ preview: HTMLElement, buttons: HTMLElement }} Appended by the caller, which
 *   knows where they go on its own page.
 */
export function buildPortraitBlock(char, { onChange }) {
    const preview = document.createElement('div');
    preview.className = 'sillynpc-editor-bigpreview';
    preview.style.position = 'relative';
    if (char.imageUrl) {
        const img = document.createElement('img');
        img.src = char.imageUrl;
        // The preview is small and cropped; this is the only way to see the whole picture
        // without opening the file on disk.
        img.title = 'Click to view full size';
        img.style.cursor = 'zoom-in';
        img.addEventListener('click', () => openLightbox(char.imageUrl));
        preview.appendChild(img);
    } else {

        const empty = document.createElement('div');
        empty.className = 'sillynpc-editor-bigpreview-empty';
        empty.innerHTML = '<i class="fa-solid fa-user-large"></i><span>no image</span>';
        preview.appendChild(empty);
    }
    
    // Step through the character's saved portraits. Hidden below two images, because a
    // control that cannot go anywhere is worse than no control.
    const gallery = Array.isArray(char.images) ? char.images.filter(Boolean) : [];
    if (gallery.length > 1) {
        const step = (delta) => {
            const at = gallery.indexOf(char.imageUrl);
            // An unlisted current image counts as position 0, so the first press moves
            // somewhere sensible rather than appearing to do nothing.
            const from = at >= 0 ? at : 0;
            const next = (from + delta + gallery.length) % gallery.length;
            char.imageUrl = gallery[next];
            saveSettings();
            triggerReprocess();
            onChange();
        };

        const prev = document.createElement('div');
        prev.className = 'sillynpc-img-nav sillynpc-img-nav-prev';
        prev.title = 'Previous image';
        prev.innerHTML = '<i class="fa-regular fa-circle-left"></i>';
        prev.addEventListener('click', (e) => { e.stopPropagation(); step(-1); });

        const next = document.createElement('div');
        next.className = 'sillynpc-img-nav sillynpc-img-nav-next';
        next.title = 'Next image';
        next.innerHTML = '<i class="fa-regular fa-circle-right"></i>';
        next.addEventListener('click', (e) => { e.stopPropagation(); step(1); });

        const counter = document.createElement('div');
        counter.className = 'sillynpc-img-nav-count';
        const at = gallery.indexOf(char.imageUrl);
        counter.textContent = `${(at >= 0 ? at : 0) + 1} / ${gallery.length}`;

        preview.append(prev, next, counter);
    }

    // Removing a portrait had no control at all: the only way was to delete the file from
    // disk by hand and leave the extension pointing at nothing. Three outcomes rather than
    // a yes/no, because "take it off this character" and "erase the file" are different
    // intentions and only one of them can be undone.
    if (char.imageUrl) {
        const del = document.createElement('div');
        del.className = 'sillynpc-img-delete';
        del.title = 'Remove this image';
        del.innerHTML = '<i class="fa-solid fa-trash"></i>';
        del.addEventListener('click', async (e) => {
            e.stopPropagation();

            const body = document.createElement('div');
            body.className = 'sillynpc-gen-popup';

            const shot = document.createElement('img');
            shot.src = char.imageUrl;
            shot.className = 'sillynpc-genresult-image';
            body.append(shot);

            const question = document.createElement('p');
            question.textContent = 'Remove this image from '
                + `${char.name || 'this character'}?`;
            body.append(question);

            const detail = document.createElement('p');
            detail.className = 'notes';
            detail.textContent = 'Deleting erases the file from disk and cannot be undone. '
                + 'Removing keeps the file and only takes it off this character.';
            body.append(detail);

            // Cancel is the default: a stray click on a small icon should cost nothing.
            let answer = 'cancel';
            const popup = new Popup(body, POPUP_TYPE.TEXT, '', {
                okButton: false,
                cancelButton: false,
                customButtons: [
                    { text: 'Remove from character', result: POPUP_RESULT.AFFIRMATIVE, action: () => { answer = 'unlink'; } },
                    { text: 'Delete permanently', result: POPUP_RESULT.AFFIRMATIVE, action: () => { answer = 'delete'; } },
                    { text: 'Cancel', result: POPUP_RESULT.NEGATIVE, action: () => { answer = 'cancel'; } },
                ],
            });
            await popup.show();
            if (answer === 'cancel') return;

            const result = await removeCharacterImage(char, char.imageUrl, {
                deleteFile: answer === 'delete',
            });
            if (answer === 'delete' && result.removed && !result.deletedFile) {
                toastr.info(
                    'Taken off this character, but the file was kept: another character is using it.',
                    'SillyNPC',
                );
            }
            onChange();
        });
        preview.append(del);
    }

    const genIcon = document.createElement('div');
    genIcon.className = 'sillynpc-img-gen-icon';
    genIcon.title = 'Generate image';
    genIcon.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
    genIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        generateCharacterImage(char, { onSave: () => onChange() });
    });
    preview.appendChild(genIcon);
    
    const imgBtns = document.createElement('div');
    imgBtns.className = 'sillynpc-editor-image-buttons';
    
    const browseBtn = document.createElement('button');
    browseBtn.type = 'button';
    browseBtn.className = 'menu_button browse-btn';
    browseBtn.innerHTML = '<i class="fa-solid fa-folder-open"></i> Browse...';
    browseBtn.addEventListener('click', async () => {
        const dataUri = await pickAndProcessImage({ fullSize: true });
        if (!dataUri) return;
        // Written to disk and added to the list, so it survives the arrows and does not
        // sit inside settings.json as a base64 blob.
        await adoptImageForCharacter(char, dataUri);
        onChange();
    });
    
    const clearImgBtn = document.createElement('button');
    clearImgBtn.type = 'button';
    clearImgBtn.className = 'menu_button clear-btn';
    if (!char.imageUrl) clearImgBtn.disabled = true;
    clearImgBtn.innerHTML = '<i class="fa-solid fa-xmark"></i> Clear';
    clearImgBtn.addEventListener('click', () => {
        char.imageUrl = '';
        saveSettings();
        triggerReprocess();
        onChange();
    });
    
    imgBtns.append(browseBtn, clearImgBtn);

    return { preview, buttons: imgBtns };
}
