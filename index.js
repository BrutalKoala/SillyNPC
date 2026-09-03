import { eventSource, event_types } from '../../../events.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { LOG_PREFIX, extensionName, debugLog } from './src/constants.js';
import { getContext } from '../../../st-context.js';
import { initSettings, saveSettings, getSettings } from './src/settings.js';
import { repairDefaultImages } from './src/default-portraits.js';
import { 
    openManagePopup
} from './src/ui-manage.js';
import {
    reprocessAllMessages,
    reprocessMessage,
    setReprocessCallback,
    triggerReprocess,
    invalidateChatRender,
} from './src/chat.js';
import { redrawStatusBoxes } from './src/status-ui.js';
import {
    createCharacter, addAlias, addCharacterToChat,
    CAST_KEY, setChatCast, getAllCategories, UNCATEGORISED,
} from './src/characters.js';
import { tryAutoSyncLorebook, syncLorebookScope } from './src/lorebook.js';
import { initStatusLogic, hasOpenChat } from './src/status-logic.js';
import { rebaseToSwipe, revertToBase } from './src/status-snapshots.js';
import { extractStateFromMessage, resetExtractionState, tidyThreadsOnLoad, forgetExtractionsFrom } from './src/status-extractor.js';
import { initHUD, updateHUD } from './src/ui-hud.js';
import { openPlayerModal } from './src/ui-player-modal.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { refreshScanButton } from './src/ui-scan-button.js';
import { applyPortraitFraming, applySpeechPadding } from './src/ui-shared.js';
import { applyCheckpointSchedule } from './src/status-logic.js';
import { noteActivatedLore } from './src/status-extractor.js';
import { setDebugLogging } from './src/constants.js';
import { describeChatConnection } from './src/utils.js';
import { applyDialogueFormatPrompt } from './src/dialogue-format.js';
import { applyNarratorRulesPrompt } from './src/narrator-rules.js';
import { applyBanList } from './src/banlist.js';

function onMessageRendered(messageId) {
    try {
        const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        reprocessMessage(mesEl);

        // If "showOnlyAtBottom" is enabled, we need to reprocess the previous message
        // to ensure its tracker is removed now that there's a new message.
        if (getSettings().statusTracker?.showOnlyAtBottom) {
            const prevMesId = Number(messageId) - 1;
            if (prevMesId >= 0) {
                const prevMesEl = document.querySelector(`#chat .mes[mesid="${prevMesId}"]`);
                if (prevMesEl) reprocessMessage(prevMesEl);
            }
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'onMessageRendered error', err);
    }
}

/**
 * Runs the state-extraction pass for a freshly rendered AI message.
 *
 * Deliberately fire-and-forget: the reply is already on screen, and a slow or failing
 * extraction must never block reading it or throw into SillyTavern's event loop.
 */
function onMessageForExtraction(messageId) {
    try {
        const context = getContext();
        const message = context?.chat?.[Number(messageId)];
        // Only the model's own prose is worth reading; user turns and system notes
        // describe nothing that changed.
        if (!message || message.is_user || message.is_system) return;

        extractStateFromMessage(message.mes, messageId)
            .then(result => {
                if (!result.applied && result.reason && result.reason !== 'extraction disabled'
                    && result.reason !== 'already extracted') {
                    debugLog('Extraction skipped:', result.reason);
                }
            })
            .catch(err => console.error(LOG_PREFIX, 'Extraction pass failed', err));
    } catch (err) {
        console.error(LOG_PREFIX, 'onMessageForExtraction error', err);
    }
}

/**
 * The tracker follows the swipe, then the message is redrawn.
 *
 * The changes already applied describe the reply that was on screen a moment ago. Left
 * alone, the story continues from numbers that belong to a reply the user swiped away
 * from - silently, which is what made this worth fixing rather than living with.
 */
function onSwipe(messageId) {
    try {
        const result = rebaseToSwipe(messageId);
        if (!result.rebased && result.reason === 'no base') {
            // Never a silent disagreement between the tracker and the reply on screen.
            toastr.warning(
                'The tracker could not follow that swipe, so it may not match this reply.',
                'SillyNPC');
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'onSwipe error', err);
    }
    onMessageRendered(messageId);
}

