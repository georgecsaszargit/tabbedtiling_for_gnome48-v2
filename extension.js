// extension.js
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { WindowManager } from './modules/WindowManager.js';
import { ConfigManager } from './modules/ConfigManager.js';
import { Highlighter } from './modules/Highlighter.js';
import { ProfileManager } from './modules/ProfileManager.js';
import { SystemTray } from './modules/SystemTray.js';

const log = msg => console.log(`[TabbedTiling] ${msg}`);

const KEYBINDING_CYCLE_NEXT = 'cycle-next-tab';
const KEYBINDING_CYCLE_PREV = 'cycle-prev-tab';
const KEYBINDING_LOG_PRESS = 'log-key-press';

export default class TabbedTilingExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._configManager = null;
        this._windowManager = null;
        this._highlighter = null;
        this._profileManager = null;
        this._systemTray = null;
        this._configFileMonitor = null;
        this._previewFileMonitor = null;
        this._profilesFileMonitor = null;
        this._settings = null;
    }

    enable() {
        // Don't render tabs/overlays on lock screen or other non-user modes.
        // This prevents tab bars showing above the lock UI.
        if (Main.sessionMode.currentMode !== 'user') {
            return;
        }
        log('Enabling...');

        this._settings = this.getSettings();
        this._configManager = new ConfigManager();
        this._highlighter = new Highlighter();
        this._profileManager = new ProfileManager().load();
        this._windowManager = new WindowManager(this._configManager, this._highlighter, this._profileManager);

        try {
            this._windowManager.enable();
            this._addKeybindings();
            this._monitorConfigFiles();

            // System tray icon for profile switching
            this._systemTray = new SystemTray(this._profileManager, (profileName) => {
                log(`Profile switched via tray: ${profileName}`);
                this._windowManager.reloadConfiguration();
            });
            Main.panel.addToStatusArea('tabbedtiling-profile-switcher', this._systemTray);

            log('Enabled successfully.');
        } catch (e) {
            log(`Error during enable: ${e}`);
            this.disable();
        }
    }

    disable() {
        log('Disabling...');

        this._removeKeybindings();

        if (this._configFileMonitor) {
            this._configFileMonitor.cancel();
            this._configFileMonitor = null;
        }
        if (this._previewFileMonitor) {
            this._previewFileMonitor.cancel();
            this._previewFileMonitor = null;
        }
        if (this._profilesFileMonitor) {
            this._profilesFileMonitor.cancel();
            this._profilesFileMonitor = null;
        }

        if (this._systemTray) {
            this._systemTray.destroy();
            this._systemTray = null;
        }

        if (this._windowManager) {
            this._windowManager.disable();
            this._windowManager = null;
        }

        if (this._highlighter) {
            this._highlighter.destroy();
            this._highlighter = null;
        }

        this._configManager = null;
        this._profileManager = null;
        this._settings = null;
        log('Disabled.');
    }

    _addKeybindings() {
        const add = (name) => {
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                () => {
                    if (name === KEYBINDING_CYCLE_NEXT) this._windowManager.cycleTabNextInFocusedZone();
                    else if (name === KEYBINDING_CYCLE_PREV) this._windowManager.cycleTabPreviousInFocusedZone();
                    else if (name === KEYBINDING_LOG_PRESS) this._windowManager.toggleTabBarsLayer();
                }
            );
        };
        add(KEYBINDING_CYCLE_NEXT);
        add(KEYBINDING_CYCLE_PREV);
        add(KEYBINDING_LOG_PRESS);
    }
    _removeKeybindings() {
        Main.wm.removeKeybinding(KEYBINDING_CYCLE_NEXT);
        Main.wm.removeKeybinding(KEYBINDING_CYCLE_PREV);
        Main.wm.removeKeybinding(KEYBINDING_LOG_PRESS);
    }

    _monitorConfigFiles() {
        // Monitor the main config file for changes from the preferences window
        const configFile = this._configManager.getConfigFile();
        this._configFileMonitor = configFile.monitor(Gio.FileMonitorFlags.NONE, null);
        this._configFileMonitor.connect('changed', (monitor, file, otherFile, eventType) => {
            if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                log('Config file changed, reloading zones...');
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    this._windowManager.reloadConfiguration();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        // Monitor the preview file for requests from the preferences window
        const previewFile = this._configManager.getPreviewFile();
        this._previewFileMonitor = previewFile.monitor(Gio.FileMonitorFlags.NONE, null);
        this._previewFileMonitor.connect('changed', (monitor, file, otherFile, eventType) => {
            if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                log('Preview file changed, showing preview...');
                const zones = this._configManager.loadPreviewZones();
                if (zones) {
                    this._highlighter.showAllPreviews(zones);
                }
            }
        });

        // Monitor profiles.json for active profile changes from prefs window
        const profilesFile = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_config_dir(), 'tabbedtiling', 'profiles.json'])
        );
        if (profilesFile.query_exists(null)) {
            this._profilesFileMonitor = profilesFile.monitor(Gio.FileMonitorFlags.NONE, null);
            this._profilesFileMonitor.connect('changed', (monitor, file, otherFile, eventType) => {
                if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                    log('Profiles file changed, reloading configuration...');
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                        this._windowManager.reloadConfiguration();
                        // Refresh tray menu to show updated profiles/active state
                        if (this._systemTray)
                            this._systemTray.refresh();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
        }
    }
}
