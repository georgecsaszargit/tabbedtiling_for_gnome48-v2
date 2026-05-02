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
        this._pendingSourceIds = null;
        this._isDisabled = true;
    }

    // Fix 7: Null-safe _tilingEnabled getter
    get _tilingEnabled() {
        try {
            return this._settings?.get_boolean('tiling-enabled') ?? false;
        } catch (e) {
            return false;
        }
    }

    set _tilingEnabled(value) {
        try {
            if (this._settings) {
                this._settings.set_boolean('tiling-enabled', value);
            }
        } catch (e) {
            // Ignore - settings may be unavailable during disable
        }
    }

    // Fix 1: Safe timeout helper that tracks source IDs
    _safeTimeoutAdd(priority, interval, callback) {
        const id = GLib.timeout_add(priority, interval, () => {
            try {
                this._pendingSourceIds?.delete(id);
                return callback();
            } catch (e) {
                logError(e, 'TabbedTiling: Error in extension timeout callback');
                return GLib.SOURCE_REMOVE;
            }
        });
        this._pendingSourceIds?.add(id);
        return id;
    }

    enable() {
        // Fix 5: Wrap entire enable() in try-catch
        try {
            // Don't render tabs/overlays on lock screen or other non-user modes.
            // This prevents tab bars showing above the lock UI.
            if (Main.sessionMode.currentMode !== 'user') {
                return;
            }
            log('Enabling...');

            // Fix 1: Initialize pending source IDs set
            this._pendingSourceIds = new Set();
            // Fix 2: Clear disabled flag
            this._isDisabled = false;

            this._settings = this.getSettings();
            this._configManager = new ConfigManager();
            this._highlighter = new Highlighter();
            this._profileManager = new ProfileManager().load();
            this._windowManager = new WindowManager(this._configManager, this._highlighter, this._profileManager);

            // Read persisted enabled state
            const tilingEnabled = this._tilingEnabled;

            try {
                if (tilingEnabled) {
                    this._windowManager.enable();
                }
                this._addKeybindings();
                this._monitorConfigFiles();

                // System tray icon for profile switching, toggle, and settings
                this._systemTray = new SystemTray(this._profileManager, {
                    onProfileChanged: (profileName) => {
                        log(`Profile switched via tray: ${profileName}`);
                        if (this._tilingEnabled) {
                            this._windowManager.reloadConfiguration();
                        }
                    },
                    onToggle: (enabled) => {
                        this._setTilingEnabled(enabled);
                    },
                    getEnabled: () => this._tilingEnabled,
                    extensionUuid: this.metadata.uuid || 'tabbedtiling@george.com',
                });
                Main.panel.addToStatusArea('tabbedtiling-profile-switcher', this._systemTray);

                log('Enabled successfully.');
            } catch (e) {
                log(`Error during enable: ${e}`);
                this.disable();
            }
        } catch (e) {
            logError(e, 'TabbedTiling: Error in enable()');
        }
    }

    // Fix 8: Settings change signal safety - null checks in _setTilingEnabled
    _setTilingEnabled(enabled) {
        try {
            if (this._isDisabled) return;
            if (enabled === this._tilingEnabled) return;

            this._tilingEnabled = enabled;

            if (enabled) {
                log('Tiling enabled via system tray.');
                if (this._windowManager) {
                    this._windowManager.resume();
                }
            } else {
                log('Tiling disabled via system tray.');
                if (this._windowManager) {
                    this._windowManager.pause();
                }
                // Also clear any live-edit preview overlays
                if (this._highlighter) {
                    this._highlighter.destroyPreviews();
                }
            }
        } catch (e) {
            logError(e, 'TabbedTiling: Error in _setTilingEnabled');
        }
    }

    disable() {
        // Fix 5: Wrap entire disable() in try-catch
        try {
            log('Disabling...');

            // Fix 2: Set disabled flag early
            this._isDisabled = true;

            // Fix 1: Cancel all pending timers before nulling members
            if (this._pendingSourceIds) {
                this._pendingSourceIds.forEach(id => GLib.source_remove(id));
                this._pendingSourceIds.clear();
            }

            this._removeKeybindings();

            // Fix 2: Cancel file monitors
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
            this._pendingSourceIds = null;
            log('Disabled.');
        } catch (e) {
            logError(e, 'TabbedTiling: Error in disable()');
        }
    }

    // Fix 3: Null-check _windowManager in keybinding callbacks + try-catch
    _addKeybindings() {
        const add = (name) => {
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                () => {
                    try {
                        if (!this._windowManager) return;
                        if (name === KEYBINDING_CYCLE_NEXT) this._windowManager.cycleTabNextInFocusedZone();
                        else if (name === KEYBINDING_CYCLE_PREV) this._windowManager.cycleTabPreviousInFocusedZone();
                        else if (name === KEYBINDING_LOG_PRESS) this._windowManager.toggleTabBarsLayer();
                    } catch (e) {
                        logError(e, 'TabbedTiling: Error in keybinding handler');
                    }
                }
            );
        };
        add(KEYBINDING_CYCLE_NEXT);
        add(KEYBINDING_CYCLE_PREV);
        add(KEYBINDING_LOG_PRESS);
    }

    // Fix 4: Safe keybinding removal with try-catch
    _removeKeybindings() {
        for (const name of [KEYBINDING_CYCLE_NEXT, KEYBINDING_CYCLE_PREV, KEYBINDING_LOG_PRESS]) {
            try {
                Main.wm.removeKeybinding(name);
            } catch (e) {
                // Ignore - may not have been added
            }
        }
    }

    _monitorConfigFiles() {
        // Fix 6: Wrap config file monitor setup in try-catch
        try {
            // Monitor the main config file for changes from the preferences window
            const configFile = this._configManager.getConfigFile();
            this._configFileMonitor = configFile.monitor(Gio.FileMonitorFlags.NONE, null);
            this._configFileMonitor.connect('changed', (monitor, file, otherFile, eventType) => {
                // Fix 2: Guard against callbacks after disable
                if (this._isDisabled) return;
                if (!this._configFileMonitor) return;
                if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                    if (!this._tilingEnabled) return;
                    log('Config file changed, reloading zones...');
                    // Fix 1: Use _safeTimeoutAdd instead of bare GLib.timeout_add
                    this._safeTimeoutAdd(GLib.PRIORITY_DEFAULT, 100, () => {
                        if (this._isDisabled) return GLib.SOURCE_REMOVE;
                        if (this._tilingEnabled && this._windowManager) {
                            this._windowManager.reloadConfiguration();
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
        } catch (e) {
            logError(e, 'TabbedTiling: Error setting up config file monitor');
        }

        // Fix 6: Wrap preview file monitor setup in try-catch
        try {
            // Monitor the preview file for requests from the preferences window
            const previewFile = this._configManager.getPreviewFile();
            this._previewFileMonitor = previewFile.monitor(Gio.FileMonitorFlags.NONE, null);
            this._previewFileMonitor.connect('changed', (monitor, file, otherFile, eventType) => {
                // Fix 2: Guard against callbacks after disable
                if (this._isDisabled) return;
                if (!this._previewFileMonitor) return;
                if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                    log('Preview file changed, showing preview...');
                    try {
                        const previewData = this._configManager.loadPreviewZones();
                        if (previewData && this._highlighter) {
                            // Support both array format and object format with persistent flag
                            const zones = Array.isArray(previewData) ? previewData : (previewData.zones || []);
                            const persistent = !Array.isArray(previewData) && previewData.persistent === true;
                            if (zones.length === 0) {
                                this._highlighter.destroyPreviews();
                            } else {
                                this._highlighter.showAllPreviews(zones, persistent);
                            }
                        }
                    } catch (e) {
                        logError(e, 'TabbedTiling: Error handling preview file change');
                    }
                }
            });
        } catch (e) {
            logError(e, 'TabbedTiling: Error setting up preview file monitor');
        }

        // Fix 6: Wrap profiles file monitor setup in try-catch
        try {
            // Monitor profiles.json for active profile changes from prefs window
            const profilesFile = Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_user_config_dir(), 'tabbedtiling', 'profiles.json'])
            );
            if (profilesFile.query_exists(null)) {
                this._profilesFileMonitor = profilesFile.monitor(Gio.FileMonitorFlags.NONE, null);
                this._profilesFileMonitor.connect('changed', (monitor, file, otherFile, eventType) => {
                    // Fix 2: Guard against callbacks after disable
                    if (this._isDisabled) return;
                    if (!this._profilesFileMonitor) return;
                    if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                        log('Profiles file changed, reloading configuration...');
                        // Fix 1: Use _safeTimeoutAdd instead of bare GLib.timeout_add
                        this._safeTimeoutAdd(GLib.PRIORITY_DEFAULT, 100, () => {
                            if (this._isDisabled) return GLib.SOURCE_REMOVE;
                            if (this._tilingEnabled && this._windowManager) {
                                this._windowManager.reloadConfiguration();
                            }
                            // Always refresh tray menu to show updated profiles/active state
                            if (this._systemTray)
                                this._systemTray.refresh();
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                });
            }
        } catch (e) {
            logError(e, 'TabbedTiling: Error setting up profiles file monitor');
        }
    }
}
