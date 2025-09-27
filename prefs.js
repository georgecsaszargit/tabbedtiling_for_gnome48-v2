// prefs.js — TabbedTiling preferences (GNOME 48 / GJS)
// Works on X11; uses Adw, Gtk, GObject. Stores config in ~/.config/tabbedtiling/config.json

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

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
 * Zone fields: name, monitorIndex, x, y, width, height, gap, isPrimary
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
        this._zone = {
            name: zoneData?.name ?? '',
            monitorIndex: zoneData?.monitorIndex ?? 0,
            x: zoneData?.x ?? 0,
            y: zoneData?.y ?? 0,
            width: zoneData?.width ?? 0,
            height: zoneData?.height ?? 0,
            gap: zoneData?.gap ?? 0,
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
            const sw = new Gtk.Switch({ active: initial, halign: Gtk.Align.END });
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

        // Gap
        const [gapRow, gapSpin] = labeledSpin(_('Gap'), this._zone.gap, 0, 256, 1, (v) => { this._zone.gap = v; });
        grid.attach(gapRow, 0, 6, 1, 1);

        // isPrimary
        const [primRow, primSwitch] = labeledSwitch(_('Primary Zone'), this._zone.isPrimary, (v) => { this._zone.isPrimary = v; });
        grid.attach(primRow, 0, 7, 1, 1);
    }

    _refreshSubtitle() {
        this.subtitle = `X:${this._zone.x}, Y:${this._zone.y}, W:${this._zone.width}, H:${this._zone.height}`;
    }

    getZone() {
        return { ...this._zone };
    }
});

// ---------- Preferences Window ----------

export default class TabbedTilingPrefs extends ExtensionPreferences {
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

        const page = new Adw.PreferencesPage();
        window.add(page);

        // Zone Generator Group
        const generatorGroup = new Adw.PreferencesGroup({
            title: _('Zone Generator'),
            description: _('Quickly create a set of horizontal zones for a monitor. This will replace existing zones on the selected monitor.'),
        });
        page.add(generatorGroup);

        const monSpin = this._createSpinRow(generatorGroup, _('Monitor Index'), 0, 0, 16, 1);
        const resWSpin = this._createSpinRow(generatorGroup, _('Monitor Resolution Width'), 1920, 0, 10000, 1);
        const resHSpin = this._createSpinRow(generatorGroup, _('Monitor Resolution Height'), 1080, 0, 10000, 1);
        const xSpin = this._createSpinRow(generatorGroup, _('Start X Coordinate'), 0, 0, 10000, 1);
        const ySpin = this._createSpinRow(generatorGroup, _('Start Y Coordinate'), 0, 0, 10000, 1);
        const numZonesSpin = this._createSpinRow(generatorGroup, _('Number of Zones'), 2, 1, 16, 1);

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
                    width: zoneWidth, height: zoneHeight, gap: 8, isPrimary: (i === 0),
                };
                this._addZoneRow(zoneData, zonesGroup);
            }
            this._toast(window, _(`Generated ${numZones} zones for monitor ${monitorIndex}.`));
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
        
        // Background Color
        const colorRow = new Adw.ActionRow({ title: _('Background Color'), subtitle: _('e.g., rgba(30, 30, 30, 0.85)') });
        const colorEntry = new Gtk.Entry({ text: cfgTabBar.backgroundColor ?? 'rgba(30,30,30,0.85)', hexpand: true });
        colorRow.add_suffix(colorEntry);
        colorRow.activatable_widget = colorEntry;
        tabBarGroup.add(colorRow);

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
                    heightSpin, colorEntry, radiusSpin, closeButtonSizeSpin,
                    iconSizeSpin, fontSizeSpin, spacingSpin,
                    maxWidthSpin, titleDropdown, groupDropdown,
                    sortDropdown, orderDropdown
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
            gap: 8,
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

        const tabBar = {
            ...(existingCfg.tabBar ?? defaultConfig().tabBar),
            height: widgets.heightSpin.get_value_as_int(),
            backgroundColor: widgets.colorEntry.get_text(),
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

        // Basic validation: drop zones with non-positive size
        const saneZones = zones.filter(z => (z.width > 0 && z.height > 0));

        return { zones: saneZones, tabBar };
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

