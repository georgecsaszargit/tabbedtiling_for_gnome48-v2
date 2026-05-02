// modules/SystemTray.js — Panel indicator for quick profile switching, toggle, and settings
import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const log = msg => console.log(`[TabbedTiling.SystemTray] ${msg}`);

export const SystemTray = GObject.registerClass(
class SystemTray extends PanelMenu.Button {
    _init(profileManager, { onProfileChanged, onToggle, getEnabled, extensionUuid }) {
        super._init(0.0, 'TabbedTiling Profile Switcher', false);

        this._profileManager = profileManager;
        this._onProfileChanged = onProfileChanged;
        this._onToggle = onToggle;
        this._getEnabled = getEnabled;
        this._extensionUuid = extensionUuid || 'tabbedtiling@george.com';

        // Panel icon
        this._icon = new St.Icon({
            icon_name: 'view-grid-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        // Build the initial menu
        this._buildMenu();
    }

    _buildMenu() {
        try {
            if (!this._profileManager) return;

            this.menu.removeAll();

            // ---- Enable/Disable Toggle ----
            const isEnabled = typeof this._getEnabled === 'function' ? this._getEnabled() : true;
            this._toggleItem = new PopupMenu.PopupSwitchMenuItem('Enable Tiling', isEnabled);
            this._toggleItem.connect('toggled', (item, state) => {
                try {
                    if (typeof this._onToggle === 'function') {
                        this._onToggle(state);
                    }
                } catch (e) {
                    logError(e, 'TabbedTiling: Error in toggle handler');
                }
            });
            this.menu.addMenuItem(this._toggleItem);

            // ---- Separator ----
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // ---- Profile list ----
            const profiles = this._profileManager.getProfiles();
            const activeProfile = this._profileManager.getActiveProfile();

            for (const profile of profiles) {
                const item = new PopupMenu.PopupMenuItem(profile.name);

                // Show dot ornament on the active profile
                if (profile.name === activeProfile) {
                    item.setOrnament(PopupMenu.Ornament.DOT);
                } else {
                    item.setOrnament(PopupMenu.Ornament.NONE);
                }

                item.connect('activate', () => {
                    try {
                        this._switchProfile(profile.name);
                    } catch (e) {
                        logError(e, 'TabbedTiling: Error in profile activate handler');
                    }
                });

                this.menu.addMenuItem(item);
            }

            // ---- Separator ----
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // ---- Settings ----
            const settingsItem = new PopupMenu.PopupMenuItem('Settings');
            settingsItem.connect('activate', () => {
                try {
                    this._openSettings();
                } catch (e) {
                    logError(e, 'TabbedTiling: Error in settings activate handler');
                }
            });
            this.menu.addMenuItem(settingsItem);
        } catch (e) {
            logError(e, 'TabbedTiling: Error in SystemTray._buildMenu');
        }
    }

    _switchProfile(name) {
        const activeProfile = this._profileManager.getActiveProfile();
        if (name === activeProfile) return;

        log(`Switching to profile: ${name}`);
        this._profileManager.setActiveProfile(name);

        // Rebuild menu to update ornament
        this._buildMenu();

        // Notify extension to reload zones
        if (typeof this._onProfileChanged === 'function') {
            this._onProfileChanged(name);
        }
    }

    _openSettings() {
        try {
            const subprocess = Gio.Subprocess.new(
                ['gnome-extensions', 'prefs', this._extensionUuid],
                Gio.SubprocessFlags.NONE
            );
            log('Opening extension preferences...');
        } catch (e) {
            log(`Failed to open settings: ${e}`);
        }
    }

    /**
     * Update the toggle switch state without triggering the callback.
     */
    setToggleState(enabled) {
        if (this._toggleItem) {
            this._toggleItem.setToggleState(enabled);
        }
    }

    /**
     * Call this to refresh the menu if profiles have changed externally
     * (e.g., from the prefs window).
     */
    refresh() {
        try {
            if (!this._profileManager) return;
            this._profileManager.load();
            this._buildMenu();
        } catch (e) {
            logError(e, 'TabbedTiling: Error in SystemTray.refresh');
        }
    }

    destroy() {
        try {
            super.destroy();
        } catch (e) {
            logError(e, 'TabbedTiling: Error in SystemTray.destroy');
        }
        this._profileManager = null;
        this._onProfileChanged = null;
        this._onToggle = null;
    }
});
