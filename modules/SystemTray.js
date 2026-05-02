// modules/SystemTray.js — Panel indicator for quick profile switching
import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const log = msg => console.log(`[TabbedTiling.SystemTray] ${msg}`);

export const SystemTray = GObject.registerClass(
class SystemTray extends PanelMenu.Button {
    _init(profileManager, onProfileChanged) {
        super._init(0.0, 'TabbedTiling Profile Switcher', false);

        this._profileManager = profileManager;
        this._onProfileChanged = onProfileChanged;

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
        this.menu.removeAll();

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
                this._switchProfile(profile.name);
            });

            this.menu.addMenuItem(item);
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

    /**
     * Call this to refresh the menu if profiles have changed externally
     * (e.g., from the prefs window).
     */
    refresh() {
        this._profileManager.load();
        this._buildMenu();
    }

    destroy() {
        super.destroy();
    }
});
