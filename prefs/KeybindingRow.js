// prefs/KeybindingRow.js — Keybinding editor widget for settings UI
// Runs in the prefs process only (GTK4 / libadwaita).
// Provides an ActionRow with key capture functionality for editing keyboard shortcuts.

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Adw from 'gi://Adw';

// ---------------------------------------------------------------------------
// KeybindingRow
// ---------------------------------------------------------------------------

/**
 * An Adw.ActionRow that displays and allows editing of a keyboard shortcut
 * stored in GSettings as a string array (e.g. `['<Control><Shift>Right']`).
 *
 * Features:
 * - Shows the current keybinding formatted with Gtk.accelerator_get_label()
 * - "Set" button enters capture mode (listens for next key combo)
 * - "Reset" button restores the GSettings default
 * - Escape cancels capture mode
 * - Lone modifier keys are filtered out (not accepted as valid shortcuts)
 */
export const KeybindingRow = GObject.registerClass({
    GTypeName: 'KeybindingRow',
}, class KeybindingRow extends Adw.ActionRow {
    /**
     * @param {Gio.Settings} settings - GSettings instance for this extension
     * @param {string} settingsKey - GSettings key name (e.g. 'cycle-next-tab')
     * @param {string} title - Display title for the row
     * @param {string} [subtitle] - Optional description subtitle
     */
    constructor(settings, settingsKey, title, subtitle) {
        super({
            title: title || settingsKey,
            subtitle: subtitle || '',
            activatable: false,
        });

        this._settings = settings;
        this._settingsKey = settingsKey;
        this._capturing = false;
        this._keyController = null;

        // --- Suffix widgets ---

        // Shortcut display label
        this._shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.END,
        });
        this._updateLabel();
        this.add_suffix(this._shortcutLabel);

        // "Capturing" status label (hidden by default)
        this._captureLabel = new Gtk.Label({
            label: 'Press a key combo…',
            css_classes: ['dim-label'],
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.END,
            visible: false,
        });
        this.add_suffix(this._captureLabel);

        // Set button — enters capture mode
        this._setBtn = new Gtk.Button({
            label: 'Set',
            valign: Gtk.Align.CENTER,
        });
        this._setBtn.add_css_class('flat');
        this._setBtn.connect('clicked', () => this._startCapture());
        this.add_suffix(this._setBtn);

        // Reset button — restores default
        const resetBtn = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Reset to default',
        });
        resetBtn.add_css_class('flat');
        resetBtn.connect('clicked', () => this._resetToDefault());
        this.add_suffix(resetBtn);

        // Listen for GSettings changes (e.g. from dconf-editor)
        this._settingsChangedId = this._settings.connect(
            `changed::${this._settingsKey}`,
            () => this._updateLabel()
        );
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Clean up signal connections. Call when the prefs window is closing.
     */
    destroy() {
        this._stopCapture();
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
    }

    // -----------------------------------------------------------------------
    // Label Display
    // -----------------------------------------------------------------------

    /**
     * Reads the current accelerator from GSettings and updates the label.
     */
    _updateLabel() {
        const value = this._settings.get_strv(this._settingsKey);
        const accel = (value && value.length > 0) ? value[0] : '';

        if (accel) {
            this._shortcutLabel.set_accelerator(accel);
            this._shortcutLabel.set_visible(true);
        } else {
            this._shortcutLabel.set_accelerator('');
            this._shortcutLabel.set_visible(true);
        }
    }

    // -----------------------------------------------------------------------
    // Capture Mode
    // -----------------------------------------------------------------------

    /**
     * Enter key capture mode — listens for the next key press.
     */
    _startCapture() {
        if (this._capturing) return;
        this._capturing = true;

        // Toggle visibility: hide the shortcut label, show the capture text
        this._shortcutLabel.set_visible(false);
        this._captureLabel.set_visible(true);
        this._setBtn.set_sensitive(false);

        // Add CSS feedback
        this.add_css_class('accent');

        // Create an event controller on the root window to capture keys globally
        const root = this.get_root();
        if (!root) {
            this._stopCapture();
            return;
        }

        this._keyController = new Gtk.EventControllerKey();
        this._keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        this._keyPressedId = this._keyController.connect(
            'key-pressed',
            (_controller, keyval, _keycode, state) => {
                return this._onKeyPressed(keyval, state);
            }
        );

        root.add_controller(this._keyController);
    }

    /**
     * Exit capture mode and restore normal display.
     */
    _stopCapture() {
        if (!this._capturing) return;
        this._capturing = false;

        // Restore visibility
        this._shortcutLabel.set_visible(true);
        this._captureLabel.set_visible(false);
        this._setBtn.set_sensitive(true);

        // Remove CSS feedback
        this.remove_css_class('accent');

        // Remove the event controller
        if (this._keyController) {
            const root = this.get_root();
            if (root) {
                root.remove_controller(this._keyController);
            }
            if (this._keyPressedId) {
                this._keyController.disconnect(this._keyPressedId);
                this._keyPressedId = null;
            }
            this._keyController = null;
        }
    }

    /**
     * Handles a key-pressed event during capture mode.
     * @param {number} keyval - The key value
     * @param {Gdk.ModifierType} state - Modifier state
     * @returns {boolean} true to stop propagation, false otherwise
     */
    _onKeyPressed(keyval, state) {
        // Cancel on Escape (with no modifiers)
        if (keyval === Gdk.KEY_Escape && !(state & Gdk.ModifierType.MODIFIER_MASK)) {
            this._stopCapture();
            return true;
        }

        // Clean the modifier state — keep only standard modifiers
        const mask = state & Gdk.ModifierType.MODIFIER_MASK;
        // Remove keyboard lock bits (Caps Lock, Num Lock, etc.)
        const cleanState = mask & ~(Gdk.ModifierType.LOCK_MASK);

        // Reject lone modifier keys (no actual key pressed, just a modifier)
        if (this._isModifierKey(keyval)) {
            return true; // swallow but don't save — wait for a real key
        }

        // Build accelerator string
        const accel = Gtk.accelerator_name(keyval, cleanState);
        if (!accel) {
            this._stopCapture();
            return true;
        }

        // Save to GSettings
        this._settings.set_strv(this._settingsKey, [accel]);

        // Update display and exit capture
        this._updateLabel();
        this._stopCapture();
        return true;
    }

    /**
     * Check if a keyval corresponds to a lone modifier key.
     * @param {number} keyval
     * @returns {boolean}
     */
    _isModifierKey(keyval) {
        return (
            keyval === Gdk.KEY_Shift_L ||
            keyval === Gdk.KEY_Shift_R ||
            keyval === Gdk.KEY_Control_L ||
            keyval === Gdk.KEY_Control_R ||
            keyval === Gdk.KEY_Alt_L ||
            keyval === Gdk.KEY_Alt_R ||
            keyval === Gdk.KEY_Super_L ||
            keyval === Gdk.KEY_Super_R ||
            keyval === Gdk.KEY_Meta_L ||
            keyval === Gdk.KEY_Meta_R ||
            keyval === Gdk.KEY_Hyper_L ||
            keyval === Gdk.KEY_Hyper_R ||
            keyval === Gdk.KEY_ISO_Level3_Shift ||
            keyval === Gdk.KEY_ISO_Level5_Shift
        );
    }

    // -----------------------------------------------------------------------
    // Reset
    // -----------------------------------------------------------------------

    /**
     * Reset the keybinding to its GSettings default value.
     */
    _resetToDefault() {
        this._settings.reset(this._settingsKey);
        this._updateLabel();
    }
});
