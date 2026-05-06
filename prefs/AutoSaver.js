// prefs/AutoSaver.js — Debounced auto-save with toast feedback
// Runs in the prefs process only (GTK event loop).
// Provides a 500ms debounce that coalesces rapid changes into a single save,
// then shows an Adw.Toast on success or error.

import GLib from 'gi://GLib';
import Adw from 'gi://Adw';

const log = msg => console.log(`[TabbedTiling.AutoSaver] ${msg}`);

const DEBOUNCE_MS = 500;

/**
 * AutoSaver — debounced save with toast notifications.
 *
 * Usage:
 *   const saver = new AutoSaver(
 *       () => saveConfig(myConfig),
 *       toastOverlay,
 *       'Settings saved'
 *   );
 *   // On every user change:
 *   saver.queue();
 *   // On destructive/critical actions:
 *   saver.saveNow();
 *   // On prefs window close:
 *   saver.destroy();
 */
export class AutoSaver {
    /**
     * @param {Function} saveFn - Synchronous or async-returning save function.
     *   Should return a truthy value on success, or throw/return falsy on failure.
     * @param {Adw.ToastOverlay} toastOverlay - Overlay to show toast notifications on.
     * @param {string} [toastMessage='Saved'] - Message shown on successful save.
     */
    constructor(saveFn, toastOverlay, toastMessage = 'Saved') {
        this._saveFn = saveFn;
        this._toastOverlay = toastOverlay;
        this._toastMessage = toastMessage;
        this._timeoutId = null;
        this._destroyed = false;
    }

    /**
     * Schedule a debounced save. Resets the timer if a save is already pending.
     * After DEBOUNCE_MS with no new calls, the save function is executed.
     */
    queue() {
        if (this._destroyed)
            return;

        // Cancel any pending save
        this._cancelPending();

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._timeoutId = null;
            this._executeSave();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Execute the save immediately, bypassing the debounce timer.
     * Use for destructive actions (e.g., profile switches, zone removal)
     * where the user expects immediate persistence.
     */
    saveNow() {
        if (this._destroyed)
            return;

        this._cancelPending();
        this._executeSave();
    }

    /**
     * Cancel any pending timers and mark this instance as destroyed.
     * Call when the preferences window is being closed.
     */
    destroy() {
        this._cancelPending();
        this._destroyed = true;
    }

    // -----------------------------------------------------------------------
    // Private
    // -----------------------------------------------------------------------

    /**
     * Cancel a pending timeout if one exists.
     */
    _cancelPending() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    /**
     * Run the save function and show appropriate toast feedback.
     */
    _executeSave() {
        try {
            const result = this._saveFn();
            if (result === false) {
                // Explicit failure return
                this._showToast('Save failed', true);
            } else {
                this._showToast(this._toastMessage, false);
            }
        } catch (e) {
            log(`Save error: ${e}`);
            this._showToast(`Error: ${e.message || e}`, true);
        }
    }

    /**
     * Display an Adw.Toast on the overlay.
     * @param {string} message
     * @param {boolean} isError - If true, use a longer timeout for visibility
     */
    _showToast(message, isError) {
        if (!this._toastOverlay)
            return;

        try {
            const toast = new Adw.Toast({
                title: message,
                timeout: isError ? 5 : 2,
            });
            this._toastOverlay.add_toast(toast);
        } catch (e) {
            log(`Error showing toast: ${e}`);
        }
    }
}
