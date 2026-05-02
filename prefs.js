// prefs.js — TabbedTiling preferences (GNOME 48 / GJS)
// Works on X11; uses Adw, Gtk, GObject. Stores config in ~/.config/tabbedtiling/config.json

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// If you have a local ConfigManager module, you can keep using it.
// This file includes minimal file I/O, so ConfigManager is optional.
// import { ConfigManager } from './modules/ConfigManager.js';

const log = (msg) => console.log(`[TabbedTilingPrefs] ${msg}`);

const CONFIG_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'tabbedtiling']);
const CONFIG_PATH = GLib.build_filenamev([CONFIG_DIR, 'config.json']);
const PREVIEW_PATH = GLib.build_filenamev([CONFIG_DIR, 'preview.json']);
const PROFILES_PATH = GLib.build_filenamev([CONFIG_DIR, 'profiles.json']);
const PROFILES_DIR = GLib.build_filenamev([CONFIG_DIR, 'profiles']);

function ensureConfigDir() {
    try {
        const f = Gio.File.new_for_path(CONFIG_DIR);
        if (!f.query_exists(null))
            f.make_directory_with_parents(null);
    } catch (e) {
        log(`Failed to ensure config dir: ${e}`);
    }
}

function defaultConfig() {
    return {
        zones: [],
        tabBar: {
            height: 32,
            backgroundColor: 'rgba(30,30,30,0.85)',
            // Color keys already used by TabBar/ConfigManager
            activeBgColor: 'rgba(0, 110, 200, 0.8)',
            groupBorderColor: '#4A90E2',
            globalActiveBgColor: 'rgba(255,230,0,0.9)', // NEW: globally focused tab color
            cornerRadius: 8,
            iconSize: 16,
            fontSize: 10, // in points (pt)
            spacing: 4, // between tabs
            maxWidth: 250, // max width of a single tab
            titleSource: 'windowTitle', // 'windowTitle', 'appName', 'wmClass'
            groupingCriteria: 'appName', // 'appName', 'wmClass'
            closeButtonSize: 12,    
            sortingCriteria: 'windowTitle', // 'windowTitle', 'appName', 'wmClass'
            sortingOrder: 'ASC', // 'ASC', 'DESC'                    
        },
        // NEW: exclusion settings
        exclusions: {
            list: [],
            criteria: 'wmClass', // 'wmClass' or 'appName'
        },        
        // NEW: persisted defaults for the Zone Generator UI
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

function loadConfig() {
    try {
        const file = Gio.File.new_for_path(CONFIG_PATH);
        if (!file.query_exists(null)) {
            log('Config not found; using defaults.');
            return defaultConfig();
        }
        const [ok, bytes] = file.load_contents(null);
        if (!ok) {
            log('Failed to read config; using defaults.');
            return defaultConfig();
        }
        const json = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object')
            return defaultConfig();
        parsed.zones ??= [];
        parsed.tabBar ??= defaultConfig().tabBar;
        // NEW: ensure exclusions key exists
        parsed.exclusions ??= defaultConfig().exclusions;
        return parsed;
    } catch (e) {
        log(`Error loading config: ${e}`);
        return defaultConfig();
    }
}

function saveConfig(cfg) {
    try {
        ensureConfigDir();
        const file = Gio.File.new_for_path(CONFIG_PATH);
        const json = JSON.stringify(cfg, null, 2);
        file.replace_contents(
            new TextEncoder().encode(json),
            null,
            false, // make_backup
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
        log(`Config saved to ${CONFIG_PATH}`);
        return true;
    } catch (e) {
        log(`Error saving config: ${e}`);
        return false;
    }
}

// ---------- Profile Management ----------

function loadProfiles() {
    try {
        const file = Gio.File.new_for_path(PROFILES_PATH);
        if (!file.query_exists(null)) {
            log('Profiles file not found; creating default.');
            return createDefaultProfiles();
        }
        const [ok, bytes] = file.load_contents(null);
        if (!ok) {
            log('Failed to read profiles; using defaults.');
            return createDefaultProfiles();
        }
        const json = new TextDecoder().decode(bytes);
        return JSON.parse(json);
    } catch (e) {
        log(`Error loading profiles: ${e}`);
        return createDefaultProfiles();
    }
}

function createDefaultProfiles() {
    const profiles = {
        activeProfile: 'Default',
        profiles: [
            { name: 'Default', createdAt: new Date().toISOString() }
        ]
    };
    saveProfiles(profiles);
    // Create default profile directory
    ensureProfilesDir();
    const defaultZones = { zones: [] };
    const profileDir = Gio.File.new_for_path(GLib.build_filenamev([PROFILES_DIR, 'Default']));
    if (!profileDir.query_exists(null)) {
        profileDir.make_directory_with_parents(null);
    }
    const zonesPath = GLib.build_filenamev([PROFILES_DIR, 'Default', 'zones.json']);
    const zonesFile = Gio.File.new_for_path(zonesPath);
    zonesFile.replace_contents(
        new TextEncoder().encode(JSON.stringify(defaultZones, null, 2)),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
    );
    return profiles;
}

function saveProfiles(profiles) {
    try {
        ensureConfigDir();
        const file = Gio.File.new_for_path(PROFILES_PATH);
        const json = JSON.stringify(profiles, null, 2);
        file.replace_contents(
            new TextEncoder().encode(json),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
        );
        log(`Profiles saved to ${PROFILES_PATH}`);
        return true;
    } catch (e) {
        log(`Error saving profiles: ${e}`);
        return false;
    }
}

function ensureProfilesDir() {
    try {
        const f = Gio.File.new_for_path(PROFILES_DIR);
        if (!f.query_exists(null))
            f.make_directory_with_parents(null);
    } catch (e) {
        log(`Failed to ensure profiles dir: ${e}`);
    }
}

function loadProfileZones(profileName) {
    try {
        const zonesPath = GLib.build_filenamev([PROFILES_DIR, profileName, 'zones.json']);
        const file = Gio.File.new_for_path(zonesPath);
        if (!file.query_exists(null)) {
            return { zones: [] };
        }
        const [ok, bytes] = file.load_contents(null);
        if (!ok) {
            return { zones: [] };
        }
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        log(`Error loading profile zones: ${e}`);
        return { zones: [] };
    }
}

function saveProfileZones(profileName, zones) {
    try {
        ensureProfilesDir();
        const profileDir = Gio.File.new_for_path(GLib.build_filenamev([PROFILES_DIR, profileName]));
        if (!profileDir.query_exists(null)) {
            profileDir.make_directory_with_parents(null);
        }
        const zonesPath = GLib.build_filenamev([PROFILES_DIR, profileName, 'zones.json']);
        const file = Gio.File.new_for_path(zonesPath);
        file.replace_contents(
            new TextEncoder().encode(JSON.stringify(zones, null, 2)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
        );
        log(`Saved zones for profile: ${profileName}`);
        return true;
    } catch (e) {
        log(`Error saving profile zones: ${e}`);
        return false;
    }
}

// ---------- Zone Editor Row ----------

/**
 * ZoneEditorRow
 * Expandable row to edit a single zone.
 * Zone fields: name, monitorIndex, x, y, width, height, gaps{top,right,bottom,left}, isPrimary
 */
const ZoneEditorRow = GObject.registerClass(
class ZoneEditorRow extends Adw.ExpanderRow {
    _init(zoneData, onRemove) {
        super._init({
            title: zoneData?.name || _('Unnamed Zone'),
            subtitle: `X:${zoneData?.x ?? 0}, Y:${zoneData?.y ?? 0}, W:${zoneData?.width ?? 0}, H:${zoneData?.height ?? 0}`,
            expanded: false,
        });

        this._onRemove = onRemove;
        // Normalize legacy 'gap' into per-side gaps if present
        const legacyGap = (zoneData?.gap ?? null);
        const normGaps = (zoneData?.gaps && typeof zoneData.gaps === 'object')
            ? {
                top: Number(zoneData.gaps.top ?? 8),
                right: Number(zoneData.gaps.right ?? 8),
                bottom: Number(zoneData.gaps.bottom ?? 8),
                left: Number(zoneData.gaps.left ?? 8),
              }
            : {
                top: Number(legacyGap ?? 8),
                right: Number(legacyGap ?? 8),
                bottom: Number(legacyGap ?? 8),
                left: Number(legacyGap ?? 8),
              };

        this._zone = {
            name: zoneData?.name ?? '',
            monitorIndex: zoneData?.monitorIndex ?? 0,
            x: zoneData?.x ?? 0,
            y: zoneData?.y ?? 0,
            width: zoneData?.width ?? 0,
            height: zoneData?.height ?? 0,
            gaps: normGaps,
            isPrimary: zoneData?.isPrimary ?? false,
        };

        // Action row (right side) — Remove button
        const removeBtn = new Gtk.Button({ label: _('Remove'), valign: Gtk.Align.CENTER });
        removeBtn.add_css_class('destructive-action');
        removeBtn.connect('clicked', () => {
            if (typeof this._onRemove === 'function')
                this._onRemove(this);
        });
        this.add_action(removeBtn);

        // Content grid
        const grid = new Gtk.Grid({ column_spacing: 12, row_spacing: 6, margin_top: 6, margin_bottom: 6 });
        this.add_row(grid);

        // Helper builders
        const labeledEntry = (label, initial, onChanged) => {
            const row = new Adw.ActionRow({ title: label });
            const entry = new Gtk.Entry({ hexpand: true, text: `${initial ?? ''}` });
            entry.connect('changed', () => onChanged(entry.get_text()));
            row.add_suffix(entry);
            row.activatable_widget = entry;
            return [row, entry];
        };

        const labeledSpin = (label, initial, min, max, step, onChanged) => {
            const row = new Adw.ActionRow({ title: label });
            const adj = new Gtk.Adjustment({ lower: min, upper: max, step_increment: step, page_increment: step * 10, value: initial });
            const spin = new Gtk.SpinButton({ halign: Gtk.Align.END, adjustment: adj, climb_rate: 1, digits: 0 });
            spin.connect('value-changed', () => onChanged(spin.get_value_as_int()));
            row.add_suffix(spin);
            row.activatable_widget = spin;
            return [row, spin];
        };

        const labeledSwitch = (label, initial, onChanged) => {
            const row = new Adw.ActionRow({ title: label });
            const sw = new Gtk.Switch({
                active: initial,
                halign: Gtk.Align.END,
                valign: Gtk.Align.CENTER,
                hexpand: false,
                vexpand: false,
            });
            sw.connect('state-set', (_w, state) => {
                onChanged(state);
                return false; // allow default
            });
            row.add_suffix(sw);
            row.activatable_widget = sw;
            return [row, sw];
        };

        // Name
        const [nameRow, nameEntry] = labeledEntry(_('Name'), this._zone.name, (v) => {
            this._zone.name = v;
            this.title = v || _('Unnamed Zone');
        });
        grid.attach(nameRow, 0, 0, 1, 1);

        // Monitor index
        const [monRow, monSpin] = labeledSpin(_('Monitor Index'), this._zone.monitorIndex, 0, 63, 1, (v) => {
            this._zone.monitorIndex = v;
        });
        grid.attach(monRow, 0, 1, 1, 1);

        // X, Y, Width, Height
        const [xRow, xSpin] = labeledSpin(_('X'), this._zone.x, -10000, 10000, 1, (v) => { this._zone.x = v; this._refreshSubtitle(); });
        grid.attach(xRow, 0, 2, 1, 1);
        const [yRow, ySpin] = labeledSpin(_('Y'), this._zone.y, -10000, 10000, 1, (v) => { this._zone.y = v; this._refreshSubtitle(); });
        grid.attach(yRow, 0, 3, 1, 1);
        const [wRow, wSpin] = labeledSpin(_('Width'), this._zone.width, 0, 100000, 1, (v) => { this._zone.width = v; this._refreshSubtitle(); });
        grid.attach(wRow, 0, 4, 1, 1);
        const [hRow, hSpin] = labeledSpin(_('Height'), this._zone.height, 0, 100000, 1, (v) => { this._zone.height = v; this._refreshSubtitle(); });
        grid.attach(hRow, 0, 5, 1, 1);

        // Per-side Gaps
        const [gapTopRow, gapTopSpin] = labeledSpin(_('Gap Top'), this._zone.gaps.top, 0, 256, 1, (v) => { this._zone.gaps.top = v; });
        grid.attach(gapTopRow, 0, 6, 1, 1);
        const [gapRightRow, gapRightSpin] = labeledSpin(_('Gap Right'), this._zone.gaps.right, 0, 256, 1, (v) => { this._zone.gaps.right = v; });
        grid.attach(gapRightRow, 0, 7, 1, 1);
        const [gapBottomRow, gapBottomSpin] = labeledSpin(_('Gap Bottom'), this._zone.gaps.bottom, 0, 256, 1, (v) => { this._zone.gaps.bottom = v; });
        grid.attach(gapBottomRow, 0, 8, 1, 1);
        const [gapLeftRow, gapLeftSpin] = labeledSpin(_('Gap Left'), this._zone.gaps.left, 0, 256, 1, (v) => { this._zone.gaps.left = v; });
        grid.attach(gapLeftRow, 0, 9, 1, 1);

        // isPrimary — place AFTER per-side gaps, at the end of the editor
        const [primRow, primSwitch] = labeledSwitch(_('Primary Zone'), this._zone.isPrimary, (v) => { this._zone.isPrimary = v; });
        primRow.set_margin_top(6);
        // Current rows occupy 0..9 after adding Gap Top/Right/Bottom/Left.
        // Attach Primary Zone on the next free row index to ensure it appears at the end.
        grid.attach(primRow, 0, 10, 1, 1);
    }

    _refreshSubtitle() {
        this.subtitle = `X:${this._zone.x}, Y:${this._zone.y}, W:${this._zone.width}, H:${this._zone.height}`;
    }

    getZone() {
        // Ensure legacy 'gap' is not written back; only persist 'gaps'
        const { name, monitorIndex, x, y, width, height, gaps, isPrimary } = this._zone;
        return { name, monitorIndex, x, y, width, height, gaps, isPrimary };
    }
});

// ---------- Profile Selector Card ----------

/**
 * ProfileSelectorCard
 * A prominent card showing the active profile with a dropdown to switch profiles.
 */
const ProfileSelectorCard = GObject.registerClass(
class ProfileSelectorCard extends Adw.Bin {
    _init(onProfileChanged) {
        super._init({
            hexpand: true,
            vexpand: false,
        });

        this._onProfileChanged = onProfileChanged;
        this._activeProfile = 'Default';
        this._profiles = [];

        // Main card container
        this._card = new Adw.Bin();
        this._card.add_css_class('card');
        this.set_child(this._card);

        // Content box
        const contentBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        this._card.set_child(contentBox);

        // Header row with icon, title, and dropdown button
        const headerBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
        });
        contentBox.append(headerBox);

        // Profile icon
        const icon = new Gtk.Image({
            icon_name: 'x-office-document-symbolic',
            pixel_size: 24,
            halign: Gtk.Align.START,
        });
        headerBox.append(icon);

        // Title and subtitle
        const textBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            halign: Gtk.Align.START,
        });
        headerBox.append(textBox);

        this._titleLabel = new Gtk.Label({
            label: _('Active Profile'),
            halign: Gtk.Align.START,
            valign: Gtk.Align.BASELINE,
            css_classes: ['title'],
        });
        textBox.append(this._titleLabel);

        this._subtitleLabel = new Gtk.Label({
            label: this._activeProfile,
            halign: Gtk.Align.START,
            valign: Gtk.Align.BASELINE,
            css_classes: ['subtitle', 'dim-label'],
        });
        textBox.append(this._subtitleLabel);

        // Dropdown button
        this._dropdownBtn = new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            popover: null,
        });
        headerBox.append(this._dropdownBtn);

        // Create popover for profile selection
        this._popover = new Gtk.Popover();
        this._popover.set_child(this._createPopoverContent());
        this._dropdownBtn.set_popover(this._popover);

        // Description text
        const descLabel = new Gtk.Label({
            label: _('Select a profile to edit its zones. Switch profiles using the system tray icon.'),
            halign: Gtk.Align.START,
            wrap: true,
            css_classes: ['caption', 'dim-label'],
        });
        contentBox.append(descLabel);

        this._refreshProfiles();
    }

    _createPopoverContent() {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });

        // Profile list
        this._profileListBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
        });
        box.append(this._profileListBox);

        // Separator
        const sep = new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL });
        box.append(sep);

        // Manage profiles button
        const manageBtn = new Gtk.Button({
            label: _('Manage Profiles...'),
            icon_name: 'emblem-system-symbolic',
            halign: Gtk.Align.FILL,
        });
        manageBtn.connect('clicked', () => {
            this._popover.popdown();
            if (this._onManageProfiles) {
                this._onManageProfiles();
            }
        });
        box.append(manageBtn);

        return box;
    }

    _refreshProfiles() {
        // Clear existing list
        let children;
        try {
            children = this._profileListBox.get_children();
        } catch (e) {
            children = [];
        }
        for (let i = children.length - 1; i >= 0; i--) {
            this._profileListBox.remove(children[i]);
        }

        // Load profiles
        const data = loadProfiles();
        this._profiles = data.profiles;
        this._activeProfile = data.activeProfile || 'Default';

        // Update header
        this._subtitleLabel.set_label(this._activeProfile);

        // Add profile items
        this._profiles.forEach(profile => {
            const isActive = profile.name === this._activeProfile;
            const row = new Adw.ActionRow({
                title: profile.name,
                subtitle: isActive ? _('(current)') : '',
                activatable: true,
            });

            if (isActive) {
                row.add_suffix(new Gtk.Image({
                    icon_name: 'emblem-ok-symbolic',
                    css_classes: ['dim-label'],
                }));
            }

            row.connect('activated', () => {
                this._setActiveProfile(profile.name);
            });

            this._profileListBox.append(row);
        });
    }

    _setActiveProfile(name) {
        if (name === this._activeProfile) {
            this._popover.popdown();
            return;
        }

        const data = loadProfiles();
        const profile = data.profiles.find(p => p.name === name);
        if (!profile) {
            this._popover.popdown();
            return;
        }

        data.activeProfile = name;
        saveProfiles(data);
        this._activeProfile = name;
        this._refreshProfiles();

        if (this._onProfileChanged) {
            this._onProfileChanged(name);
        }

        this._popover.popdown();
    }

    setOnManageProfiles(callback) {
        this._onManageProfiles = callback;
    }

    getActiveProfile() {
        return this._activeProfile;
    }

    refresh() {
        this._refreshProfiles();
    }
});

