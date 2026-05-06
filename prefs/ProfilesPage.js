// prefs/ProfilesPage.js — Profiles & Zones page builder
// Runs in the prefs process only (GTK4 / libadwaita, GNOME 48).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import {
    saveConfig,
    loadProfiles,
    saveProfiles,
    loadProfileZones,
    saveProfileZones,
    savePreviewZones,
    clearPreview,
    getConfigDir,
    ensureDirectoryExists,
} from './ConfigIO.js';
import { AutoSaver } from './AutoSaver.js';
import { ZoneEditorRow } from './ZoneEditorRow.js';

const log = msg => console.log(`[TabbedTiling.ProfilesPage] ${msg}`);

// ---------------------------------------------------------------------------
// Helper: delete a directory recursively
// ---------------------------------------------------------------------------

function _deleteDirRecursive(dir) {
    try {
        const enumerator = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const child = dir.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                _deleteDirRecursive(child);
            } else {
                child.delete(null);
            }
        }
        dir.delete(null);
    } catch (e) {
        log(`Error deleting directory: ${e}`);
    }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build the "Profiles & Zones" preferences page.
 * @param {Adw.PreferencesWindow} window - The prefs window (needed for dialogs)
 * @param {Adw.ToastOverlay} toastOverlay - Toast overlay for feedback
 * @param {object} config - Shared configuration object (mutated in place)
 * @returns {Adw.PreferencesPage}
 */