/**
 * The tracker follows a Regenerate, which is not a swipe.
 *
 * Regenerate deletes the newest reply and writes another in its place. SillyTavern says so
 * only by emitting MESSAGE_DELETED - MESSAGE_SWIPED comes from the swipe arrows alone - and
 * the payload there is the new chat length, which is identical whether the tail or the
 * middle was removed. So the generation type is what this reads instead: it is unambiguous,
 * and it arrives before the truncation, while the doomed message is still the last one.
 *
 * Two things have to happen, and neither used to. The changes that reply applied are undone,
 * or the replacement stacks on top of a reply nobody can see. And the guard that remembers
 * which messages have been read has to forget this index, because the replacement lands on
 * the same number and would otherwise be waved through as already extracted - which is why
 * the numbers did not merely drift after a Regenerate, they stopped moving entirely.
 */
function onRegenerateStarted(type, _data, dryRun) {
    if (dryRun || type !== 'regenerate') return;
    try {
        const messageId = (getContext()?.chat?.length ?? 0) - 1;
        if (messageId < 0) return;

        forgetExtractionsFrom(messageId);
        const result = revertToBase(messageId);
        if (!result.reverted && result.reason === 'no base') {
            // Same reasoning as the swipe path: never a silent disagreement between the
            // tracker and the reply on screen.
            toastr.warning(
                'The tracker could not undo the reply being regenerated, so it may not '
                + 'match the new one.',
                'SillyNPC');
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'onRegenerateStarted error', err);
    }
}

/**
 * Stale guard entries are dropped whenever messages go away.
 *
 * Message ids are positions, not identities, so anything from here on is a number that will
 * be handed to a different message later. Only the forgetting is safe to do here: the
 * payload cannot distinguish deleting the last message from deleting one in the middle, and
 * reverting the wrong one would discard state silently. See the regenerate handler above,
 * which knows exactly what it is undoing.
 */
function onMessageDeleted(newLength) {
    try {
        forgetExtractionsFrom(newLength);
    } catch (err) {
        console.error(LOG_PREFIX, 'onMessageDeleted error', err);
    }
}

async function addSettingsPanel() {
    try {
        const html = await renderExtensionTemplateAsync(extensionName, 'index');
        $('#extensions_settings2').append(html);
        refreshScanButton();

        document.getElementById('sillynpc-open-manage')?.addEventListener('click', () => {
            openManagePopup().catch(err => console.error(LOG_PREFIX, 'openManagePopup failed', err));
        });
    } catch (err) {
        console.error(LOG_PREFIX, 'failed to load settings panel', err);
    }
}

/**
 * Wire global click handling for injected avatars: your own portrait opens your sheet,
 * existing characters open their editor, default-image avatars prompt to create a card
 * for the speaker.
 */
function wireAvatarClicks() {
    document.addEventListener('click', async (e) => {
        const avatar = e.target.closest?.('.sillynpc-chat-avatar');
        if (!avatar) return;
        e.preventDefault();
        e.stopPropagation();

        // Checked before the card, because the avatar is drawn that way round too: this
        // name is you, so it opens your sheet even if a card of the name exists.
        if (avatar.dataset.persona) {
            openPlayerModal();
            return;
        }

        const charId = avatar.dataset.charId;
        if (charId) {
            await openManagePopup({ tab: 'characters', charId });
            return;
        }

        // Default-image case: this name has no card. Offer both readings of that - a
        // person nobody has carded yet, or another name for somebody already carded.
        const speakerName = avatar.dataset.charName || '';
        const choice = await askAboutUnknownSpeaker(speakerName);
        if (!choice) return;

        if (choice.aliasOf) {
            // Someone you are aliasing was spoken here, so they belong here.
            addCharacterToChat(choice.aliasOf);
            if (addAlias(choice.aliasOf, speakerName)) triggerReprocess();
            return;
        }

        const char = createCharacter(speakerName);
        // Created from this chat, so it is a member of it whatever the chat is scoped to -
        // otherwise the card you just made would be invisible in the chat that prompted it.
        addCharacterToChat(char.id);
        if (speakerName) {
            await tryAutoSyncLorebook(char);
        }
        saveSettings();
        await openManagePopup({ tab: 'characters', charId: char.id });
    });
}

/**
 * Asks what an uncarded speaker actually is.
 *
 * @param {string} speakerName
 * @returns {Promise<{ aliasOf: string|null }|null>} Null when dismissed.
 */
