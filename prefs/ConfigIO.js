// prefs/ConfigIO.js — File I/O utilities for the preferences window
// Runs in the prefs process only (no Shell imports).
// Handles config.json, profiles.json, per-profile zones, and preview.json.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const log = msg => console.log(`[TabbedTiling.ConfigIO] ${msg}`);

const CONFIG_DIR_NAME = 'tabbedtiling';
const CONFIG_FILENAME = 'config.json';
const PREVIEW_FILENAME = 'preview.json';
const PROFILES_FILENAME = 'profiles.json';
const PROFILES_SUBDIR = 'profiles';

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

/**
 * Returns the base config directory as a Gio.File (~/.config/tabbedtiling/).
 * @returns {Gio.File}
 */
export function getConfigDir() {
    return Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_config_dir(), CONFIG_DIR_NAME])
    );
}

/**
 * Ensures that a directory exists, creating it (with parents) if needed.
 * @param {string} name - Subdirectory path relative to config dir (e.g. 'profiles/MyProfile')
 */
export function ensureDirectoryExists(name) {
    try {
        const dir = getConfigDir().get_child(name);
        if (!dir.query_exists(null)) {
            dir.make_directory_with_parents(null);
        }
    } catch (e) {
        log(`Error ensuring directory "${name}": ${e}`);
    }
}

/**
 * Ensures the base config dir and profiles subdir both exist.
 */
function _ensureBaseDirectories() {
    try {
        const configDir = getConfigDir();
        if (!configDir.query_exists(null))
            configDir.make_directory_with_parents(null);
    } catch (e) {
        log(`Error ensuring base config dir: ${e}`);
    }
    try {
        const profilesDir = getConfigDir().get_child(PROFILES_SUBDIR);
        if (!profilesDir.query_exists(null))
            profilesDir.make_directory_with_parents(null);
    } catch (e) {
        log(`Error ensuring profiles dir: ${e}`);
    }
}

// ---------------------------------------------------------------------------
// Low-level file I/O
// ---------------------------------------------------------------------------

/**
 * Read a JSON file, returning the parsed object or null on failure.
 * @param {Gio.File} file
 * @returns {any|null}
 */
function _readJson(file) {
    try {
        if (!file.query_exists(null))
            return null;
        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return null;
        return JSON.parse(new TextDecoder().decode(contents));
    } catch (e) {
        log(`Error reading ${file.get_path()}: ${e}`);
        return null;
    }
}

/**
 * Write an object as JSON to a file, creating parent dirs if necessary.
 * @param {Gio.File} file
 * @param {any} data
 * @param {boolean} [pretty=true] - Use indented formatting
 */
