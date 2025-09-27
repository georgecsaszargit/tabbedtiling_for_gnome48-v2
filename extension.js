// extension.js
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { WindowManager } from './modules/WindowManager.js';
import { ConfigManager } from './modules/ConfigManager.js';
import { Highlighter } from './modules/Highlighter.js';

const log = msg => console.log(`[TabbedTiling] ${msg}`);

export default class TabbedTilingExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._configManager = null;
        this._windowManager = null;
        this._highlighter = null;
        this._configFileMonitor = null;
        this._previewFileMonitor = null;
    }

    enable() {
        // Don’t render tabs/overlays on lock screen or other non-user modes.
        // This prevents tab bars showing above the lock UI.
        if (Main.sessionMode.currentMode !== 'user') {
            return;
        }    
        log('Enabling...');

        this._configManager = new ConfigManager();
        this._highlighter = new Highlighter();
        this._windowManager = new WindowManager(this._configManager, this._highlighter);

        try {
            this._windowManager.enable();
            this._monitorConfigFiles();
            log('Enabled successfully.');
        } catch (e) {
            log(`Error during enable: ${e}`);
            this.disable();
        }
    }

    disable() {
        log('Disabling...');

        if (this._configFileMonitor) {
            this._configFileMonitor.cancel();
            this._configFileMonitor = null;
        }
        if (this._previewFileMonitor) {
            this._previewFileMonitor.cancel();
            this._previewFileMonitor = null;
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
        log('Disabled.');
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
    }
}