// ---------- Profile Context Banner ----------

/**
 * ProfileContextBanner
 * A warning-style banner showing which profile's zones are being edited.
 */
const ProfileContextBanner = GObject.registerClass(
class ProfileContextBanner extends Adw.Bin {
    _init(profileName) {
        super._init({
            hexpand: true,
            vexpand: false,
            visible: true,
        });

        this._profileName = profileName || 'Default';

        // Container with warning style
        const card = new Adw.Bin();
        card.add_css_class('card');
        card.add_css_class('warning');
        this.set_child(card);

        const contentBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 12,
            margin_end: 12,
            hexpand: true,
        });
        card.set_child(contentBox);

        // Warning icon
        const icon = new Gtk.Image({
            icon_name: 'dialog-information-symbolic',
            pixel_size: 20,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
        });
        contentBox.append(icon);

        // Text content
        const textBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
        });
        contentBox.append(textBox);

        this._titleLabel = new Gtk.Label({
            halign: Gtk.Align.START,
            valign: Gtk.Align.BASELINE,
            wrap: true,
            css_classes: ['title'],
        });
        textBox.append(this._titleLabel);

        this._subtitleLabel = new Gtk.Label({
            halign: Gtk.Align.START,
            valign: Gtk.Align.BASELINE,
            wrap: true,
            css_classes: ['caption', 'dim-label'],
        });
        textBox.append(this._subtitleLabel);

        // Call _updateText after both labels are created and appended
        this._updateText();
    }

    _updateText() {
        this._titleLabel.set_label(
            `<b>${_('Editing zones for profile:')}</b> <b>${this._profileName}</b>`
        );
        this._titleLabel.use_markup = true;
        this._subtitleLabel.set_label(
            _('These zones will be active when this profile is selected in the system tray.')
        );
    }

    setProfileName(name) {
        this._profileName = name || 'Default';
        this._updateText();
    }
});