async function askAboutUnknownSpeaker(speakerName) {
    const existing = getSettings().characters.filter(c => c.name);

    const wrap = document.createElement('div');
    const question = document.createElement('p');
    question.textContent = speakerName
        ? `"${speakerName}" has no character card.`
        : 'This speaker has no character card.';
    wrap.append(question);

    // With nobody to alias to, the old single question is still the right one.
    if (!existing.length || !speakerName) {
        return await Popup.show.confirm(question.textContent, 'Create a character card?')
            ? { aliasOf: null }
            : null;
    }

    const select = document.createElement('select');
    select.className = 'text_pole';
    select.style.width = '100%';

    const createOption = document.createElement('option');
    createOption.value = '';
    createOption.textContent = 'Create a new character card';
    select.append(createOption);

    const group = document.createElement('optgroup');
    group.label = `Or record "${speakerName}" as another name for…`;
    for (const char of existing) {
        const option = document.createElement('option');
        option.value = char.id;
        option.textContent = char.name;
        group.append(option);
    }
    select.append(group);
    wrap.append(select);

    const help = document.createElement('small');
    help.className = 'notes';
    help.style.cssText = 'display:block; margin-top:8px;';
    help.textContent = 'An alias makes both names resolve to the same character '
        + 'everywhere - the tracker, the lorebook and the scene cast, not only the avatar.';
    wrap.append(help);

    const result = await new Popup(wrap, POPUP_TYPE.CONFIRM, '', {
        okButton: 'OK', cancelButton: 'Cancel',
    }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;

    return { aliasOf: select.value || null };
}

/**
 * Offers to scope a brand new chat to some of your categories.
 *
 * Deliberately narrow. It only asks for a chat that is genuinely new, has never been
 * scoped, and belongs to a system with more than one category to choose between - so it
 * appears when you are starting a story and never as noise on an ordinary chat switch.
 * Declining leaves the chat unscoped, which means everybody, the same as before.
 */
async function offerChatScope() {
    if (!hasOpenChat()) return;

    const context = getContext();
    if ((context?.chat?.length ?? 0) > 1) return;
    if (context?.chatMetadata?.[CAST_KEY]) return;

    const categories = getAllCategories();
    if (categories.length < 2) return;

    const wrap = document.createElement('div');
    const question = document.createElement('p');
    question.textContent = 'Which characters is this new story for?';
    wrap.append(question);

    const boxes = [];
    for (const category of [UNCATEGORISED, ...categories]) {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex; align-items:center; gap:6px; margin:4px 0;';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.category = category;
        boxes.push(box);
        label.append(box, document.createTextNode(category || 'Uncategorised'));
        wrap.append(label);
    }

    const help = document.createElement('small');
    help.className = 'notes';
    help.style.cssText = 'display:block; margin-top:8px;';
    help.textContent = 'Tick nothing to include every character, which is what chats did '
        + 'before this existed. You can change it any time from Manage SillyNPC.';
    wrap.append(help);

    const result = await new Popup(wrap, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Use these', cancelButton: 'All characters',
    }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    const chosen = boxes.filter(b => b.checked).map(b => b.dataset.category);
    if (!chosen.length) return;             // ticking nothing means the same as declining
    setChatCast({ categories: chosen, include: [], exclude: [] });
    triggerReprocess();
}

jQuery(async () => {
    try {
        initSettings();
        // Before the first request, so a saved choice is in force for it.
        setDebugLogging(getSettings().debugLogging);
        // Before anything draws a portrait. The stylesheet falls back to `top` on its own,
        // so this only matters for a saved choice other than the default.
        applyPortraitFraming();
        applySpeechPadding();
        // Starts the interval save if one is configured; harmless when it is not.
        applyCheckpointSchedule();
        // Not awaited: a fallback portrait still held inside settings.json works exactly
        // as it is, so nothing needs to wait for it to become a file on disk. Failures are
        // logged and tried again next time.
        repairDefaultImages().catch(err => console.warn(LOG_PREFIX, 'Portrait repair failed', err));
        initStatusLogic();
        try {
            initHUD();
        } catch (hudErr) {
            console.error(LOG_PREFIX, 'initHUD failed', hudErr);
        }
        setReprocessCallback(reprocessAllMessages);
        await addSettingsPanel();
        wireAvatarClicks();
        // Logged beside SillyNPC's own request lines, so "what does the chat use" and
        // "what does the extension use" can be compared at a glance instead of by reading
        // secrets.json. Dry runs are skipped: SillyTavern fires several per message while
        // measuring the prompt, and they would bury the real one.
        eventSource.on(event_types.GENERATION_STARTED, (_type, _options, dryRun) => {
            if (dryRun) return;
            debugLog(describeChatConnection());
            // Here rather than in the tracker's own handler: that one returns early when
            // the tracker is off, and the chat is still decorated then.
            try {
                applyDialogueFormatPrompt();
                applyNarratorRulesPrompt();
                applyBanList();
            } catch (err) {
                debugLog('Could not set what is injected into the story prompt', err);
            }
        });

        // Fires while SillyTavern assembles the story prompt. Too late to change that
        // prompt, but in good time for the reader, which runs after the reply.
        eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
            try {
                noteActivatedLore(entries);
            } catch (err) {
                debugLog('Could not record activated lore', err);
            }
        });

        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageForExtraction);
        eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRendered);
        eventSource.on(event_types.MESSAGE_UPDATED, onMessageRendered);
        // Swiping between replies that already exist rewrites the message in place and
        // emits nothing else - no generation runs, so CHARACTER_MESSAGE_RENDERED never
        // fires. The new text arrived undecorated and stayed that way until something
        // else redrew the chat.
        eventSource.on(event_types.MESSAGE_SWIPED, onSwipe);
        /* Regenerate is not a swipe, and says so through neither of the events above.

           makeFirst rather than on, and it matters. status-logic listens to the same event
           to build the scene block it injects, and it registered first, so it ran first:
           the prompt for the regenerated reply was built from the state the *discarded*
           reply had left behind, and told the model about threads that were about to be
           undone. A log of a real regenerate showed exactly that - the story prompt still
           carrying two threads the extraction a moment later no longer had.

           Ordering is the only lever here, since both listen to the same event, so it is
           declared out loud instead of resting on which line of this function runs first. */
        eventSource.makeFirst(event_types.GENERATION_STARTED, onRegenerateStarted);
        eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
        eventSource.on(event_types.MORE_MESSAGES_LOADED, () => {
            // The signature describes the settings, not the DOM, and these two change
            // which messages exist without changing a setting - so they have to say
            // so, or a redraw that has learned to decline will decline this one.
            invalidateChatRender();
            reprocessAllMessages();
        });
        eventSource.on(event_types.CHAT_CHANGED, () => {
            invalidateChatRender();
            reprocessAllMessages();
        });
        eventSource.on(event_types.CHAT_CHANGED, resetExtractionState);
        // Chats that filled up before the caps existed are brought within them here, once,
        // rather than waiting for whatever their next extraction happens to be.
        eventSource.on(event_types.CHAT_CHANGED, () => {
            try {
                tidyThreadsOnLoad();
            } catch (err) {
                console.error(LOG_PREFIX, 'Thread tidy on load failed', err);
            }
        });
        // The HUD has to re-evaluate on every chat switch: it hides when none is open.
        eventSource.on(event_types.CHAT_CHANGED, () => updateHUD());
        eventSource.on(event_types.CHAT_CHANGED, () => {
            offerChatScope().catch(err => console.error(LOG_PREFIX, 'offerChatScope failed', err));
            syncLorebookScope().catch(err => console.error(LOG_PREFIX, 'syncLorebookScope failed', err));
        });
        eventSource.on(event_types.PERSONA_CHANGED, () => {
            try {
                updateHUD();
            } catch (err) {
                console.error(LOG_PREFIX, 'PERSONA_CHANGED HUD update failed', err);
            }
        });

        eventSource.on(event_types.CHARACTER_EDITED, () => {
            try {
                updateHUD();
                reprocessAllMessages();
            } catch (err) {
                console.error(LOG_PREFIX, 'CHARACTER_EDITED HUD update failed', err);
            }
        });

        eventSource.on('sillynpc-review-changed', ({ messageId } = {}) => {
            try {
                const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
                if (mesEl) reprocessMessage(mesEl);
            } catch (err) {
                console.error(LOG_PREFIX, 'review refresh failed', err);
            }
        });

        eventSource.on('sillynpc-player-portrait-changed', () => {
            try {
                updateHUD();
                reprocessAllMessages();
            } catch (err) {
                console.error(LOG_PREFIX, 'player portrait refresh failed', err);
            }
        });

        eventSource.on('sillynpc-status-updated', () => {
            try {
                updateHUD();
                // The tracker state moved, which changes the tracker boxes and nothing
                // else. This called reprocessAllMessages(), so every extracted message -
                // that is, every message - redrew the speaker decoration, the portraits
                // and the avatars over the whole chat as well. redrawStatusBoxes exists
                // for exactly this case and says so in its own comment.
                redrawStatusBoxes();
            } catch (err) {
                console.error(LOG_PREFIX, 'sillynpc-status-updated refresh failed', err);
            }
        });

        eventSource.on('sillynpc-open-manage', (data) => {
            openManagePopup(data).catch(err => console.error(LOG_PREFIX, 'openManagePopup failed', err));
        });

        console.log(LOG_PREFIX, 'extension loaded successfully', { extensionName });
    } catch (err) {
        console.error(LOG_PREFIX, 'CRITICAL: Extension failed to load during jQuery ready!', err);
    }
});
