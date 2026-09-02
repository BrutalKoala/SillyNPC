import { getSettings, saveSettings } from './settings.js';
import { buildSettingToggle, buildSettingSlider, buildSettingSelect } from './ui-shared.js';
import { triggerReprocess } from './chat.js';
import { updateHUD, resetHudPosition } from './ui-hud.js';

/**
 * The floating HUD's settings tab.
 *
 * Split out of status-settings.js, which had grown to 2283 lines rendering four tabs.
 * Nothing here draws the chat - only the HUD it configures.
 */

/**
 * The floating HUD's own panel.
 *
 * It began as one toggle inside the tracker settings and grew to a dozen controls -
 * meter style, meter size, portrait side, shape and border - which left the tracker's
 * own Display section buried underneath them. Its own tab, beside Tracker.
 *
 * @param {HTMLElement} container
 */
export function renderHudView(container) {
    if (!container) return;
    container.replaceChildren();

    const settings = getSettings().statusTracker;

    const title = document.createElement('h3');
    title.className = 'sillynpc-section-title';
    title.textContent = 'Floating HUD';
    container.appendChild(title);

    // Neither handler touches the chat. Every control on this panel draws the floating
    // HUD and nothing else, but both used to call triggerReprocess(), which redraws every
    // rendered message - a hundred of them by SillyTavern's default - through a chunked
    // loop spread over twenty animation frames. Moving a slider here cost a third of a
    // second of dropped frames to redraw a chat that had not changed.

    /** Rebuilds the panel. Only for controls that add or remove other controls. */
    const onChange = () => {
        const scrollParent = container.closest('.sillynpc-tab-panel') || container.closest('.popup-body') || container;
        const top = scrollParent.scrollTop;
        renderHudView(container);
        requestAnimationFrame(() => {
            if (scrollParent) scrollParent.scrollTop = top;
        });
        updateHUD();
    };

    /** Saves and redraws the HUD, leaving the panel and the chat alone. */
    const onApply = () => {
        saveSettings();
        updateHUD();
    };


    container.append(buildSettingToggle({
        key: 'statusTracker.hudEnabled',
        label: 'Enable Floating HUD',
        help: 'A small draggable panel showing your own stats.',
        onChange
    }));

    if (settings.hudEnabled) {
        container.append(buildSettingSelect({
            key: 'statusTracker.hudPosition',
            label: 'Corner',
            options: [
                { value: 'top-right', label: 'Top Right' },
                { value: 'top-left', label: 'Top Left' },
                { value: 'bottom-right', label: 'Bottom Right' },
                { value: 'bottom-left', label: 'Bottom Left' }
            ],
            onChange: () => {
                const st = getSettings().statusTracker;
                // Choosing a corner is also how you undo having dragged it somewhere.
                if (st.hud?.position) { st.hud.position.x = null; st.hud.position.y = null; }
                onApply();
            }
        }));

        container.append(buildSettingSlider({
            key: 'statusTracker.hudScale',
            label: 'Size',
            min: 0.5,
            max: 2.0,
            step: 0.1,
            onChange: onApply
        }));

        container.append(buildSettingSelect({
            key: 'statusTracker.hudMeterStyle',
            label: 'Meter Style',
            options: [
                { value: 'bar', label: 'Bar' },
                { value: 'segmented', label: 'Segmented' },
                { value: 'ring', label: 'Rings around the portrait' },
                { value: 'text', label: 'Text only' },
            ],
            help: "How each stat marked Primary is drawn. Rings take the portrait's "
                + 'shape, round or square, and sit on its edge. Rings fit three before they '
                + 'get too thin, so any beyond that fall back to text. A stat whose value '
                + 'has no number in it - or no maximum to fill against - is always shown '
                + 'as text, because a bar for it would sit empty forever.',
            onChange,
        }));

        // The two are the same idea measured differently, so only the one that applies
        // to the chosen style is shown. A width slider does nothing to a ring, and a
        // thickness slider does nothing to a bar.
        if (settings.hudMeterStyle === 'ring') {
            container.append(buildSettingSlider({
                key: 'statusTracker.hudRingThickness',
                label: 'Ring Thickness',
                min: 2, max: 14, step: 1, suffix: 'px',
                help: 'How heavy each ring is drawn. Thicker rings reach further out from '
                    + 'the portrait, and the panel grows to match.',
                onChange: onApply,
            }));
        } else if (settings.hudMeterStyle !== 'text') {
            container.append(buildSettingSlider({
                key: 'statusTracker.hudMeterWidth',
                label: 'Meter Width',
                min: 60, max: 260, step: 4, suffix: 'px',
                onChange: onApply,
            }));

            container.append(buildSettingSlider({
                key: 'statusTracker.hudMeterHeight',
                label: 'Meter Height',
                min: 6, max: 32, step: 1, suffix: 'px',
                onChange: onApply,
            }));
        }

        container.append(buildSettingSelect({
            key: 'statusTracker.hudPortraitSide',
            label: 'Portrait Side',
            options: [
                { value: 'auto', label: 'Follow the corner' },
                { value: 'left', label: 'Left' },
                { value: 'right', label: 'Right' },
            ],
            onChange: onApply,
        }));

        container.append(buildSettingSelect({
            key: 'statusTracker.hudPortraitShape',
            label: 'Portrait Shape',
            options: [
                { value: 'circle', label: 'Circle' },
                { value: 'square', label: 'Square' },
            ],
            onChange: onApply,
        }));

        const borderWrap = document.createElement('div');
        borderWrap.className = 'sillynpc-setting';
        const borderRow = document.createElement('div');
        borderRow.className = 'sillynpc-setting-row';
        const borderLabel = document.createElement('label');
        borderLabel.className = 'sillynpc-setting-label';
        borderLabel.textContent = 'Portrait Border';

        const borderInput = document.createElement('input');
        borderInput.type = 'color';
        borderInput.className = 'sillynpc-color-input';
        borderInput.value = getSettings().statusTracker.hudPortraitBorder || '#c9a96e';
        borderInput.addEventListener('input', () => {
            getSettings().statusTracker.hudPortraitBorder = borderInput.value;
            saveSettings();
            onApply();
        });

        // Empty means the theme decides, which is what it always did; without a way back
        // the first click on the picker would be irreversible.
        const borderClear = document.createElement('button');
        borderClear.type = 'button';
        borderClear.className = 'menu_button';
        borderClear.textContent = 'Use theme';
        borderClear.addEventListener('click', () => {
            getSettings().statusTracker.hudPortraitBorder = '';
            saveSettings();
            onApply();
        });

        const borderNote = document.createElement('small');
        borderNote.className = 'notes';
        borderNote.textContent = "Follows the theme's accent colour unless you choose one here.";

        borderRow.append(borderLabel, borderInput, borderClear);
        borderWrap.append(borderRow, borderNote);
        container.append(borderWrap);

        const resetHudWrap = document.createElement('div');
        resetHudWrap.className = 'sillynpc-setting';
        const resetHudBtn = document.createElement('button');
        resetHudBtn.type = 'button';
        resetHudBtn.className = 'menu_button';
        resetHudBtn.innerHTML = '<i class="fa-solid fa-arrows-to-dot"></i> Reset HUD Position';
        resetHudBtn.title = 'Discard the dragged position and snap the HUD back to its corner.';
        resetHudBtn.addEventListener('click', () => {
            resetHudPosition();
            toastr.info('HUD position reset.', 'SillyNPC');
        });
        resetHudWrap.appendChild(resetHudBtn);
        container.append(resetHudWrap);
    }
}