// ---------- Profile Management Dialog ----------

/**
 * ProfileManagementDialog
 * A popover for creating, renaming, and deleting profiles.
 */
const ProfileManagementDialog = GObject.registerClass(
class ProfileManagementDialog extends Gtk.Popover {
    _init(parent, onProfilesChanged) {
        super._init({
            modal: true,
            child: null,
        });

        this._parent = parent;
        this._onProfilesChanged = onProfilesChanged;
        this._profiles = [];
        this._selectedIndex = -1;

        const contentBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
            width_request: 320,
        });
        this.set_child(contentBox);

        // Title
        const titleLabel = new Gtk.Label({
            label: '<b>' + _('Manage Profiles') + '</b>',
            use_markup: true,
            halign: Gtk.Align.START,
        });
        contentBox.append(titleLabel);

        // Profile list in scrolled window
        const scrolled = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            min_content_height: 150,
            max_content_height: 200,
        });

        this._profileListBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
        });
        scrolled.set_child(this._profileListBox);
        contentBox.append(scrolled);

        // Action buttons
        const actionsBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.END,
        });
        contentBox.append(actionsBox);

        const addBtn = new Gtk.Button({
            label: _('New'),
            icon_name: 'list-add-symbolic',
        });
        addBtn.connect('clicked', () => this._showCreateDialog());
        actionsBox.append(addBtn);

        this._renameBtn = new Gtk.Button({
            label: _('Rename'),
            icon_name: 'document-edit-symbolic',
            sensitive: false,
        });
        this._renameBtn.connect('clicked', () => this._showRenameDialog());
        actionsBox.append(this._renameBtn);

        this._deleteBtn = new Gtk.Button({
            label: _('Delete'),
            icon_name: 'user-trash-symbolic',
            sensitive: false,
        });
        this._deleteBtn.connect('clicked', () => this._showDeleteConfirmation());
        actionsBox.append(this._deleteBtn);

        this._loadProfiles();
    }

    _loadProfiles() {
        const data = loadProfiles();
        this._profiles = data.profiles;

        // Clear list
        let children;
        try {
            children = this._profileListBox.get_children();
        } catch (e) {
            children = [];
        }
        for (let i = children.length - 1; i >= 0; i--) {
            this._profileListBox.remove(children[i]);
        }

        // Add profile rows
        this._profiles.forEach((profile, index) => {
            const isActive = profile.name === data.activeProfile;
            const row = new Adw.ActionRow({
                title: profile.name + (isActive ? ' ★' : ''),
                subtitle: profile.createdAt ? new Date(profile.createdAt).toLocaleString() : '',
                activatable: true,
            });

            row.connect('activated', () => {
                this._selectedIndex = index;
                this._renameBtn.set_sensitive(true);
                this._deleteBtn.set_sensitive(this._profiles.length > 1);
            });

            this._profileListBox.append(row);
        });
    }

    _showCreateDialog() {
        const dialog = new Adw.MessageDialog({
            title: _('Create New Profile'),
            body: _('Enter a name for the new profile:'),
            transient_for: this,
            modal: true,
        });

        const entry = new Gtk.Entry({
            placeholder_text: _('Profile name'),
            hexpand: true,
        });

        dialog.set_extra_child(entry);

        dialog.add_buttons([
            { label: _('Cancel'), response: Gtk.ResponseType.CANCEL },
            { label: _('Create'), response: Gtk.ResponseType.ACCEPT },
        ]);

        dialog.connect('response', (dlg, response) => {
            if (response === Gtk.ResponseType.ACCEPT) {
                const name = entry.get_text().trim();
                if (name && !this._profiles.find(p => p.name === name)) {
                    const data = loadProfiles();
                    data.profiles.push({ name, createdAt: new Date().toISOString() });
                    saveProfiles(data);

                    // Create profile directory
                    ensureProfilesDir();
                    const profileDir = Gio.File.new_for_path(GLib.build_filenamev([PROFILES_DIR, name]));
                    profileDir.make_directory_with_parents(null);
                    const zonesPath = GLib.build_filenamev([PROFILES_DIR, name, 'zones.json']);
                    const zonesFile = Gio.File.new_for_path(zonesPath);
                    zonesFile.replace_contents(
                        new TextEncoder().encode(JSON.stringify({ zones: [] }, null, 2)),
                        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
                    );

                    this._loadProfiles();
                    if (this._onProfilesChanged) {
                        this._onProfilesChanged();
                    }
                }
            }
            dlg.destroy();
        });

        dialog.present();
        entry.grab_focus();
    }

    _showRenameDialog() {
        if (this._selectedIndex < 0 || this._selectedIndex >= this._profiles.length) {
            return;
        }

        const profile = this._profiles[this._selectedIndex];
        const dialog = new Adw.MessageDialog({
            title: _('Rename Profile'),
            body: _('Enter a new name for the profile:'),
            transient_for: this,
            modal: true,
        });

        const entry = new Gtk.Entry({
            text: profile.name,
            placeholder_text: _('Profile name'),
            hexpand: true,
        });

        dialog.set_extra_child(entry);

        dialog.add_buttons([
            { label: _('Cancel'), response: Gtk.ResponseType.CANCEL },
            { label: _('Rename'), response: Gtk.ResponseType.ACCEPT },
        ]);

        dialog.connect('response', (dlg, response) => {
            if (response === Gtk.ResponseType.ACCEPT) {
                const newName = entry.get_text().trim();
                if (newName && newName !== profile.name && !this._profiles.find(p => p.name === newName)) {
                    const data = loadProfiles();
                    const profileData = data.profiles.find(p => p.name === profile.name);
                    if (profileData) {
                        // Rename directory
                        const oldDir = Gio.File.new_for_path(GLib.build_filenamev([PROFILES_DIR, profile.name]));
                        const newDir = Gio.File.new_for_path(GLib.build_filenamev([PROFILES_DIR, newName]));
                        if (oldDir.query_exists(null)) {
                            oldDir.set_display_name(newName);
                        }
                        profileData.name = newName;
                        if (data.activeProfile === profile.name) {
                            data.activeProfile = newName;
                        }
                        saveProfiles(data);
                        this._loadProfiles();
                        if (this._onProfilesChanged) {
                            this._onProfilesChanged();
                        }
                    }
                }
            }
            dlg.destroy();
        });

        dialog.present();
        entry.grab_focus();
    }

    _showDeleteConfirmation() {
        if (this._selectedIndex < 0 || this._selectedIndex >= this._profiles.length) {
            return;
        }

        const profile = this._profiles[this._selectedIndex];
        if (this._profiles.length <= 1) {
            const errorDialog = new Adw.MessageDialog({
                title: _('Cannot Delete'),
                body: _('You must have at least one profile.'),
                transient_for: this,
                modal: true,
            });
            errorDialog.add_buttons([{ label: _('OK'), response: Gtk.ResponseType.ACCEPT }]);
            errorDialog.connect('response', (dlg) => dlg.destroy());
            errorDialog.present();
            return;
        }

        const dialog = new Adw.MessageDialog({
            title: _('Delete Profile'),
            body: `Are you sure you want to delete "${profile.name}"? This action cannot be undone.`,
            transient_for: this,
            modal: true,
        });

        dialog.add_buttons([
            { label: _('Cancel'), response: Gtk.ResponseType.CANCEL },
            { label: _('Delete'), response: Gtk.ResponseType.ACCEPT },
        ]);
        dialog.add_css_class('destructive-action');

        dialog.connect('response', (dlg, response) => {
            if (response === Gtk.ResponseType.ACCEPT) {
                const data = loadProfiles();
                const idx = data.profiles.findIndex(p => p.name === profile.name);
                if (idx !== -1) {
                    data.profiles.splice(idx, 1);
                    if (data.activeProfile === profile.name) {
                        data.activeProfile = data.profiles[0].name;
                    }
                    saveProfiles(data);

                    // Delete profile directory
                    const profileDir = Gio.File.new_for_path(GLib.build_filenamev([PROFILES_DIR, profile.name]));
                    if (profileDir.query_exists(null)) {
                        this._deleteDirRecursive(profileDir);
                    }

                    this._selectedIndex = -1;
                    this._renameBtn.set_sensitive(false);
                    this._deleteBtn.set_sensitive(false);
                    this._loadProfiles();
                    if (this._onProfilesChanged) {
                        this._onProfilesChanged();
                    }
                }
            }
            dlg.destroy();
        });

        dialog.present();
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
});

