// prefs/AboutPage.js — About & Maintenance page builder
// Runs in the prefs process only (GTK4 / libadwaita, GNOME 48).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import {
    getConfigDir,
    loadConfig,
    saveConfig,
    getDefaultConfig,
    loadProfiles,
    loadProfileZones,
    saveProfiles,
    saveProfileZones,
} from './ConfigIO.js';

const log = msg => console.log(`[TabbedTiling.AboutPage] ${msg}`);

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build the "About" preferences page.
 * @param {Adw.PreferencesWindow} window - The prefs window (needed for dialogs)
 * @param {Adw.ToastOverlay} toastOverlay - Toast overlay for feedback
 * @returns {Adw.PreferencesPage}
 */
export function buildAboutPage(window, toastOverlay) {
    const page = new Adw.PreferencesPage({
        title: 'About',
        icon_name: 'help-about-symbolic',
    });

    // =======================================================================
    // GROUP 1: About
    // =======================================================================

    const aboutGroup = new Adw.PreferencesGroup({
        title: 'Tabbed Tiling',
        description: 'A tiling window manager extension for GNOME that organizes windows into zones with tabbed interfaces.\n\nVersion 1.0',
    });
    page.add(aboutGroup);

    // =======================================================================
    // GROUP 2: Information
    // =======================================================================

    const infoGroup = new Adw.PreferencesGroup({
        title: 'Information',
    });
    page.add(infoGroup);

    // Config Directory row
    {
        const configPath = getConfigDir().get_path();
        const row = new Adw.ActionRow({
            title: 'Config Directory',
            subtitle: configPath,
        });
        const openBtn = new Gtk.Button({
            label: 'Open',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        openBtn.connect('clicked', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(
                    `file://${configPath}`, null
                );
            } catch (e) {
                log(`Error opening config directory: ${e}`);
                toastOverlay.add_toast(new Adw.Toast({ title: 'Failed to open directory' }));
            }
        });
        row.add_suffix(openBtn);
        infoGroup.add(row);
    }

    // GNOME Shell Version row
    {
        let shellVersion = '48';
        try {
            // Try to read from /usr/share/gnome-shell/org.gnome.Shell for version
            // Fallback: use GLib-based approach
            const [ok, contents] = GLib.file_get_contents('/usr/share/gnome/gnome-version.xml');
            if (ok) {
                const text = new TextDecoder().decode(contents);
                const match = text.match(/<platform>(\d+)<\/platform>/);
                if (match) shellVersion = match[1];
            }
        } catch (_e) {
            // Fallback is already set
        }
        const row = new Adw.ActionRow({
            title: 'GNOME Shell Version',
            subtitle: shellVersion,
        });
        infoGroup.add(row);
    }

    // Extension UUID row
    {
        const row = new Adw.ActionRow({
            title: 'Extension UUID',
            subtitle: 'tabbedtiling@george.com',
        });
        infoGroup.add(row);
    }

    // =======================================================================
    // GROUP 3: Maintenance
    // =======================================================================

    const maintenanceGroup = new Adw.PreferencesGroup({
        title: 'Maintenance',
        description: 'Reset, export, or import extension data',
    });
    page.add(maintenanceGroup);

    // --- Reset All Settings ---
    {
        const row = new Adw.ActionRow({
            title: 'Reset All Settings',
            subtitle: 'Restore all settings to their default values',
        });
        const resetBtn = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        resetBtn.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: 'Reset All Settings?',
                body: 'This will delete your current configuration and restore all settings to their defaults. This action cannot be undone.',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('reset', 'Reset');
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');

            dialog.connect('response', (_dlg, response) => {
                if (response !== 'reset') return;

                try {
                    // Delete existing config file
                    const configFile = getConfigDir().get_child('config.json');
                    if (configFile.query_exists(null)) {
                        configFile.delete(null);
                    }
                    // Save fresh defaults
                    saveConfig(getDefaultConfig());
                    toastOverlay.add_toast(new Adw.Toast({ title: 'Settings reset to defaults' }));
                } catch (e) {
                    log(`Error resetting settings: ${e}`);
                    toastOverlay.add_toast(new Adw.Toast({ title: 'Error resetting settings' }));
                }
            });

            dialog.present(window);
        });
        row.add_suffix(resetBtn);
        maintenanceGroup.add(row);
    }

    // --- Export All Data ---
    {
        const row = new Adw.ActionRow({
            title: 'Export All Data',
            subtitle: 'Export configuration and profiles as a JSON archive',
        });
        const exportBtn = new Gtk.Button({
            label: 'Export',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        exportBtn.connect('clicked', () => {
            const fileDialog = new Gtk.FileDialog({
                title: 'Export Data',
                initial_name: 'tabbedtiling-backup.json',
            });

            fileDialog.save(window, null, (_dialog, result) => {
                try {
                    const file = fileDialog.save_finish(result);
                    if (!file) return;

                    // Build archive
                    const config = loadConfig();
                    const profilesData = loadProfiles();
                    const profileZonesData = {};

                    for (const profile of profilesData.profiles) {
                        const name = profile.name || profile;
                        profileZonesData[name] = loadProfileZones(name);
                    }

                    const archive = {
                        version: 1,
                        config: config,
                        profiles: {
                            activeProfile: profilesData.activeProfile,
                            profiles: profilesData.profiles.map(p => p.name || p),
                            data: profileZonesData,
                        },
                    };

                    const json = JSON.stringify(archive, null, 2);
                    const bytes = new TextEncoder().encode(json);
                    file.replace_contents(
                        bytes,
                        null,
                        false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION,
                        null
                    );

                    toastOverlay.add_toast(new Adw.Toast({ title: 'Data exported' }));
                } catch (e) {
                    if (e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) return;
                    log(`Error exporting data: ${e}`);
                    toastOverlay.add_toast(new Adw.Toast({ title: 'Export failed' }));
                }
            });
        });
        row.add_suffix(exportBtn);
        maintenanceGroup.add(row);
    }

    // --- Import All Data ---
    {
        const row = new Adw.ActionRow({
            title: 'Import All Data',
            subtitle: 'Import configuration and profiles from a JSON archive',
        });
        const importBtn = new Gtk.Button({
            label: 'Import',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        importBtn.connect('clicked', () => {
            const fileDialog = new Gtk.FileDialog({
                title: 'Import Data',
            });

            // Filter to JSON files
            const filter = new Gtk.FileFilter();
            filter.set_name('JSON files');
            filter.add_pattern('*.json');
            filter.add_mime_type('application/json');
            const filterList = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype });
            filterList.append(filter);
            fileDialog.set_filters(filterList);

            fileDialog.open(window, null, (_dialog, result) => {
                try {
                    const file = fileDialog.open_finish(result);
                    if (!file) return;

                    const [ok, contents] = file.load_contents(null);
                    if (!ok) {
                        toastOverlay.add_toast(new Adw.Toast({ title: 'Failed to read file' }));
                        return;
                    }

                    const json = new TextDecoder().decode(contents);
                    const archive = JSON.parse(json);

                    if (!archive || typeof archive !== 'object' || archive.version !== 1) {
                        toastOverlay.add_toast(new Adw.Toast({ title: 'Invalid archive format' }));
                        return;
                    }

                    // Confirm import
                    const dialog = new Adw.AlertDialog({
                        heading: 'Import Data?',
                        body: 'This will overwrite your current configuration and profiles with the imported data. This action cannot be undone.',
                    });
                    dialog.add_response('cancel', 'Cancel');
                    dialog.add_response('import', 'Import');
                    dialog.set_response_appearance('import', Adw.ResponseAppearance.DESTRUCTIVE);
                    dialog.set_default_response('cancel');
                    dialog.set_close_response('cancel');

                    dialog.connect('response', (_dlg, response) => {
                        if (response !== 'import') return;

                        try {
                            // Import config
                            if (archive.config) {
                                saveConfig(archive.config);
                            }

                            // Import profiles
                            if (archive.profiles) {
                                const profileNames = archive.profiles.profiles || [];
                                const profilesForSave = {
                                    activeProfile: archive.profiles.activeProfile || 'Default',
                                    profiles: profileNames.map(name => ({
                                        name,
                                        createdAt: new Date().toISOString(),
                                    })),
                                };
                                saveProfiles(profilesForSave);

                                // Import per-profile zone data
                                if (archive.profiles.data) {
                                    for (const [name, zones] of Object.entries(archive.profiles.data)) {
                                        saveProfileZones(name, zones);
                                    }
                                }
                            }

                            toastOverlay.add_toast(new Adw.Toast({ title: 'Data imported' }));
                        } catch (e) {
                            log(`Error applying imported data: ${e}`);
                            toastOverlay.add_toast(new Adw.Toast({ title: 'Import failed' }));
                        }
                    });

                    dialog.present(window);
                } catch (e) {
                    if (e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) return;
                    log(`Error importing data: ${e}`);
                    toastOverlay.add_toast(new Adw.Toast({ title: 'Import failed' }));
                }
            });
        });
        row.add_suffix(importBtn);
        maintenanceGroup.add(row);
    }

    return page;
}
