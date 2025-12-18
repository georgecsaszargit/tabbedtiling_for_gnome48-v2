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

        const cfg = loadConfig();
        const genDefaults = { ...defaultConfig().zoneGenerator, ...(cfg.zoneGenerator ?? {}) };

        const page = new Adw.PreferencesPage();
        window.add(page);

        // Zone Generator Group
        const generatorGroup = new Adw.PreferencesGroup({
            title: _('Zone Generator'),
            description: _('Quickly create a set of horizontal zones for a monitor. This will replace existing zones on the selected monitor.'),
        });
        page.add(generatorGroup);

        const monSpin      = this._createSpinRow(generatorGroup, _('Monitor Index'),               genDefaults.monitorIndex, 0, 16,   1);
        const resWSpin     = this._createSpinRow(generatorGroup, _('Monitor Resolution Width'),   genDefaults.resW,         0, 10000, 1);
        const resHSpin     = this._createSpinRow(generatorGroup, _('Monitor Resolution Height'),  genDefaults.resH,         0, 10000, 1);
        const xSpin        = this._createSpinRow(generatorGroup, _('Start X Coordinate'),         genDefaults.startX,       0, 10000, 1);
        const ySpin        = this._createSpinRow(generatorGroup, _('Start Y Coordinate'),         genDefaults.startY,       0, 10000, 1);
        const numZonesSpin = this._createSpinRow(generatorGroup, _('Number of Zones'),            genDefaults.numZones,     1, 16,    1);

        const genRow = new Adw.ActionRow();
        const genBtn = new Gtk.Button({ label: _('Generate Zones'), halign: Gtk.Align.CENTER });
        genRow.set_child(genBtn);
        generatorGroup.add(genRow);        

        // Zones group
        const zonesGroup = new Adw.PreferencesGroup({ title: _('Zones'), description: _('Define rectangles for snapping and tabbing.') });
        page.add(zonesGroup);

        // Add New Zone header with button
        const addRow = new Adw.ActionRow({ title: _('Add New Zone'), subtitle: _('Insert a new zone with default values') });
        const addBtn = new Gtk.Button({ label: _('Add') });
        addBtn.connect('clicked', () => this._addZoneRow(null, zonesGroup));
        addRow.add_suffix(addBtn);
        addRow.activatable_widget = addBtn;
        zonesGroup.add(addRow);

        // Existing zones
        this._zoneRows = [];
        for (const z of cfg.zones) {
            this._addZoneRow(z, zonesGroup);
        }

        genBtn.connect('clicked', () => {
            const monitorIndex = monSpin.get_value_as_int();
            const resW = resWSpin.get_value_as_int();
            const resH = resHSpin.get_value_as_int();
            const startX = xSpin.get_value_as_int();
            const startY = ySpin.get_value_as_int();
            const numZones = numZonesSpin.get_value_as_int();

            // NEW: persist the latest generator inputs immediately
            cfg.zoneGenerator = {
                monitorIndex,
                resW,
                resH,
                startX,
                startY,
                numZones,
            };
            saveConfig(cfg);            

            // Remove existing zones for this monitor
            const rowsToRemove = this._zoneRows.filter(r => r.getZone().monitorIndex === monitorIndex);
            rowsToRemove.forEach(r => {
                zonesGroup.remove(r);
                const index = this._zoneRows.indexOf(r);
                if (index > -1) this._zoneRows.splice(index, 1);
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
                this._addZoneRow(zoneData, zonesGroup);
            }
            this._toast(window, _(`Generated ${numZones} zones for monitor ${monitorIndex} (defaults saved).`));
        });

        // --- Tab Appearance Group ---
        const tabBarGroup = new Adw.PreferencesGroup({ title: _('Tab Appearance'), description: _('Configure the look and feel of tab bars and tabs.') });
        page.add(tabBarGroup);
        // Merge loaded config with defaults to prevent errors from missing keys
        const cfgTabBar = { ...defaultConfig().tabBar, ...(cfg.tabBar ?? {}) };

        // Height        
        const heightRow = new Adw.ActionRow({ title: _('Height (px)') });
        const heightAdj = new Gtk.Adjustment({ lower: 16, upper: 256, step_increment: 1, value: cfgTabBar.height ?? 32 });
        const heightSpin = new Gtk.SpinButton({ adjustment: heightAdj, digits: 0, halign: Gtk.Align.END });
        heightRow.add_suffix(heightSpin);
        heightRow.activatable_widget = heightSpin;
        tabBarGroup.add(heightRow);
        
        // Tab Bar Background Color (with opacity)
        const backgroundBtn = this._colorPickerRow({
            parentGroup: tabBarGroup,
            title: _('Tab Bar Background Color'),
            subtitle: _('Pick a color and opacity'),
            initial: cfgTabBar.backgroundColor ?? 'rgba(30,30,30,0.85)',
        });

        // Active Tab Background Color (with opacity)
        const activeBgBtn = this._colorPickerRow({
            parentGroup: tabBarGroup,
            title: _('Active Tab Background Color'),
            subtitle: _('Pick a color and opacity'),
            initial: cfgTabBar.activeBgColor ?? 'rgba(0,110,200,0.8)',
        });
        
        // NEW: Global Active Tab Background Color (used for the truly focused window)
        const globalActiveBgBtn = this._colorPickerRow({
            parentGroup: tabBarGroup,
            title: _('Global Active Tab Background Color'),
            subtitle: _('Color for the tab of the window that has keyboard focus'),
            initial: cfgTabBar.globalActiveBgColor ?? 'rgba(255,230,0,0.9)',
        });        

        // Grouped Tabs Border Color (with opacity)
        const groupBorderBtn = this._colorPickerRow({
            parentGroup: tabBarGroup,
            title: _('Grouped Tabs Border Color'),
            subtitle: _('Pick a color and opacity'),
            initial: cfgTabBar.groupBorderColor ?? '#4A90E2',
        });

        // Corner Radius
        const radiusRow = new Adw.ActionRow({ title: _('Tab Corner Radius (px)') });
        const radiusAdj = new Gtk.Adjustment({ lower: 0, upper: 32, step_increment: 1, value: cfgTabBar.cornerRadius ?? 8 });
        const radiusSpin = new Gtk.SpinButton({ adjustment: radiusAdj, digits: 0, halign: Gtk.Align.END });
        radiusRow.add_suffix(radiusSpin);
        radiusRow.activatable_widget = radiusSpin;
        tabBarGroup.add(radiusRow);

        // Icon Size
        const iconSizeRow = new Adw.ActionRow({ title: _('Icon Size (px)') });
        const iconSizeAdj = new Gtk.Adjustment({ lower: 8, upper: 48, step_increment: 1, value: cfgTabBar.iconSize ?? 16 });
        const iconSizeSpin = new Gtk.SpinButton({ adjustment: iconSizeAdj, digits: 0, halign: Gtk.Align.END });
        iconSizeRow.add_suffix(iconSizeSpin);
        iconSizeRow.activatable_widget = iconSizeSpin;
        tabBarGroup.add(iconSizeRow);

        // Font Size
        const fontSizeRow = new Adw.ActionRow({ title: _('Font Size (pt)') });
        const fontSizeAdj = new Gtk.Adjustment({ lower: 6, upper: 24, step_increment: 1, value: cfgTabBar.fontSize ?? 10 });
        const fontSizeSpin = new Gtk.SpinButton({ adjustment: fontSizeAdj, digits: 0, halign: Gtk.Align.END });
        fontSizeRow.add_suffix(fontSizeSpin);
        fontSizeRow.activatable_widget = fontSizeSpin;
        tabBarGroup.add(fontSizeRow);

        // Spacing
        const spacingRow = new Adw.ActionRow({ title: _('Spacing between Tabs (px)') });
        const spacingAdj = new Gtk.Adjustment({ lower: 0, upper: 32, step_increment: 1, value: cfgTabBar.spacing ?? 4 });
        const spacingSpin = new Gtk.SpinButton({ adjustment: spacingAdj, digits: 0, halign: Gtk.Align.END });
        spacingRow.add_suffix(spacingSpin);
        spacingRow.activatable_widget = spacingSpin;
        tabBarGroup.add(spacingRow);

        // Max Width
        const maxWidthRow = new Adw.ActionRow({ title: _('Max Tab Width (px)') });
        const maxWidthAdj = new Gtk.Adjustment({ lower: 50, upper: 1000, step_increment: 10, value: cfgTabBar.maxWidth ?? 250 });
        const maxWidthSpin = new Gtk.SpinButton({ adjustment: maxWidthAdj, digits: 0, halign: Gtk.Align.END });
        maxWidthRow.add_suffix(maxWidthSpin);
        maxWidthRow.activatable_widget = maxWidthSpin;
        tabBarGroup.add(maxWidthRow);

        // Close Button Size
        const closeButtonSizeRow = new Adw.ActionRow({ title: _('Close Button Size (px)') });
        const closeButtonSizeAdj = new Gtk.Adjustment({ lower: 8, upper: 32, step_increment: 1, value: cfgTabBar.closeButtonSize ?? 12 });
        const closeButtonSizeSpin = new Gtk.SpinButton({ adjustment: closeButtonSizeAdj, digits: 0, halign: Gtk.Align.END });
        closeButtonSizeRow.add_suffix(closeButtonSizeSpin);
        closeButtonSizeRow.activatable_widget = closeButtonSizeSpin;
        tabBarGroup.add(closeButtonSizeRow);

        // --- Tab Behavior Group ---
        const behaviorGroup = new Adw.PreferencesGroup({ title: _('Tab Behavior'), description: _('Configure tab titles and grouping.') });
        page.add(behaviorGroup);

        // Title Source
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

        // Grouping Criteria
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

        // Sorting Criteria
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

        // Sorting Order
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
        page.add(keybindingsGroup);

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

        // --- Exclusions Group ---
        const exclusionsGroup = new Adw.PreferencesGroup({
            title: _('Exclusions'),
            description: _('Prevent specific applications from being tiled. Use WM_CLASS for best results.'),
        });
        page.add(exclusionsGroup);

        const cfgExclusions = { ...defaultConfig().exclusions, ...(cfg.exclusions ?? {}) };

        // Exclusion Criteria
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

        // Exclusion List (comma-separated)
        const exclusionListRow = new Adw.ActionRow({ title: _('Exclusion List (comma-separated)') });
        const exclusionEntry = new Gtk.Entry({
            hexpand: true,
            text: (cfgExclusions.list ?? []).join(', '),
        });
        exclusionListRow.add_suffix(exclusionEntry);
        exclusionListRow.activatable_widget = exclusionEntry;
        exclusionsGroup.add(exclusionListRow);

        // Footer: Save & Apply (must be added to a PreferencesGroup, not directly to the Page)
        const footer = new Adw.ActionRow();

        const previewBtn = new Gtk.Button({ label: _('Preview Zones') });
        previewBtn.connect('clicked', () => {
            const zones = this._zoneRows.map(r => r.getZone());
            try {
                ensureConfigDir();
                const file = Gio.File.new_for_path(PREVIEW_PATH);
                const json = JSON.stringify(zones);
                file.replace_contents(
                    new TextEncoder().encode(json), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null
                );
                this._toast(window, _('Showing zone preview for 5 seconds.'));
            } catch (e) {
                log(`Error saving preview file: ${e}`);
                this._toast(window, _('Could not show preview.'));
            }
        });
        footer.add_prefix(previewBtn);
        const saveBtn = new Gtk.Button({ label: _('Save and Apply') });
        saveBtn.add_css_class('suggested-action');
        saveBtn.connect('clicked', () => {
            const newCfg = this._collectConfig(
                cfg, {
                    heightSpin, backgroundBtn, activeBgBtn, groupBorderBtn, globalActiveBgBtn,
                    radiusSpin, closeButtonSizeSpin,
                    iconSizeSpin, fontSizeSpin, spacingSpin,
                    maxWidthSpin, titleDropdown, groupDropdown,
                    sortDropdown, orderDropdown,
                    exclusionDropdown, exclusionEntry
                }
            );
            if (saveConfig(newCfg)) {
                this._toast(window, _('Configuration saved.'));
            } else {
                this._toast(window, _('Failed to save configuration.'));
            }
        });
        footer.add_suffix(saveBtn);

        const actionsGroup = new Adw.PreferencesGroup({ title: _('Actions') });
        actionsGroup.add(footer);
        page.add(actionsGroup);
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
        // If running inside gnome-extensions-app, we can pop a simple banner using Adw.ToastOverlay if present.
        // Fall back to console.
        try {
            if (!this._overlay) {
                this._overlay = new Adw.ToastOverlay();
                // Wrap current content
                const child = window.get_content();
                window.set_content(this._overlay);
                if (child)
                    this._overlay.set_child(child);
            }
            const toast = new Adw.Toast({ title: text, timeout: 3 });
            this._overlay.add_toast(toast);
        } catch (e) {
            log(`${text} (no toast overlay available)`);
        }
    }
}