// ---------- Preferences Window ----------

export default class TabbedTilingPrefs extends ExtensionPreferences {
    _rgbaFromString(str, fallbackStr) {
        const rgba = new Gdk.RGBA();
        if (str && rgba.parse(str))
            return rgba;
        const fb = new Gdk.RGBA();
        fb.parse(fallbackStr || 'rgba(0,0,0,1)');
        return fb;
    }
    _colorPickerRow({ parentGroup, title, subtitle, initial }) {
        const row = new Adw.ActionRow({ title, subtitle });
        const dialog = new Gtk.ColorDialog({ with_alpha: true });
        const btn = new Gtk.ColorDialogButton({ dialog, halign: Gtk.Align.END });
        btn.set_rgba(this._rgbaFromString(initial, 'rgba(0,0,0,1)'));
        row.add_suffix(btn);
        row.activatable_widget = btn;
        parentGroup.add(row);
        return btn;
    }
    _createSpinRow(parentGroup, title, initialValue, min, max, step) {
        const row = new Adw.ActionRow({ title });
        const adj = new Gtk.Adjustment({
            lower: min,
            upper: max,
            step_increment: step,
            page_increment: step * 10,
            value: initialValue,
        });
        const spin = new Gtk.SpinButton({
            halign: Gtk.Align.END,
            adjustment: adj,
            climb_rate: 1,
            digits: 0,
        });
        row.add_suffix(spin);
        row.activatable_widget = spin;
        parentGroup.add(row);
        return spin;
    }
    fillPreferencesWindow(window) {
        // Make sure Adw preferences styling is initialized
        Adw.init();

        log('fillPreferencesWindow: Starting');
        log(`fillPreferencesWindow: Adw version = ${Adw.MAJOR_VERSION}.${Adw.MINOR_VERSION}`);

        const cfg = loadConfig();
        const genDefaults = { ...defaultConfig().zoneGenerator, ...(cfg.zoneGenerator ?? {}) };

        // ========== PAGE 1: PROFILES ==========
        const profilesPage = new Adw.PreferencesPage({
            title: _('Profiles'),
            icon_name: 'user-home-symbolic',
        });
        window.add(profilesPage);
        log('fillPreferencesWindow: Added PAGE 1 (Profiles)');

        // Profile selector section
        const profileSelectorGroup = new Adw.PreferencesGroup({
            title: _('Profile'),
            description: _('Select a profile to edit its zones. Switch profiles using the system tray icon.'),
        });
        profilesPage.add(profileSelectorGroup);

        // Get active profile
        const profilesData = loadProfiles();
        let activeProfile = profilesData.activeProfile || 'Default';

        // Profile dropdown
        const profileNames = profilesData.profiles.map(p => p.name);
        const profileModel = new Gtk.StringList();
        profileNames.forEach(name => profileModel.append(name));

        const profileDropdownRow = new Adw.ComboRow({
            title: _('Active Profile'),
            model: profileModel,
            selected: profilesData.profiles.findIndex(p => p.name === activeProfile),
        });
        profileSelectorGroup.add(profileDropdownRow);

        // Profile management buttons
        const profileActionsBox = new Gtk.Box({ spacing: 8 });
        const newProfileBtn = new Gtk.Button({ label: _('New'), icon_name: 'list-add-symbolic' });
        const renameProfileBtn = new Gtk.Button({ label: _('Rename'), icon_name: 'document-edit-symbolic' });
        const deleteProfileBtn = new Gtk.Button({ label: _('Delete'), icon_name: 'user-trash-symbolic' });
        const loadProfileBtn = new Gtk.Button({ label: _('Load'), icon_name: 'media-playback-start-symbolic' });
        loadProfileBtn.add_css_class('suggested-action');
        profileActionsBox.append(newProfileBtn);
        profileActionsBox.append(renameProfileBtn);
        profileActionsBox.append(deleteProfileBtn);
        profileActionsBox.append(loadProfileBtn);
        const profileActionsRow = new Adw.ActionRow();
        profileActionsRow.set_child(profileActionsBox);
        profileSelectorGroup.add(profileActionsRow);

        // Zone Generator section
        const generatorGroup = new Adw.PreferencesGroup({
            title: _('Zone Generator'),
            description: _('Quickly create a set of horizontal zones for a monitor.'),
        });
        profilesPage.add(generatorGroup);

        const monSpin = this._createSpinRow(generatorGroup, _('Monitor Index'), genDefaults.monitorIndex, 0, 16, 1);
        const resWSpin = this._createSpinRow(generatorGroup, _('Monitor Resolution Width'), genDefaults.resW, 0, 10000, 1);
        const resHSpin = this._createSpinRow(generatorGroup, _('Monitor Resolution Height'), genDefaults.resH, 0, 10000, 1);
        const xSpin = this._createSpinRow(generatorGroup, _('Start X Coordinate'), genDefaults.startX, 0, 10000, 1);
        const ySpin = this._createSpinRow(generatorGroup, _('Start Y Coordinate'), genDefaults.startY, 0, 10000, 1);
        const numZonesSpin = this._createSpinRow(generatorGroup, _('Number of Zones'), genDefaults.numZones, 1, 16, 1);

        const genRow = new Adw.ActionRow();
        const genBtn = new Gtk.Button({ label: _('Generate Zones'), halign: Gtk.Align.CENTER });
        genRow.set_child(genBtn);
        generatorGroup.add(genRow);

        // Zones group
        const zonesGroup = new Adw.PreferencesGroup({
            title: _('Zones'),
            description: _('Define rectangles for snapping and tabbing.'),
        });
        profilesPage.add(zonesGroup);

        // Add New Zone header with button
        const addRow = new Adw.ActionRow({ title: _('Add New Zone'), subtitle: _('Insert a new zone with default values') });
        const addBtn = new Gtk.Button({ label: _('Add') });
        addRow.add_suffix(addBtn);
        addRow.activatable_widget = addBtn;
        zonesGroup.add(addRow);

        // Zone rows storage for this page
        let zoneRows = [];

        // Function to load zones for a profile
        const loadZonesForProfile = (profileName) => {
            // Clear existing zone rows
            zoneRows.forEach(row => zonesGroup.remove(row));
            zoneRows = [];

            // Load zones from profile
            const profileZones = loadProfileZones(profileName);
            for (const z of profileZones.zones || []) {
                const row = new ZoneEditorRow(z, (rowSelf) => {
                    zonesGroup.remove(rowSelf);
                    zoneRows = zoneRows.filter(r => r !== rowSelf);
                });
                zoneRows.push(row);
                zonesGroup.add(row);
            }
        };

        // Initial zone load
        loadZonesForProfile(activeProfile);

        // Add button handler
        addBtn.connect('clicked', () => {
            const initial = {
                name: '',
                monitorIndex: 0,
                x: 0, y: 0, width: 800, height: 600,
                gaps: { top: 8, right: 8, bottom: 8, left: 8 },
                isPrimary: false,
            };
            const row = new ZoneEditorRow(initial, (rowSelf) => {
                zonesGroup.remove(rowSelf);
                zoneRows = zoneRows.filter(r => r !== rowSelf);
            });
            zoneRows.push(row);
            zonesGroup.add(row);
        });

        // Generate zones handler
        genBtn.connect('clicked', () => {
            const monitorIndex = monSpin.get_value_as_int();
            const resW = resWSpin.get_value_as_int();
            const resH = resHSpin.get_value_as_int();
            const startX = xSpin.get_value_as_int();
            const startY = ySpin.get_value_as_int();
            const numZones = numZonesSpin.get_value_as_int();

            // Remove existing zones for this monitor
            const rowsToRemove = zoneRows.filter(r => r.getZone().monitorIndex === monitorIndex);
            rowsToRemove.forEach(r => {
                zonesGroup.remove(r);
                zoneRows = zoneRows.filter(r => r !== r);
            });

            // Calculate and add new zones
            const availableWidth = resW - startX;
            const zoneWidth = Math.floor(availableWidth / numZones);
            const zoneHeight = resH - startY;

            if (zoneWidth <= 0 || zoneHeight <= 0) {
                this._toast(window, _('Invalid dimensions. Check resolution and start coordinates.'));
                return;
            }

            for (let i = 0; i < numZones; i++) {
                const zoneData = {
                    name: `Monitor ${monitorIndex} Zone ${i + 1}`,
                    monitorIndex, x: startX + (i * zoneWidth), y: startY,
                    width: zoneWidth, height: zoneHeight,
                    gaps: { top: 8, right: 8, bottom: 8, left: 8 },
                    isPrimary: (i === 0),
                };
                const row = new ZoneEditorRow(zoneData, (rowSelf) => {
                    zonesGroup.remove(rowSelf);
                    zoneRows = zoneRows.filter(r => r !== rowSelf);
                });
                zoneRows.push(row);
                zonesGroup.add(row);
            }
            this._toast(window, _(`Generated ${numZones} zones for monitor ${monitorIndex} (${activeProfile} profile).`));
        });

        // Profile dropdown change handler — just browse zones, don't activate yet
        profileDropdownRow.connect('notify::selected', () => {
            const idx = profileDropdownRow.get_selected();
            if (idx >= 0 && idx < profileNames.length) {
                activeProfile = profileNames[idx];
                // Reload zones for selected profile (view only, not activated)
                loadZonesForProfile(activeProfile);
            }
        });

        // Load Profile button — activates the profile in gnome-shell
        loadProfileBtn.connect('clicked', () => {
            // Save the selected profile as the active one
            const data = loadProfiles();
            data.activeProfile = activeProfile;
            saveProfiles(data);

            // Touch config.json to trigger the extension's file monitor to reload
            try {
                const cfgFile = Gio.File.new_for_path(CONFIG_PATH);
                if (cfgFile.query_exists(null)) {
                    // Re-save the existing config to trigger the file monitor
                    const [ok, bytes] = cfgFile.load_contents(null);
                    if (ok) {
                        cfgFile.replace_contents(
                            bytes, null, false,
                            Gio.FileCreateFlags.REPLACE_DESTINATION, null
                        );
                    }
                } else {
                    // Write default config to trigger monitor
                    saveConfig(loadConfig());
                }
            } catch (e) {
                log(`Error triggering config reload: ${e}`);
            }

            this._toast(window, _(`Profile "${activeProfile}" activated. Extension will reload zones.`));
        });

        // New profile button
        newProfileBtn.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: _('New Profile'),
                body: _('Enter a name for the new profile:'),
            });
            const entry = new Gtk.Entry({ placeholder_text: _('Profile name'), hexpand: true });
            dialog.set_extra_child(entry);
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('create', _('Create'));
            dialog.set_response_appearance('create', Adw.ResponseAppearance.SUGGESTED);
            dialog.connect('response', (dlg, responseId) => {
                if (responseId === 'create') {
                    const name = entry.get_text().trim();
                    if (name && !profileNames.includes(name)) {
                        const data = loadProfiles();
                        data.profiles.push({ name, createdAt: new Date().toISOString() });
                        saveProfiles(data);
                        // Create profile directory
                        ensureProfilesDir();
                        const profileDir = Gio.File.new_for_path(GLib.build_filenamev([PROFILES_DIR, name]));
                        profileDir.make_directory_with_parents(null);
                        const zonesPath = GLib.build_filenamev([PROFILES_DIR, name, 'zones.json']);
                        const zonesFile = Gio.File.new_for_path(zonesPath);
                        zonesFile.replace_contents(
                            new TextEncoder().encode(JSON.stringify({ zones: [] }, null, 2)),
                            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
                        );
                        // Refresh dropdown
                        profileModel.append(name);
                        profileNames.push(name);
                        this._toast(window, _(`Profile "${name}" created.`));
                    }
                }
            });
            dialog.present(window);
        });

        // Rename profile button
        renameProfileBtn.connect('clicked', () => {
            const idx = profileDropdownRow.get_selected();
            if (idx < 0) return;
            const oldName = profileNames[idx];
            const dialog = new Adw.AlertDialog({
                heading: _('Rename Profile'),
                body: _('Enter a new name:'),
            });
            const entry = new Gtk.Entry({ text: oldName, placeholder_text: _('Profile name'), hexpand: true });
            dialog.set_extra_child(entry);
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('rename', _('Rename'));
            dialog.set_response_appearance('rename', Adw.ResponseAppearance.SUGGESTED);
            dialog.connect('response', (dlg, responseId) => {
                if (responseId === 'rename') {
                    const newName = entry.get_text().trim();
                    if (newName && newName !== oldName && !profileNames.includes(newName)) {
                        const data = loadProfiles();
                        const profile = data.profiles.find(p => p.name === oldName);
                        if (profile) {
                            // Rename directory
                            const oldDir = Gio.File.new_for_path(GLib.build_filenamev([PROFILES_DIR, oldName]));
                            if (oldDir.query_exists(null)) {
                                oldDir.set_display_name(newName, null);
                            }
                            profile.name = newName;
                            if (data.activeProfile === oldName) {
                                data.activeProfile = newName;
                            }
                            saveProfiles(data);
                            // Refresh UI
                            profileModel.remove(idx);
                            profileModel.append(newName);
                            profileNames[idx] = newName;
                            this._toast(window, _(`Profile renamed to "${newName}".`));
                        }
                    }
                }
            });
            dialog.present(window);
        });

        // Delete profile button
        deleteProfileBtn.connect('clicked', () => {
            const idx = profileDropdownRow.get_selected();
            if (idx < 0) return;
            const name = profileNames[idx];
            if (profileNames.length <= 1) {
                this._toast(window, _('Cannot delete the last profile.'));
                return;
            }
            const dialog = new Adw.AlertDialog({
                heading: _('Delete Profile'),
                body: _(`Are you sure you want to delete "${name}"?`),
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('delete', _('Delete'));
            dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (dlg, responseId) => {
                if (responseId === 'delete') {
                    const data = loadProfiles();
                    const idxToDelete = data.profiles.findIndex(p => p.name === name);
                    if (idxToDelete !== -1) {
                        data.profiles.splice(idxToDelete, 1);
                        if (data.activeProfile === name) {
                            data.activeProfile = data.profiles[0].name;
                        }
                        saveProfiles(data);
                        // Delete directory
                        const profileDir = Gio.File.new_for_path(GLib.build_filenamev([PROFILES_DIR, name]));
                        if (profileDir.query_exists(null)) {
                            try {
                                const enumerator = profileDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                                let file;
                                while ((file = enumerator.next_file(null)) !== null) {
                                    const child = profileDir.get_child(file.get_name());
                                    child.delete(null);
                                }
                                profileDir.delete(null);
                            } catch (e) {
                                log(`Error deleting profile dir: ${e}`);
                            }
                        }
                        // Refresh UI
                        profileModel.remove(idx);
                        profileNames.splice(idx, 1);
                        profileDropdownRow.set_selected(0);
                        activeProfile = profileNames[0];
                        loadZonesForProfile(activeProfile);
                        this._toast(window, _(`Profile "${name}" deleted.`));
                    }
                }
            });
            dialog.present(window);
        });

        // Save button for profiles page
        const profilesSaveGroup = new Adw.PreferencesGroup();
        const profilesSaveBtn = new Gtk.Button({ label: _('Save Zones'), halign: Gtk.Align.CENTER, hexpand: true });
        profilesSaveBtn.add_css_class('suggested-action');
        const profilesSaveRow = new Adw.ActionRow();
        profilesSaveRow.set_child(profilesSaveBtn);
        profilesSaveGroup.add(profilesSaveRow);
        profilesPage.add(profilesSaveGroup);

        profilesSaveBtn.connect('clicked', () => {
            const zones = zoneRows.map(r => r.getZone()).filter(z => z.width > 0 && z.height > 0);
            const zonesConfig = { zones };
            saveProfileZones(activeProfile, zonesConfig);
            this._toast(window, _(`Zones saved to "${activeProfile}" profile.`));
        });

        // ========== PAGE 2: SETTINGS ==========
        const settingsPage = new Adw.PreferencesPage({
            title: _('Settings'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(settingsPage);
        log('fillPreferencesWindow: Added PAGE 2 (Settings)');

        // --- Tab Appearance Group ---
        const tabBarGroup = new Adw.PreferencesGroup({
            title: _('Tab Appearance'),
            description: _('Configure the look and feel of tab bars and tabs.'),
        });
        settingsPage.add(tabBarGroup);
        const cfgTabBar = { ...defaultConfig().tabBar, ...(cfg.tabBar ?? {}) };

        const heightRow = new Adw.ActionRow({ title: _('Height (px)') });
        const heightAdj = new Gtk.Adjustment({ lower: 16, upper: 256, step_increment: 1, value: cfgTabBar.height ?? 32 });
        const heightSpin = new Gtk.SpinButton({ adjustment: heightAdj, digits: 0, halign: Gtk.Align.END });
        heightRow.add_suffix(heightSpin);
        heightRow.activatable_widget = heightSpin;
        tabBarGroup.add(heightRow);

        const backgroundBtn = this._colorPickerRow({
            parentGroup: tabBarGroup,
            title: _('Tab Bar Background Color'),
            subtitle: _('Pick a color and opacity'),
            initial: cfgTabBar.backgroundColor ?? 'rgba(30,30,30,0.85)',
        });

        const activeBgBtn = this._colorPickerRow({
            parentGroup: tabBarGroup,
            title: _('Active Tab Background Color'),
            subtitle: _('Pick a color and opacity'),
            initial: cfgTabBar.activeBgColor ?? 'rgba(0,110,200,0.8)',
        });

        const globalActiveBgBtn = this._colorPickerRow({
            parentGroup: tabBarGroup,
            title: _('Global Active Tab Background Color'),
            subtitle: _('Color for the tab of the window that has keyboard focus'),
            initial: cfgTabBar.globalActiveBgColor ?? 'rgba(255,230,0,0.9)',
        });

        const groupBorderBtn = this._colorPickerRow({
            parentGroup: tabBarGroup,
            title: _('Grouped Tabs Border Color'),
            subtitle: _('Pick a color and opacity'),
            initial: cfgTabBar.groupBorderColor ?? '#4A90E2',
        });

        const radiusRow = new Adw.ActionRow({ title: _('Tab Corner Radius (px)') });
        const radiusAdj = new Gtk.Adjustment({ lower: 0, upper: 32, step_increment: 1, value: cfgTabBar.cornerRadius ?? 8 });
        const radiusSpin = new Gtk.SpinButton({ adjustment: radiusAdj, digits: 0, halign: Gtk.Align.END });
        radiusRow.add_suffix(radiusSpin);
        radiusRow.activatable_widget = radiusSpin;
        tabBarGroup.add(radiusRow);

        const iconSizeRow = new Adw.ActionRow({ title: _('Icon Size (px)') });
        const iconSizeAdj = new Gtk.Adjustment({ lower: 8, upper: 48, step_increment: 1, value: cfgTabBar.iconSize ?? 16 });
        const iconSizeSpin = new Gtk.SpinButton({ adjustment: iconSizeAdj, digits: 0, halign: Gtk.Align.END });
        iconSizeRow.add_suffix(iconSizeSpin);
        iconSizeRow.activatable_widget = iconSizeSpin;
        tabBarGroup.add(iconSizeRow);

        const fontSizeRow = new Adw.ActionRow({ title: _('Font Size (pt)') });
        const fontSizeAdj = new Gtk.Adjustment({ lower: 6, upper: 24, step_increment: 1, value: cfgTabBar.fontSize ?? 10 });
        const fontSizeSpin = new Gtk.SpinButton({ adjustment: fontSizeAdj, digits: 0, halign: Gtk.Align.END });
        fontSizeRow.add_suffix(fontSizeSpin);
        fontSizeRow.activatable_widget = fontSizeSpin;
        tabBarGroup.add(fontSizeRow);

        const spacingRow = new Adw.ActionRow({ title: _('Spacing between Tabs (px)') });
        const spacingAdj = new Gtk.Adjustment({ lower: 0, upper: 32, step_increment: 1, value: cfgTabBar.spacing ?? 4 });
        const spacingSpin = new Gtk.SpinButton({ adjustment: spacingAdj, digits: 0, halign: Gtk.Align.END });
        spacingRow.add_suffix(spacingSpin);
        spacingRow.activatable_widget = spacingSpin;
        tabBarGroup.add(spacingRow);

        const maxWidthRow = new Adw.ActionRow({ title: _('Max Tab Width (px)') });
        const maxWidthAdj = new Gtk.Adjustment({ lower: 50, upper: 1000, step_increment: 10, value: cfgTabBar.maxWidth ?? 250 });
        const maxWidthSpin = new Gtk.SpinButton({ adjustment: maxWidthAdj, digits: 0, halign: Gtk.Align.END });
        maxWidthRow.add_suffix(maxWidthSpin);
        maxWidthRow.activatable_widget = maxWidthSpin;
        tabBarGroup.add(maxWidthRow);

        const closeButtonSizeRow = new Adw.ActionRow({ title: _('Close Button Size (px)') });
        const closeButtonSizeAdj = new Gtk.Adjustment({ lower: 8, upper: 32, step_increment: 1, value: cfgTabBar.closeButtonSize ?? 12 });
        const closeButtonSizeSpin = new Gtk.SpinButton({ adjustment: closeButtonSizeAdj, digits: 0, halign: Gtk.Align.END });
        closeButtonSizeRow.add_suffix(closeButtonSizeSpin);
        closeButtonSizeRow.activatable_widget = closeButtonSizeSpin;
        tabBarGroup.add(closeButtonSizeRow);

        // --- Tab Behavior Group ---
        const behaviorGroup = new Adw.PreferencesGroup({
            title: _('Tab Behavior'),
            description: _('Configure tab titles and grouping.'),
        });
        settingsPage.add(behaviorGroup);

        const titleSourceRow = new Adw.ActionRow({ title: _('Tab Title Source') });
        const titleModel = new Gtk.StringList();
        titleModel.append(_('Window Title'));
        titleModel.append(_('Application Name'));
        titleModel.append(_('WM_CLASS'));
        const titleDropdown = new Gtk.DropDown({ model: titleModel });
        const titleMap = { 'windowTitle': 0, 'appName': 1, 'wmClass': 2 };
        titleDropdown.set_selected(titleMap[cfgTabBar.titleSource] ?? 0);
        titleSourceRow.add_suffix(titleDropdown);
        titleSourceRow.activatable_widget = titleDropdown;
        behaviorGroup.add(titleSourceRow);

        const groupSourceRow = new Adw.ActionRow({ title: _('Tab Grouping Criteria') });
        const groupModel = new Gtk.StringList();
        groupModel.append(_('Application Name'));
        groupModel.append(_('WM_CLASS'));
        const groupDropdown = new Gtk.DropDown({ model: groupModel });
        const groupMap = { 'appName': 0, 'wmClass': 1 };
        groupDropdown.set_selected(groupMap[cfgTabBar.groupingCriteria] ?? 0);
        groupSourceRow.add_suffix(groupDropdown);
        groupSourceRow.activatable_widget = groupDropdown;
        behaviorGroup.add(groupSourceRow);

        const sortSourceRow = new Adw.ActionRow({ title: _('Sorting Criteria') });
        const sortModel = new Gtk.StringList();
        sortModel.append(_('Window Title'));
        sortModel.append(_('Application Name'));
        sortModel.append(_('WM_CLASS'));
        const sortDropdown = new Gtk.DropDown({ model: sortModel });
        const sortMap = { 'windowTitle': 0, 'appName': 1, 'wmClass': 2 };
        sortDropdown.set_selected(sortMap[cfgTabBar.sortingCriteria] ?? 0);
        sortSourceRow.add_suffix(sortDropdown);
        sortSourceRow.activatable_widget = sortDropdown;
        behaviorGroup.add(sortSourceRow);

        const sortOrderRow = new Adw.ActionRow({ title: _('Sorting Order') });
        const orderModel = new Gtk.StringList();
        orderModel.append(_('Ascending'));
        orderModel.append(_('Descending'));
        const orderDropdown = new Gtk.DropDown({ model: orderModel });
        const orderMap = { 'ASC': 0, 'DESC': 1 };
        orderDropdown.set_selected(orderMap[cfgTabBar.sortingOrder] ?? 0);
        sortOrderRow.add_suffix(orderDropdown);
        sortOrderRow.activatable_widget = orderDropdown;
        behaviorGroup.add(sortOrderRow);

        // --- Keybindings Group ---
        const keybindingsGroup = new Adw.PreferencesGroup({
            title: _('Keybindings'),
            description: _('These shortcuts are fixed and cannot be changed from this panel.'),
        });
        settingsPage.add(keybindingsGroup);

        const nextTabRow = new Adw.ActionRow({
            title: _('Cycle to next tab'),
            subtitle: 'Ctrl + Shift + Right',
        });
        keybindingsGroup.add(nextTabRow);
        const prevTabRow = new Adw.ActionRow({
            title: _('Cycle to previous tab'),
            subtitle: 'Ctrl + Shift + Left',
        });
        keybindingsGroup.add(prevTabRow);

        const toggleLayerRow = new Adw.ActionRow({
            title: _('Toggle Tab Bar Layer'),
            subtitle: _("Alt + Q: Toggles tab bars between the foreground and background."),
        });
        keybindingsGroup.add(toggleLayerRow);

        // --- Exclusions Group ---
        const exclusionsGroup = new Adw.PreferencesGroup({
            title: _('Exclusions'),
            description: _('Prevent specific applications from being tiled.'),
        });
        settingsPage.add(exclusionsGroup);

        const cfgExclusions = { ...defaultConfig().exclusions, ...(cfg.exclusions ?? {}) };

        const exclusionCriteriaRow = new Adw.ActionRow({ title: _('Exclusion Criteria') });
        const exclusionModel = new Gtk.StringList();
        exclusionModel.append(_('WM_CLASS'));
        exclusionModel.append(_('Application Name'));
        const exclusionDropdown = new Gtk.DropDown({ model: exclusionModel });
        const exclusionMap = { 'wmClass': 0, 'appName': 1 };
        exclusionDropdown.set_selected(exclusionMap[cfgExclusions.criteria] ?? 0);
        exclusionCriteriaRow.add_suffix(exclusionDropdown);
        exclusionCriteriaRow.activatable_widget = exclusionDropdown;
        exclusionsGroup.add(exclusionCriteriaRow);

        const exclusionListRow = new Adw.ActionRow({ title: _('Exclusion List (comma-separated)') });
        const exclusionEntry = new Gtk.Entry({
            hexpand: true,
            text: (cfgExclusions.list ?? []).join(', '),
        });
        exclusionListRow.add_suffix(exclusionEntry);
        exclusionListRow.activatable_widget = exclusionEntry;
        exclusionsGroup.add(exclusionListRow);

        // Save button for settings page
        const settingsSaveGroup = new Adw.PreferencesGroup();
        const settingsSaveBtn = new Gtk.Button({ label: _('Save Settings'), halign: Gtk.Align.CENTER, hexpand: true });
        settingsSaveBtn.add_css_class('suggested-action');
        const settingsSaveRow = new Adw.ActionRow();
        settingsSaveRow.set_child(settingsSaveBtn);
        settingsSaveGroup.add(settingsSaveRow);
        settingsPage.add(settingsSaveGroup);

        settingsSaveBtn.connect('clicked', () => {
            const titleMapArr = ['windowTitle', 'appName', 'wmClass'];
            const groupMapArr = ['appName', 'wmClass'];
            const sortMapArr = ['windowTitle', 'appName', 'wmClass'];
            const orderMapArr = ['ASC', 'DESC'];
            const exclusionMapArr = ['wmClass', 'appName'];

            const tabBar = {
                ...(cfg.tabBar ?? defaultConfig().tabBar),
                height: heightSpin.get_value_as_int(),
                backgroundColor: backgroundBtn.get_rgba().to_string(),
                activeBgColor: activeBgBtn.get_rgba().to_string(),
                groupBorderColor: groupBorderBtn.get_rgba().to_string(),
                globalActiveBgColor: globalActiveBgBtn.get_rgba().to_string(),
                cornerRadius: radiusSpin.get_value_as_int(),
                iconSize: iconSizeSpin.get_value_as_int(),
                fontSize: fontSizeSpin.get_value_as_int(),
                spacing: spacingSpin.get_value_as_int(),
                maxWidth: maxWidthSpin.get_value_as_int(),
                titleSource: titleMapArr[titleDropdown.get_selected()],
                groupingCriteria: groupMapArr[groupDropdown.get_selected()],
                closeButtonSize: closeButtonSizeSpin.get_value_as_int(),
                sortingCriteria: sortMapArr[sortDropdown.get_selected()],
                sortingOrder: orderMapArr[orderDropdown.get_selected()],
            };

            const exclusionList = exclusionEntry.get_text()
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0);

            const exclusions = {
                list: exclusionList,
                criteria: exclusionMapArr[exclusionDropdown.get_selected()],
            };

            const newCfg = {
                ...cfg,
                tabBar,
                exclusions,
                zoneGenerator: cfg.zoneGenerator,
            };

            if (saveConfig(newCfg)) {
                this._toast(window, _('Settings saved successfully.'));
            } else {
                this._toast(window, _('Failed to save settings.'));
            }
        });
    }

    _addZoneRow(zoneOrNull, zonesGroup) {
        const initial = zoneOrNull ?? {
            name: '',
            monitorIndex: 0,
            x: 0, y: 0, width: 800, height: 600,
            gaps: { top: 8, right: 8, bottom: 8, left: 8 },
            isPrimary: false,
        };

        const row = new ZoneEditorRow(initial, (rowSelf) => {
            // remove from UI and local list
            zonesGroup.remove(rowSelf);
            this._zoneRows = this._zoneRows.filter(r => r !== rowSelf);
        });

        this._zoneRows.push(row);
        zonesGroup.add(row);
    }

    _collectConfig(existingCfg, widgets) {
        const zones = this._zoneRows.map(r => r.getZone());
        
        const titleMap = ['windowTitle', 'appName', 'wmClass'];
        const groupMap = ['appName', 'wmClass'];        
        const sortMap = ['windowTitle', 'appName', 'wmClass'];
        const orderMap = ['ASC', 'DESC'];
        const exclusionMap = ['wmClass', 'appName']; // NEW        

        const tabBar = {
            ...(existingCfg.tabBar ?? defaultConfig().tabBar),
            height: widgets.heightSpin.get_value_as_int(),
            backgroundColor: widgets.backgroundBtn.get_rgba().to_string(),
            activeBgColor: widgets.activeBgBtn.get_rgba().to_string(),
            groupBorderColor: widgets.groupBorderBtn.get_rgba().to_string(),
            globalActiveBgColor: widgets.globalActiveBgBtn.get_rgba().to_string(), // NEW
            cornerRadius: widgets.radiusSpin.get_value_as_int(),
            iconSize: widgets.iconSizeSpin.get_value_as_int(),
            fontSize: widgets.fontSizeSpin.get_value_as_int(),
            spacing: widgets.spacingSpin.get_value_as_int(),
            maxWidth: widgets.maxWidthSpin.get_value_as_int(),
            titleSource: titleMap[widgets.titleDropdown.get_selected()],
            groupingCriteria: groupMap[widgets.groupDropdown.get_selected()],
            closeButtonSize: widgets.closeButtonSizeSpin.get_value_as_int(),
            sortingCriteria: sortMap[widgets.sortDropdown.get_selected()],
            sortingOrder: orderMap[widgets.orderDropdown.get_selected()],
        };

        // NEW: Collect exclusion settings
        const exclusionList = widgets.exclusionEntry.get_text()
            .split(',') // split by comma
            .map(s => s.trim()) // trim whitespace
            .filter(s => s.length > 0); // remove empty entries
        
        const exclusions = {
            list: exclusionList,
            criteria: exclusionMap[widgets.exclusionDropdown.get_selected()],
        };

        // Basic validation: drop zones with non-positive size
        const saneZones = zones.filter(z => (z.width > 0 && z.height > 0));

        // Preserve previously saved generator defaults
        const zoneGenerator = { ...(existingCfg.zoneGenerator ?? defaultConfig().zoneGenerator) };
        // Add exclusions to returned object
        return { zones: saneZones, tabBar, zoneGenerator, exclusions };
    }

    _toast(window, text) {
        // Adw.PreferencesWindow supports add_toast() directly
        try {
            const toast = new Adw.Toast({ title: text, timeout: 3 });
            window.add_toast(toast);
        } catch (e) {
            log(`${text} (no toast overlay available)`);
        }
    }
}