export function buildProfilesPage(window, toastOverlay, config) {
    // Ensure the shared CSS provider is loaded immediately, even before any
    // ZoneEditorRow is constructed (e.g. when the profile has zero zones).
    ZoneEditorRow._ensureCssProvider();

    const page = new Adw.PreferencesPage({
        title: 'Profiles',
        icon_name: 'user-home-symbolic',
    });

    // State
    let profilesData = loadProfiles();
    let activeProfile = profilesData.activeProfile || 'Default';

    // Zone rows storage
    let zoneRows = [];

    // Auto-saver for zones
    const zoneSaver = new AutoSaver(
        () => {
            const zones = zoneRows.map(r => r.getZoneData());
            const ok = saveProfileZones(activeProfile, { zones });
            // Touch config.json so the extension's file monitor triggers a reload
            if (ok) saveConfig(config);
            return ok;
        },
        toastOverlay,
        'Zones saved'
    );

    // Live Edit state
    let liveEditActive = false;
    let liveEditTimerId = 0;
    const LIVE_EDIT_DEBOUNCE_MS = 50;

    const writeLivePreview = () => {
        if (!liveEditActive) return;
        if (liveEditTimerId) {
            GLib.source_remove(liveEditTimerId);
            liveEditTimerId = 0;
        }
        liveEditTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LIVE_EDIT_DEBOUNCE_MS, () => {
            liveEditTimerId = 0;
            try {
                const zones = zoneRows.map(r => r.getZoneData()).filter(z => z.width > 0 && z.height > 0);
                savePreviewZones({ zones, persistent: true });
            } catch (e) {
                log(`Live Edit: error writing preview: ${e}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    };

    const clearLivePreview = () => {
        if (liveEditTimerId) {
            GLib.source_remove(liveEditTimerId);
            liveEditTimerId = 0;
        }
        clearPreview();
    };

    // Resolution state from generator (for zone boundary clamping)
    let generatorResW = config.zoneGenerator?.resW ?? 1920;
    let generatorResH = config.zoneGenerator?.resH ?? 1080;

    // =======================================================================
    // GROUP 1: Profile
    // =======================================================================

    const profileGroup = new Adw.PreferencesGroup({
        title: 'Profile',
        description: 'Select a profile to load its zone layout',
    });
    page.add(profileGroup);

    // --- ComboRow for active profile ---
    const profileModel = new Gtk.StringList();
    profilesData.profiles.forEach(p => profileModel.append(p.name));

    const profileCombo = new Adw.ComboRow({
        title: 'Active Profile',
        model: profileModel,
        selected: Math.max(0, profilesData.profiles.findIndex(p => p.name === activeProfile)),
    });
    profileGroup.add(profileCombo);

    // Rebuild profile combo from current data
    const refreshProfileCombo = () => {
        profilesData = loadProfiles();
        activeProfile = profilesData.activeProfile || 'Default';

        // Rebuild string list
        const model = new Gtk.StringList();
        profilesData.profiles.forEach(p => model.append(p.name));
        profileCombo.set_model(model);
        profileCombo.set_selected(
            Math.max(0, profilesData.profiles.findIndex(p => p.name === activeProfile))
        );
    };

    // Profile combo selection change
    profileCombo.connect('notify::selected', () => {
        const idx = profileCombo.get_selected();
        if (idx < 0 || idx >= profilesData.profiles.length) return;
        const newName = profilesData.profiles[idx].name;
        if (newName === activeProfile) return;

        activeProfile = newName;
        profilesData.activeProfile = newName;
        saveProfiles(profilesData);
        loadZonesForProfile(activeProfile);

        const toast = new Adw.Toast({ title: `Switched to: ${activeProfile}` });
        toastOverlay.add_toast(toast);
    });

    // --- Action buttons row ---
    const actionsRow = new Adw.ActionRow({
        title: 'Manage',
        subtitle: 'Create, duplicate, rename, delete, import, or export profiles',
    });
    profileGroup.add(actionsRow);

    const actionsBox = new Gtk.Box({
        spacing: 6,
        valign: Gtk.Align.CENTER,
    });
    actionsRow.add_suffix(actionsBox);

    // NEW button
    const newBtn = new Gtk.Button({ icon_name: 'list-add-symbolic', tooltip_text: 'New Profile' });
    newBtn.connect('clicked', () => _showNewProfileDialog());
    actionsBox.append(newBtn);

    // DUPLICATE button
    const dupBtn = new Gtk.Button({ icon_name: 'edit-copy-symbolic', tooltip_text: 'Duplicate Profile' });
    dupBtn.connect('clicked', () => _showDuplicateDialog());
    actionsBox.append(dupBtn);

    // RENAME button
    const renameBtn = new Gtk.Button({ icon_name: 'document-edit-symbolic', tooltip_text: 'Rename Profile' });
    renameBtn.connect('clicked', () => _showRenameDialog());
    actionsBox.append(renameBtn);

    // DELETE button
    const deleteBtn = new Gtk.Button({ icon_name: 'user-trash-symbolic', tooltip_text: 'Delete Profile' });
    deleteBtn.add_css_class('destructive-action');
    deleteBtn.connect('clicked', () => _showDeleteDialog());
    actionsBox.append(deleteBtn);

    // IMPORT button
    const importBtn = new Gtk.Button({ icon_name: 'document-open-symbolic', tooltip_text: 'Import Profile' });
    importBtn.connect('clicked', () => _importProfile());
    actionsBox.append(importBtn);

    // EXPORT button
    const exportBtn = new Gtk.Button({ icon_name: 'document-save-symbolic', tooltip_text: 'Export Profile' });
    exportBtn.connect('clicked', () => _exportProfile());
    actionsBox.append(exportBtn);

    // =======================================================================
    // GROUP 2: Zone Generator (collapsible via ExpanderRow)
    // =======================================================================

    const generatorGroup = new Adw.PreferencesGroup({
        title: 'Zone Generator',
        description: 'Quickly create evenly-split horizontal zones for a monitor',
    });
    page.add(generatorGroup);

    const generatorExpander = new Adw.ExpanderRow({
        title: 'Generator Settings',
        subtitle: 'Configure and generate zones',
        expanded: false,
    });
    generatorExpander.add_css_class('generator-expander-row');
    generatorGroup.add(generatorExpander);

    // Monitor Index
    const monAdj = new Gtk.Adjustment({
        lower: 0, upper: 16, step_increment: 1, page_increment: 1,
        value: config.zoneGenerator?.monitorIndex ?? 0,
    });
    const monRow = new Adw.SpinRow({
        title: 'Monitor Index',
        subtitle: 'Target monitor for zone generation',
        adjustment: monAdj,
        numeric: true,
    });
    generatorExpander.add_row(monRow);

    // Resolution Width
    const resWAdj = new Gtk.Adjustment({
        lower: 100, upper: 10000, step_increment: 1, page_increment: 100,
        value: config.zoneGenerator?.resW ?? 1920,
    });
    const resWRow = new Adw.SpinRow({
        title: 'Resolution Width',
        subtitle: 'Monitor width in pixels',
        adjustment: resWAdj,
        numeric: true,
    });
    generatorExpander.add_row(resWRow);

    // Resolution Height
    const resHAdj = new Gtk.Adjustment({
        lower: 100, upper: 10000, step_increment: 1, page_increment: 100,
        value: config.zoneGenerator?.resH ?? 1080,
    });
    const resHRow = new Adw.SpinRow({
        title: 'Resolution Height',
        subtitle: 'Monitor height in pixels',
        adjustment: resHAdj,
        numeric: true,
    });
    generatorExpander.add_row(resHRow);

    // Start X
    const startXAdj = new Gtk.Adjustment({
        lower: 0, upper: 10000, step_increment: 1, page_increment: 100,
        value: config.zoneGenerator?.startX ?? 0,
    });
    const startXRow = new Adw.SpinRow({
        title: 'Start X',
        subtitle: 'Horizontal offset for zone placement',
        adjustment: startXAdj,
        numeric: true,
    });
    generatorExpander.add_row(startXRow);

    // Start Y
    const startYAdj = new Gtk.Adjustment({
        lower: 0, upper: 10000, step_increment: 1, page_increment: 100,
        value: config.zoneGenerator?.startY ?? 0,
    });
    const startYRow = new Adw.SpinRow({
        title: 'Start Y',
        subtitle: 'Vertical offset for zone placement',
        adjustment: startYAdj,
        numeric: true,
    });
    generatorExpander.add_row(startYRow);

    // Number of Zones
    const numZonesAdj = new Gtk.Adjustment({
        lower: 1, upper: 16, step_increment: 1, page_increment: 1,
        value: config.zoneGenerator?.numZones ?? 2,
    });
    const numZonesRow = new Adw.SpinRow({
        title: 'Number of Zones',
        subtitle: 'How many equal-width zones to create',
        adjustment: numZonesAdj,
        numeric: true,
    });
    generatorExpander.add_row(numZonesRow);

    // Generate button row
    const genBtnRow = new Adw.ActionRow({
        title: 'Generate',
        subtitle: 'Replace zones for the selected monitor',
    });
    const genBtn = new Gtk.Button({
        label: 'Generate Zones',
        valign: Gtk.Align.CENTER,
    });
    genBtn.add_css_class('suggested-action');
    genBtnRow.add_suffix(genBtn);
    genBtnRow.activatable_widget = genBtn;
    generatorExpander.add_row(genBtnRow);

    // Persist generator values on change
    const saveGeneratorState = () => {
        config.zoneGenerator = {
            monitorIndex: monAdj.get_value(),
            resW: resWAdj.get_value(),
            resH: resHAdj.get_value(),
            startX: startXAdj.get_value(),
            startY: startYAdj.get_value(),
            numZones: numZonesAdj.get_value(),
        };
        generatorResW = resWAdj.get_value();
        generatorResH = resHAdj.get_value();
        saveConfig(config);
    };

    monAdj.connect('value-changed', saveGeneratorState);
    resWAdj.connect('value-changed', saveGeneratorState);
    resHAdj.connect('value-changed', saveGeneratorState);
    startXAdj.connect('value-changed', saveGeneratorState);
    startYAdj.connect('value-changed', saveGeneratorState);
    numZonesAdj.connect('value-changed', saveGeneratorState);

    // Generate Zones button handler
    genBtn.connect('clicked', () => {
        const monitorIndex = Math.round(monAdj.get_value());
        const resW = Math.round(resWAdj.get_value());
        const resH = Math.round(resHAdj.get_value());
        const startX = Math.round(startXAdj.get_value());
        const startY = Math.round(startYAdj.get_value());
        const numZones = Math.round(numZonesAdj.get_value());

        // Check if zones already exist for this monitor
        const existingForMonitor = zoneRows.filter(
            r => r.getZoneData().monitorIndex === monitorIndex
        );

        if (existingForMonitor.length > 0) {
            // Confirm replacement
            const dialog = new Adw.AlertDialog({
                heading: 'Replace Existing Zones?',
                body: `This will replace ${existingForMonitor.length} existing zone(s) for Monitor ${monitorIndex} in profile "${activeProfile}".`,
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('replace', 'Replace');
            dialog.set_response_appearance('replace', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.connect('response', (_dlg, response) => {
                if (response === 'replace') {
                    _doGenerateZones(monitorIndex, resW, resH, startX, startY, numZones);
                }
            });
            dialog.present(window);
        } else {
            _doGenerateZones(monitorIndex, resW, resH, startX, startY, numZones);
        }
    });

    function _doGenerateZones(monitorIndex, resW, resH, startX, startY, numZones) {
        // Remove existing zones for this monitor
        const rowsToRemove = zoneRows.filter(
            r => r.getZoneData().monitorIndex === monitorIndex
        );
        rowsToRemove.forEach(r => {
            zonesGroup.remove(r);
            zoneRows = zoneRows.filter(row => row !== r);
        });

        // Generate equal-width zones
        const zoneWidth = Math.floor(resW / numZones);
        const newZones = [];
        for (let i = 0; i < numZones; i++) {
            newZones.push({
                name: `Zone ${i + 1}`,
                monitorIndex: monitorIndex,
                x: startX + i * zoneWidth,
                y: startY,
                width: i === numZones - 1 ? resW - i * zoneWidth : zoneWidth,
                height: resH,
                gaps: { top: 8, right: 8, bottom: 8, left: 8 },
                isPrimary: i === 0,
            });
        }

        // Add new zone rows (above manage row)
        zonesGroup.remove(manageRow);
        newZones.forEach((z, idx) => {
            const row = _createZoneRow(z, zoneRows.length + idx);
            zoneRows.push(row);
            zonesGroup.add(row);
        });
        zonesGroup.add(manageRow);

        // Save immediately
        zoneSaver.saveNow();
        writeLivePreview();
    }

    // =======================================================================
    // GROUP 3: Zones
    // =======================================================================

    const zonesGroup = new Adw.PreferencesGroup({
        title: 'Zones',
        description: 'Define rectangles for window snapping and tabbing',
    });
    page.add(zonesGroup);

    // Live Edit toggle row
    const liveEditRow = new Adw.SwitchRow({
        title: 'Live Edit',
        subtitle: 'Show real-time zone boundary overlays while editing',
        active: false,
    });
    zonesGroup.add(liveEditRow);

    liveEditRow.connect('notify::active', () => {
        liveEditActive = liveEditRow.get_active();
        if (liveEditActive) {
            writeLivePreview();
        } else {
            clearLivePreview();
        }
    });

    // --- Manage row (last row in Zones group) ---
    const manageRow = new Adw.ActionRow({
        title: 'Manage',
        subtitle: 'Add or remove zones',
    });
    const manageBox = new Gtk.Box({
        spacing: 6,
        valign: Gtk.Align.CENTER,
    });
    manageRow.add_suffix(manageBox);

    // Add Zone button
    const addZoneBtn = new Gtk.Button({
        icon_name: 'list-add-symbolic',
        tooltip_text: 'Add New Zone',
        valign: Gtk.Align.CENTER,
    });
    manageBox.append(addZoneBtn);

    addZoneBtn.connect('clicked', () => {
        const newZone = {
            name: `Zone ${zoneRows.length + 1}`,
            monitorIndex: 0,
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            gaps: { top: 8, right: 8, bottom: 8, left: 8 },
            isPrimary: false,
        };
        const row = _createZoneRow(newZone, zoneRows.length);
        zoneRows.push(row);
        // Insert above the manage row
        zonesGroup.remove(manageRow);
        zonesGroup.add(row);
        zonesGroup.add(manageRow);
        zoneSaver.queue();
        writeLivePreview();
    });

    // Delete All button
    const deleteAllBtn = new Gtk.Button({
        label: 'Delete All',
        tooltip_text: 'Delete All Zones',
        valign: Gtk.Align.CENTER,
    });
    deleteAllBtn.add_css_class('destructive-action');
    manageBox.append(deleteAllBtn);

    deleteAllBtn.connect('clicked', () => {
        if (zoneRows.length === 0) {
            const toast = new Adw.Toast({ title: 'No zones to delete' });
            toastOverlay.add_toast(toast);
            return;
        }

        const dialog = new Adw.AlertDialog({
            heading: 'Delete All Zones?',
            body: `Are you sure you want to delete all ${zoneRows.length} zone(s) from "${activeProfile}"? This cannot be undone.`,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete All');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');

        dialog.connect('response', (_dlg, response) => {
            if (response === 'delete') {
                // Remove all zone rows from the UI
                zoneRows.forEach(r => zonesGroup.remove(r));
                zoneRows = [];
                zoneSaver.saveNow();
                writeLivePreview();

                const toast = new Adw.Toast({ title: 'All zones deleted' });
                toastOverlay.add_toast(toast);
            }
        });
        dialog.present(window);
    });

    zonesGroup.add(manageRow);

    // Helper: create a ZoneEditorRow with signals connected
    function _createZoneRow(zoneData, index) {
        const row = new ZoneEditorRow(zoneData, index, generatorResW, generatorResH);
        row.connect('zone-changed', () => {
            zoneSaver.queue();
            writeLivePreview();
        });
        row.connect('zone-removed', () => {
            zonesGroup.remove(row);
            zoneRows = zoneRows.filter(r => r !== row);
            // Re-index remaining rows
            zoneRows.forEach((r, i) => { r.zoneIndex = i; });
            zoneSaver.saveNow();
            writeLivePreview();
        });
        return row;
    }

    // Load zones for a profile and rebuild the list
    function loadZonesForProfile(profileName) {
        // Remove existing zone rows
        zoneRows.forEach(r => zonesGroup.remove(r));
        zoneRows = [];

        const data = loadProfileZones(profileName);
        const zones = data.zones || [];

        // Remove manage row so zone rows go above it
        zonesGroup.remove(manageRow);
        zones.forEach((z, idx) => {
            const row = _createZoneRow(z, idx);
            zoneRows.push(row);
            zonesGroup.add(row);
        });
        // Re-add manage row at the bottom
        zonesGroup.add(manageRow);

        // Update live preview if active
        if (liveEditActive) writeLivePreview();
    }

    // Initial zone load
    loadZonesForProfile(activeProfile);

    // =======================================================================
    // Dialog Implementations
    // =======================================================================

    function _showNewProfileDialog() {
        const dialog = new Adw.AlertDialog({
            heading: 'New Profile',
            body: 'Enter a name for the new profile:',
        });
        const entry = new Gtk.Entry({
            placeholder_text: 'Profile name',
            hexpand: true,
        });
        dialog.set_extra_child(entry);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('create', 'Create');
        dialog.set_response_appearance('create', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('create');

        dialog.connect('response', (_dlg, response) => {
            if (response === 'create') {
                const name = entry.get_text().trim();
                if (!name) return;
                if (profilesData.profiles.find(p => p.name === name)) {
                    const errToast = new Adw.Toast({ title: `Profile "${name}" already exists` });
                    toastOverlay.add_toast(errToast);
                    return;
                }
                profilesData.profiles.push({ name, createdAt: new Date().toISOString() });
                saveProfiles(profilesData);

                // Create profile directory with empty zones
                try {
                    ensureDirectoryExists(`profiles/${name}`);
                    saveProfileZones(name, { zones: [] });
                } catch (e) {
                    log(`Error creating profile directory: ${e}`);
                }

                refreshProfileCombo();
                const toast = new Adw.Toast({ title: `Profile "${name}" created` });
                toastOverlay.add_toast(toast);
            }
        });
        dialog.present(window);
    }

    function _showDuplicateDialog() {
        const dialog = new Adw.AlertDialog({
            heading: 'Duplicate Profile',
            body: `Enter a name for the duplicate of "${activeProfile}":`,
        });
        const entry = new Gtk.Entry({
            placeholder_text: 'New profile name',
            text: `${activeProfile} (copy)`,
            hexpand: true,
        });
        dialog.set_extra_child(entry);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('duplicate', 'Duplicate');
        dialog.set_response_appearance('duplicate', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('duplicate');

        dialog.connect('response', (_dlg, response) => {
            if (response === 'duplicate') {
                const name = entry.get_text().trim();
                if (!name) return;
                if (profilesData.profiles.find(p => p.name === name)) {
                    const errToast = new Adw.Toast({ title: `Profile "${name}" already exists` });
                    toastOverlay.add_toast(errToast);
                    return;
                }

                // Copy zones from current profile
                const currentZones = loadProfileZones(activeProfile);
                profilesData.profiles.push({ name, createdAt: new Date().toISOString() });
                saveProfiles(profilesData);

                try {
                    ensureDirectoryExists(`profiles/${name}`);
                    saveProfileZones(name, currentZones);
                } catch (e) {
                    log(`Error duplicating profile: ${e}`);
                }

                refreshProfileCombo();
                const toast = new Adw.Toast({ title: `Profile duplicated as "${name}"` });
                toastOverlay.add_toast(toast);
            }
        });
        dialog.present(window);
    }

    function _showRenameDialog() {
        const dialog = new Adw.AlertDialog({
            heading: 'Rename Profile',
            body: `Enter a new name for "${activeProfile}":`,
        });
        const entry = new Gtk.Entry({
            text: activeProfile,
            placeholder_text: 'Profile name',
            hexpand: true,
        });
        dialog.set_extra_child(entry);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('rename', 'Rename');
        dialog.set_response_appearance('rename', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('rename');

        dialog.connect('response', (_dlg, response) => {
            if (response === 'rename') {
                const newName = entry.get_text().trim();
                if (!newName || newName === activeProfile) return;
                if (profilesData.profiles.find(p => p.name === newName)) {
                    const errToast = new Adw.Toast({ title: `Profile "${newName}" already exists` });
                    toastOverlay.add_toast(errToast);
                    return;
                }

                const profile = profilesData.profiles.find(p => p.name === activeProfile);
                if (!profile) return;

                // Rename the directory
                try {
                    const configDir = getConfigDir();
                    const oldDir = configDir.get_child('profiles').get_child(activeProfile);
                    if (oldDir.query_exists(null)) {
                        oldDir.set_display_name(newName, null);
                    }
                } catch (e) {
                    log(`Error renaming profile directory: ${e}`);
                }

                profile.name = newName;
                profilesData.activeProfile = newName;
                activeProfile = newName;
                saveProfiles(profilesData);

                refreshProfileCombo();
                loadZonesForProfile(activeProfile);

                const toast = new Adw.Toast({ title: `Profile renamed to "${newName}"` });
                toastOverlay.add_toast(toast);
            }
        });
        dialog.present(window);
    }

    function _showDeleteDialog() {
        if (profilesData.profiles.length <= 1) {
            const toast = new Adw.Toast({ title: 'Cannot delete the last profile' });
            toastOverlay.add_toast(toast);
            return;
        }

        const dialog = new Adw.AlertDialog({
            heading: 'Delete Profile?',
            body: `Are you sure you want to delete "${activeProfile}"? This action cannot be undone.`,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');

        dialog.connect('response', (_dlg, response) => {
            if (response === 'delete') {
                const idx = profilesData.profiles.findIndex(p => p.name === activeProfile);
                if (idx === -1) return;

                const deletedName = activeProfile;
                profilesData.profiles.splice(idx, 1);

                // Switch to first remaining profile
                profilesData.activeProfile = profilesData.profiles[0].name;
                activeProfile = profilesData.activeProfile;
                saveProfiles(profilesData);

                // Delete profile directory
                try {
                    const configDir = getConfigDir();
                    const profileDir = configDir.get_child('profiles').get_child(deletedName);
                    if (profileDir.query_exists(null)) {
                        _deleteDirRecursive(profileDir);
                    }
                } catch (e) {
                    log(`Error deleting profile directory: ${e}`);
                }

                refreshProfileCombo();
                loadZonesForProfile(activeProfile);

                const toast = new Adw.Toast({ title: `Profile "${deletedName}" deleted` });
                toastOverlay.add_toast(toast);
            }
        });
        dialog.present(window);
    }

    function _importProfile() {
        const fileDialog = new Gtk.FileDialog({
            title: 'Import Profile Zones',
        });
        const jsonFilter = new Gtk.FileFilter();
        jsonFilter.set_name('JSON Files');
        jsonFilter.add_mime_type('application/json');
        jsonFilter.add_pattern('*.json');
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype });
        filters.append(jsonFilter);
        fileDialog.set_filters(filters);
        fileDialog.set_default_filter(jsonFilter);

        fileDialog.open(window, null, (dialog, result) => {
            try {
                const file = dialog.open_finish(result);
                if (!file) return;

                const [ok, contents] = file.load_contents(null);
                if (!ok) {
                    const toast = new Adw.Toast({ title: 'Failed to read file' });
                    toastOverlay.add_toast(toast);
                    return;
                }

                const json = new TextDecoder().decode(contents);
                const imported = JSON.parse(json);

                // Accept either { zones: [...] } or a raw array
                let zones;
                if (Array.isArray(imported)) {
                    zones = imported;
                } else if (imported && Array.isArray(imported.zones)) {
                    zones = imported.zones;
                } else {
                    const toast = new Adw.Toast({ title: 'Invalid format: expected zones array' });
                    toastOverlay.add_toast(toast);
                    return;
                }

                // Prompt for new profile name
                const nameDialog = new Adw.AlertDialog({
                    heading: 'Import as New Profile',
                    body: 'Enter a name for the imported profile:',
                });
                const entry = new Gtk.Entry({
                    placeholder_text: 'Profile name',
                    text: file.get_basename().replace(/\.json$/i, ''),
                    hexpand: true,
                });
                nameDialog.set_extra_child(entry);
                nameDialog.add_response('cancel', 'Cancel');
                nameDialog.add_response('import', 'Import');
                nameDialog.set_response_appearance('import', Adw.ResponseAppearance.SUGGESTED);

                nameDialog.connect('response', (_dlg, response) => {
                    if (response === 'import') {
                        const name = entry.get_text().trim();
                        if (!name) return;
                        if (profilesData.profiles.find(p => p.name === name)) {
                            const errToast = new Adw.Toast({ title: `Profile "${name}" already exists` });
                            toastOverlay.add_toast(errToast);
                            return;
                        }

                        profilesData.profiles.push({ name, createdAt: new Date().toISOString() });
                        saveProfiles(profilesData);

                        try {
                            ensureDirectoryExists(`profiles/${name}`);
                            saveProfileZones(name, { zones });
                        } catch (e) {
                            log(`Error importing profile: ${e}`);
                        }

                        refreshProfileCombo();
                        const toast = new Adw.Toast({ title: `Profile "${name}" imported` });
                        toastOverlay.add_toast(toast);
                    }
                });
                nameDialog.present(window);
            } catch (e) {
                if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) {
                    log(`Import error: ${e}`);
                    const toast = new Adw.Toast({ title: `Import failed: ${e.message || e}` });
                    toastOverlay.add_toast(toast);
                }
            }
        });
    }

    function _exportProfile() {
        const fileDialog = new Gtk.FileDialog({
            title: 'Export Profile Zones',
            initial_name: `${activeProfile}.json`,
        });

        fileDialog.save(window, null, (dialog, result) => {
            try {
                const file = dialog.save_finish(result);
                if (!file) return;

                const data = loadProfileZones(activeProfile);
                const json = JSON.stringify(data, null, 2);
                file.replace_contents(
                    new TextEncoder().encode(json),
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null
                );

                const toast = new Adw.Toast({ title: `Profile exported to ${file.get_basename()}` });
                toastOverlay.add_toast(toast);
            } catch (e) {
                if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) {
                    log(`Export error: ${e}`);
                    const toast = new Adw.Toast({ title: `Export failed: ${e.message || e}` });
                    toastOverlay.add_toast(toast);
                }
            }
        });
    }

    // =======================================================================
    // Cleanup on window close
    // =======================================================================

    window.connect('close-request', () => {
        if (liveEditTimerId) {
            GLib.source_remove(liveEditTimerId);
            liveEditTimerId = 0;
        }
        if (liveEditActive) clearLivePreview();
        zoneSaver.destroy();
        return false; // allow default close
    });

    return page;
}
