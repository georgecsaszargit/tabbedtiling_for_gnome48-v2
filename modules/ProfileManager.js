// modules/ProfileManager.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const log = msg => console.log(`[TabbedTiling.ProfileManager] ${msg}`);
const PROFILES_DIR = 'tabbedtiling';
const PROFILES_FILENAME = 'profiles.json';

export const ProfileManager = GObject.registerClass({
    Signals: {
        'profile-changed': { param_types: [GObject.TYPE_STRING] },
    },
}, class ProfileManager extends GObject.Object {
    constructor() {
        super();
        this._configDir = Gio.File.new_for_path(GLib.get_user_config_dir()).get_child(PROFILES_DIR);
        this._profilesDir = this._configDir.get_child('profiles');
        this._profilesFile = this._configDir.get_child(PROFILES_FILENAME);
        this._profiles = null;
        this._activeProfile = null;

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
        if (!this._profilesDir.query_exists(null)) {
            log('Profiles directory not found, creating it.');
            try {
                this._profilesDir.make_directory_with_parents(null);
            } catch (e) {
                log(`Error creating profiles directory: ${e}`);
            }
        }
    }

    _getDefaultProfilesData() {
        return {
            activeProfile: 'Default',
            profiles: [
                { name: 'Default', createdAt: new Date().toISOString() }
            ]
        };
    }

    _getDefaultZonesConfig() {
        return {
            zones: []
        };
    }

    _loadProfilesFile() {
        if (!this._profilesFile.query_exists(null)) {
            log('Profiles file not found, creating default.');
            const defaultData = this._getDefaultProfilesData();
            this._saveProfilesFile(defaultData);
            // Create default profile directory with empty zones
            this._createProfileDir('Default');
            return defaultData;
        }
        try {
            const [ok, contents] = this._profilesFile.load_contents(null);
            if (ok) {
                return JSON.parse(new TextDecoder().decode(contents));
            }
        } catch (e) {
            log(`Error loading profiles file: ${e}`);
        }
        return this._getDefaultProfilesData();
    }

    _saveProfilesFile(data) {
        try {
            const json = JSON.stringify(data, null, 2);
            this._profilesFile.replace_contents(
                json,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            log('Profiles file saved successfully.');
        } catch (e) {
            log(`Error saving profiles file: ${e}`);
        }
    }

    _createProfileDir(name) {
        const profileDir = this._profilesDir.get_child(this._sanitizeName(name));
        if (!profileDir.query_exists(null)) {
            try {
                profileDir.make_directory_with_parents(null);
                const zonesFile = profileDir.get_child('zones.json');
                const defaultZones = this._getDefaultZonesConfig();
                const json = JSON.stringify(defaultZones, null, 2);
                zonesFile.replace_contents(
                    json,
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null
                );
                log(`Created profile directory: ${name}`);
            } catch (e) {
                log(`Error creating profile directory: ${e}`);
            }
        }
        return profileDir;
    }

    _sanitizeName(name) {
        // Replace characters that are problematic for file paths
        return name.replace(/[\/\\:*?"<>|]/g, '_');
    }

    _getProfileDir(name) {
        return this._profilesDir.get_child(this._sanitizeName(name));
    }

    load() {
        this._profiles = this._loadProfilesFile();
        this._activeProfile = this._profiles.activeProfile || 'Default';
        return this;
    }

    getProfiles() {
        if (!this._profiles) {
            this.load();
        }
        return this._profiles.profiles || [];
    }

    getActiveProfile() {
        if (!this._profiles) {
            this.load();
        }
        return this._activeProfile;
    }

    setActiveProfile(name) {
        if (!this._profiles) {
            this.load();
        }
        // Verify profile exists
        const profile = this._profiles.profiles.find(p => p.name === name);
        if (!profile) {
            log(`Cannot set active profile: ${name} not found`);
            return false;
        }
        this._activeProfile = name;
        this._profiles.activeProfile = name;
        this._saveProfilesFile(this._profiles);
        this.emit('profile-changed', name);
        log(`Active profile set to: ${name}`);
        return true;
    }

    createProfile(name) {
        if (!this._profiles) {
            this.load();
        }
        // Check if name already exists
        if (this._profiles.profiles.find(p => p.name === name)) {
            log(`Profile already exists: ${name}`);
            return false;
        }
        const newProfile = {
            name: name,
            createdAt: new Date().toISOString()
        };
        this._profiles.profiles.push(newProfile);
        this._createProfileDir(name);
        this._saveProfilesFile(this._profiles);
        log(`Created profile: ${name}`);
        return true;
    }

    deleteProfile(name) {
        if (!this._profiles) {
            this.load();
        }
        // Cannot delete the last profile
        if (this._profiles.profiles.length <= 1) {
            log('Cannot delete the last profile');
            return false;
        }
        const index = this._profiles.profiles.findIndex(p => p.name === name);
        if (index === -1) {
            log(`Profile not found: ${name}`);
            return false;
        }
        this._profiles.profiles.splice(index, 1);
        
        // If deleting active profile, switch to first remaining
        if (this._activeProfile === name) {
            this._activeProfile = this._profiles.profiles[0].name;
            this._profiles.activeProfile = this._activeProfile;
        }
        
        this._saveProfilesFile(this._profiles);
        
        // Delete the profile directory
        const profileDir = this._getProfileDir(name);
        if (profileDir.query_exists(null)) {
            this._deleteDirRecursive(profileDir);
        }
        
        log(`Deleted profile: ${name}`);
        return true;
    }

    renameProfile(oldName, newName) {
        if (!this._profiles) {
            this.load();
        }
        // Check if old profile exists
        const profile = this._profiles.profiles.find(p => p.name === oldName);
        if (!profile) {
            log(`Profile not found: ${oldName}`);
            return false;
        }
        // Check if new name already exists
        if (this._profiles.profiles.find(p => p.name === newName)) {
            log(`Profile name already exists: ${newName}`);
            return false;
        }
        
        const oldDir = this._getProfileDir(oldName);
        const newDir = this._getProfileDir(newName);
        
        // Rename directory
        if (oldDir.query_exists(null)) {
            try {
                oldDir.set_display_name(this._sanitizeName(newName));
            } catch (e) {
                log(`Error renaming profile directory: ${e}`);
                return false;
            }
        }
        
        // Update profiles list
        profile.name = newName;
        
        // Update active profile if needed
        if (this._activeProfile === oldName) {
            this._activeProfile = newName;
            this._profiles.activeProfile = newName;
        }
        
        this._saveProfilesFile(this._profiles);
        log(`Renamed profile: ${oldName} -> ${newName}`);
        return true;
    }

    duplicateProfile(sourceName, newName) {
        if (!this._profiles) {
            this.load();
        }
        // Check if source exists
        const source = this._profiles.profiles.find(p => p.name === sourceName);
        if (!source) {
            log(`Source profile not found: ${sourceName}`);
            return false;
        }
        // Check if new name already exists
        if (this._profiles.profiles.find(p => p.name === newName)) {
            log(`Profile name already exists: ${newName}`);
            return false;
        }
        
        // Create new profile entry
        const newProfile = {
            name: newName,
            createdAt: new Date().toISOString()
        };
        this._profiles.profiles.push(newProfile);
        
        // Create directory and copy zones
        const sourceDir = this._getProfileDir(sourceName);
        const newDir = this._createProfileDir(newName);
        
        if (sourceDir.query_exists(null)) {
            const sourceZonesFile = sourceDir.get_child('zones.json');
            if (sourceZonesFile.query_exists(null)) {
                try {
                    const [ok, contents] = sourceZonesFile.load_contents(null);
                    if (ok) {
                        const newZonesFile = newDir.get_child('zones.json');
                        newZonesFile.replace_contents(
                            contents,
                            null,
                            false,
                            Gio.FileCreateFlags.REPLACE_DESTINATION,
                            null
                        );
                    }
                } catch (e) {
                    log(`Error copying zones file: ${e}`);
                }
            }
        }
        
        this._saveProfilesFile(this._profiles);
        log(`Duplicated profile: ${sourceName} -> ${newName}`);
        return true;
    }

    loadProfileConfig(name) {
        const profileDir = this._getProfileDir(name);
        const zonesFile = profileDir.get_child('zones.json');
        
        if (!zonesFile.query_exists(null)) {
            log(`Zones file not found for profile: ${name}`);
            return this._getDefaultZonesConfig();
        }
        
        try {
            const [ok, contents] = zonesFile.load_contents(null);
            if (ok) {
                return JSON.parse(new TextDecoder().decode(contents));
            }
        } catch (e) {
            log(`Error loading zones for profile ${name}: ${e}`);
        }
        return this._getDefaultZonesConfig();
    }

    saveProfileConfig(name, zonesConfig) {
        const profileDir = this._getProfileDir(name);
        
        if (!profileDir.query_exists(null)) {
            this._createProfileDir(name);
        }
        
        const zonesFile = profileDir.get_child('zones.json');
        
        try {
            const json = JSON.stringify(zonesConfig, null, 2);
            zonesFile.replace_contents(
                json,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            log(`Saved zones for profile: ${name}`);
            return true;
        } catch (e) {
            log(`Error saving zones for profile ${name}: ${e}`);
            return false;
        }
    }

    _deleteDirRecursive(dir) {
        try {
            const enumerator = dir.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            let file;
            while ((file = enumerator.next_file(null)) !== null) {
                const child = dir.get_child(file.get_name());
                if (child.query_file_type(null) === Gio.FileType.DIRECTORY) {
                    this._deleteDirRecursive(child);
                } else {
                    child.delete(null);
                }
            }
            dir.delete(null);
        } catch (e) {
            log(`Error deleting directory: ${e}`);
        }
    }

    exportProfile(name) {
        const config = this.loadProfileConfig(name);
        return JSON.stringify(config, null, 2);
    }

    importProfile(name, jsonString) {
        try {
            const config = JSON.parse(jsonString);
            if (!config.zones || !Array.isArray(config.zones)) {
                log('Invalid profile format: missing zones array');
                return false;
            }
            this.createProfile(name);
            this.saveProfileConfig(name, config);
            return true;
        } catch (e) {
            log(`Error importing profile: ${e}`);
            return false;
        }
    }
});
