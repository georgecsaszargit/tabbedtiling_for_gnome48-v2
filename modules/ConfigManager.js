// modules/ConfigManager.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const log = msg => console.log(`[TabbedTiling.ConfigManager] ${msg}`);
const CONFIG_DIR = 'tabbedtiling';
const CONFIG_FILENAME = 'config.json';
const PREVIEW_FILENAME = 'preview.json';

export class ConfigManager {
    constructor() {
        this._configDir = Gio.File.new_for_path(GLib.get_user_config_dir()).get_child(CONFIG_DIR);
        this._configFile = this._configDir.get_child(CONFIG_FILENAME);
        this._previewFile = this._configDir.get_child(PREVIEW_FILENAME);
        this._config = null;

        this._ensureDirExists();
    }

    _ensureDirExists() {
        if (!this._configDir.query_exists(null)) {
            log('Config directory not found, creating it.');
            try {
                this._configDir.make_directory_with_parents(null);
            } catch (e) {
                log(`Error creating config directory: ${e}`);
            }
        }
    }
    
    _getDefaultConfig() {
        return {
            zones: [],
            tabBar: {
                height: 32,
                backgroundColor: 'rgba(30, 30, 30, 0.85)',
                cornerRadius: 8,
                iconSize: 16,
                fontSize: 10,
                spacing: 4,
            }
        };
    }

    getConfigFile() {
        return this._configFile;
    }

    getPreviewFile() {
        return this._previewFile;
    }

    load() {
        if (!this._configFile.query_exists(null)) {
            log('Config file not found, creating a default one.');
            this._config = this._getDefaultConfig();
            this.save(this._config);
        } else {
            try {
                const [ok, contents] = this._configFile.load_contents(null);
                if (ok) {
                    this._config = JSON.parse(new TextDecoder().decode(contents));
                } else {
                    throw new Error("Failed to load file contents.");
                }
            } catch (e) {
                log(`Error reading or parsing config file: ${e}. Using default config.`);
                this._config = this._getDefaultConfig();
            }
        }
        return this._config;
    }

    getConfig() {
        return this._config || this.load();
    }

    save(configObject) {
        try {
            const data = JSON.stringify(configObject, null, 2);
            this._configFile.replace_contents(
                data,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            this._config = configObject;
            log('Configuration saved successfully.');
        } catch (e) {
            log(`Error saving configuration: ${e}`);
        }
    }

    savePreviewZones(zones) {
        try {
            const data = JSON.stringify(zones);
            this._previewFile.replace_contents(
                data, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null
            );
        } catch (e) {
            log(`Error saving preview file: ${e}`);
        }
    }

    loadPreviewZones() {
        try {
            const [ok, contents] = this._previewFile.load_contents(null);
            if (ok) {
                return JSON.parse(new TextDecoder().decode(contents));
            }
        } catch (e) {
            log(`Error loading preview file: ${e}`);
        }
        return null;
    }
}