function _writeJson(file, data, pretty = true) {
    const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    const bytes = new TextEncoder().encode(json);
    file.replace_contents(
        bytes,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

/**
 * Returns the full default configuration object matching ConfigManager defaults.
 * @returns {object}
 */
export function getDefaultConfig() {
    return {
        zones: [],
        tabBar: {
            height: 32,
            backgroundColor: 'rgba(30, 30, 30, 0.85)',
            activeBgColor: 'rgba(0, 110, 200, 0.8)',
            groupBorderColor: '#4A90E2',
            globalActiveBgColor: 'rgba(255, 230, 0, 0.9)',
            cornerRadius: 8,
            iconSize: 16,
            fontSize: 10,
            spacing: 4,
            maxWidth: 250,
            titleSource: 'windowTitle',
            groupingCriteria: 'appName',
            closeButtonSize: 12,
            sortingCriteria: 'windowTitle',
            sortingOrder: 'ASC',
        },
        exclusions: {
            list: [],
            criteria: 'wmClass',
        },
        zoneGenerator: {
            monitorIndex: 0,
            resW: 1920,
            resH: 1080,
            startX: 0,
            startY: 0,
            numZones: 2,
        },
    };
}

// ---------------------------------------------------------------------------
// config.json
// ---------------------------------------------------------------------------

/**
 * Load config.json, merging missing keys from defaults.
 * Creates a default file if it does not exist.
 * @returns {object} The merged configuration object
 */
export function loadConfig() {
    _ensureBaseDirectories();
    const file = getConfigDir().get_child(CONFIG_FILENAME);
    const parsed = _readJson(file);

    if (!parsed || typeof parsed !== 'object') {
        log('Config file missing or invalid; returning defaults.');
        const defaults = getDefaultConfig();
        // Persist a fresh default so the file exists for the extension
        try { _writeJson(file, defaults); } catch (_e) { /* best effort */ }
        return defaults;
    }

    // Deep-merge top-level keys with defaults
    const defaults = getDefaultConfig();
    for (const key of Object.keys(defaults)) {
        if (!(key in parsed)) {
            parsed[key] = defaults[key];
        } else if (
            typeof defaults[key] === 'object' &&
            defaults[key] !== null &&
            !Array.isArray(defaults[key])
        ) {
            // Merge sub-keys one level deep (e.g. tabBar, exclusions, zoneGenerator)
            for (const subKey of Object.keys(defaults[key])) {
                if (!(subKey in parsed[key])) {
                    parsed[key][subKey] = defaults[key][subKey];
                }
            }
        }
    }

    return parsed;
}

/**
 * Save config object to config.json.
 * @param {object} config - The configuration object to persist
 * @returns {boolean} true on success
 */
export function saveConfig(config) {
    try {
        _ensureBaseDirectories();
        const file = getConfigDir().get_child(CONFIG_FILENAME);
        _writeJson(file, config);
        log('Config saved.');
        return true;
    } catch (e) {
        log(`Error saving config: ${e}`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// profiles.json
// ---------------------------------------------------------------------------

/**
 * Returns the default profiles data structure.
 * @returns {object}
 */
function _getDefaultProfilesData() {
    return {
        activeProfile: 'Default',
        profiles: [
            { name: 'Default', createdAt: new Date().toISOString() },
        ],
    };
}

/**
 * Load profiles.json. Creates a default file + directory if missing.
 * @returns {object} { activeProfile: string, profiles: Array<{name, createdAt}> }
 */
export function loadProfiles() {
    _ensureBaseDirectories();
    const file = getConfigDir().get_child(PROFILES_FILENAME);
    const parsed = _readJson(file);

    if (!parsed || typeof parsed !== 'object') {
        log('Profiles file missing or invalid; creating default.');
        const defaults = _getDefaultProfilesData();
        try {
            _writeJson(file, defaults);
            // Create default profile directory with empty zones
            const profileDir = getConfigDir()
                .get_child(PROFILES_SUBDIR)
                .get_child('Default');
            if (!profileDir.query_exists(null))
                profileDir.make_directory_with_parents(null);
            _writeJson(profileDir.get_child('zones.json'), { zones: [] });
        } catch (_e) { /* best effort */ }
        return defaults;
    }

    // Ensure expected shape
    parsed.profiles ??= [];
    parsed.activeProfile ??= 'Default';
    return parsed;
}

/**
 * Save profiles data to profiles.json.
 * @param {object} data - { activeProfile: string, profiles: Array }
 * @returns {boolean} true on success
 */
export function saveProfiles(data) {
    try {
        _ensureBaseDirectories();
        const file = getConfigDir().get_child(PROFILES_FILENAME);
        _writeJson(file, data);
        log('Profiles saved.');
        return true;
    } catch (e) {
        log(`Error saving profiles: ${e}`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Per-profile zones (profiles/<name>/zones.json)
// ---------------------------------------------------------------------------

/**
 * Sanitize a profile name for filesystem use.
 * @param {string} name
 * @returns {string}
 */
function _sanitizeName(name) {
    return name.replace(/[/\\:*?"<>|]/g, '_');
}

/**
 * Load zones for a given profile.
 * @param {string} name - Profile name
 * @returns {object} { zones: Array }
 */
export function loadProfileZones(name) {
    try {
        const profileDir = getConfigDir()
            .get_child(PROFILES_SUBDIR)
            .get_child(_sanitizeName(name));
        const zonesFile = profileDir.get_child('zones.json');
        const parsed = _readJson(zonesFile);
        if (parsed && typeof parsed === 'object') {
            parsed.zones ??= [];
            return parsed;
        }
    } catch (e) {
        log(`Error loading zones for profile "${name}": ${e}`);
    }
    return { zones: [] };
}

/**
 * Save zones for a given profile. Creates the profile directory if needed.
 * @param {string} name - Profile name
 * @param {object} zones - { zones: Array }
 * @returns {boolean} true on success
 */
export function saveProfileZones(name, zones) {
    try {
        _ensureBaseDirectories();
        const sanitized = _sanitizeName(name);
        const profileDir = getConfigDir()
            .get_child(PROFILES_SUBDIR)
            .get_child(sanitized);
        if (!profileDir.query_exists(null))
            profileDir.make_directory_with_parents(null);

        const zonesFile = profileDir.get_child('zones.json');
        _writeJson(zonesFile, zones);
        log(`Zones saved for profile "${name}".`);
        return true;
    } catch (e) {
        log(`Error saving zones for profile "${name}": ${e}`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// preview.json — live-edit IPC to the running extension
// ---------------------------------------------------------------------------

/**
 * Write preview data for live-edit visualization by the extension.
 * Accepts any JSON-serializable object (typically `{ zones: [...], persistent }`)
 * which the running extension reads from preview.json.
 * @param {object|Array} data - Preview data to write
 * @returns {boolean} true on success
 */
export function savePreviewZones(data) {
    try {
        _ensureBaseDirectories();
        const file = getConfigDir().get_child(PREVIEW_FILENAME);
        _writeJson(file, data, false);
        return true;
    } catch (e) {
        log(`Error saving preview: ${e}`);
        return false;
    }
}

/**
 * Clear the preview file (delete it or write empty content).
 * The extension interprets absence / empty as "no preview active".
 */
export function clearPreview() {
    try {
        const file = getConfigDir().get_child(PREVIEW_FILENAME);
        if (file.query_exists(null)) {
            file.delete(null);
        }
    } catch (e) {
        log(`Error clearing preview: ${e}`);
    }
}
