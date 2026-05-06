// prefs/BehaviorPage.js — Behavior & Shortcuts page builder
// Runs in the prefs process only (GTK4 / libadwaita, GNOME 48).

import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import { saveConfig } from './ConfigIO.js';
import { AutoSaver } from './AutoSaver.js';
import { KeybindingRow } from './KeybindingRow.js';

const log = msg => console.log(`[TabbedTiling.BehaviorPage] ${msg}`);

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build the "Behavior" preferences page.
 * @param {Adw.PreferencesWindow} window - The prefs window (needed for cleanup)
 * @param {Adw.ToastOverlay} toastOverlay - Toast overlay for feedback
 * @param {Gio.Settings} settings - GSettings instance for keybinding keys
 * @param {object} config - Shared configuration object (mutated in place)
 * @returns {Adw.PreferencesPage}
 */
export function buildBehaviorPage(window, toastOverlay, settings, config) {
    const page = new Adw.PreferencesPage({
        title: 'Behavior',
        icon_name: 'preferences-system-symbolic',
    });

    // Ensure sub-objects exist
    config.tabBar ??= {};
    config.exclusions ??= { list: [], criteria: 'wmClass' };
    config.exclusions.list ??= [];
    config.exclusions.criteria ??= 'wmClass';

    const autoSaver = new AutoSaver(
        () => saveConfig(config),
        toastOverlay,
        'Settings saved'
    );

    // =======================================================================
    // GROUP 1: Tab Behavior
    // =======================================================================

    const tabBehaviorGroup = new Adw.PreferencesGroup({
        title: 'Tab Behavior',
        description: 'Configure how tabs display, group, and sort',
    });
    page.add(tabBehaviorGroup);

    // --- Title Source ---
    {
        const labels = ['Window Title', 'App Name', 'WM_CLASS'];
        const values = ['windowTitle', 'appName', 'wmClass'];
        const model = Gtk.StringList.new(labels);
        const row = new Adw.ComboRow({
            title: 'Title Source',
            subtitle: 'What text to show on each tab',
            model: model,
        });
        row.set_selected(Math.max(0, values.indexOf(config.tabBar.titleSource ?? 'windowTitle')));
        row.connect('notify::selected', () => {
            config.tabBar.titleSource = values[row.selected];
            autoSaver.queue();
        });
        tabBehaviorGroup.add(row);
    }

    // --- Grouping Criteria ---
    {
        const labels = ['App Name', 'WM_CLASS'];
        const values = ['appName', 'wmClass'];
        const model = Gtk.StringList.new(labels);
        const row = new Adw.ComboRow({
            title: 'Grouping Criteria',
            subtitle: 'How tabs are grouped together in the tab bar',
            model: model,
        });
        row.set_selected(Math.max(0, values.indexOf(config.tabBar.groupingCriteria ?? 'appName')));
        row.connect('notify::selected', () => {
            config.tabBar.groupingCriteria = values[row.selected];
            autoSaver.queue();
        });
        tabBehaviorGroup.add(row);
    }

    // --- Sorting Criteria ---
    {
        const labels = ['Window Title', 'App Name', 'WM_CLASS'];
        const values = ['windowTitle', 'appName', 'wmClass'];
        const model = Gtk.StringList.new(labels);
        const row = new Adw.ComboRow({
            title: 'Sorting Criteria',
            subtitle: 'How tabs are ordered within groups',
            model: model,
        });
        row.set_selected(Math.max(0, values.indexOf(config.tabBar.sortingCriteria ?? 'windowTitle')));
        row.connect('notify::selected', () => {
            config.tabBar.sortingCriteria = values[row.selected];
            autoSaver.queue();
        });
        tabBehaviorGroup.add(row);
    }

    // --- Sorting Order ---
    {
        const labels = ['Ascending', 'Descending'];
        const values = ['ASC', 'DESC'];
        const model = Gtk.StringList.new(labels);
        const row = new Adw.ComboRow({
            title: 'Sorting Order',
            subtitle: 'Sort direction for tabs',
            model: model,
        });
        row.set_selected(Math.max(0, values.indexOf(config.tabBar.sortingOrder ?? 'ASC')));
        row.connect('notify::selected', () => {
            config.tabBar.sortingOrder = values[row.selected];
            autoSaver.queue();
        });
        tabBehaviorGroup.add(row);
    }

    // =======================================================================
    // GROUP 2: Keyboard Shortcuts
    // =======================================================================

    const shortcutsGroup = new Adw.PreferencesGroup({
        title: 'Keyboard Shortcuts',
        description: 'Configure keyboard shortcuts for tab navigation',
    });
    page.add(shortcutsGroup);

    const keybindingRows = [];

    const nextTab = new KeybindingRow(
        settings, 'cycle-next-tab',
        'Next Tab',
        'Switch to the next tab in the focused zone'
    );
    shortcutsGroup.add(nextTab);
    keybindingRows.push(nextTab);

    const prevTab = new KeybindingRow(
        settings, 'cycle-prev-tab',
        'Previous Tab',
        'Switch to the previous tab in the focused zone'
    );
    shortcutsGroup.add(prevTab);
    keybindingRows.push(prevTab);

    const toggleLayer = new KeybindingRow(
        settings, 'log-key-press',
        'Toggle Tab Layer',
        'Toggle tab bars between foreground and background'
    );
    shortcutsGroup.add(toggleLayer);
    keybindingRows.push(toggleLayer);

    // =======================================================================
    // GROUP 3: Window Exclusions
    // =======================================================================

    const exclusionsGroup = new Adw.PreferencesGroup({
        title: 'Window Exclusions',
        description: 'Windows matching these entries will not be managed by the tiling extension',
    });
    page.add(exclusionsGroup);

    // --- Exclusion Criteria ComboRow ---
    {
        const labels = ['WM_CLASS', 'App Name'];
        const values = ['wmClass', 'appName'];
        const model = Gtk.StringList.new(labels);
        const row = new Adw.ComboRow({
            title: 'Exclusion Criteria',
            subtitle: 'Match windows by this property',
            model: model,
        });
        row.set_selected(Math.max(0, values.indexOf(config.exclusions.criteria ?? 'wmClass')));
        row.connect('notify::selected', () => {
            config.exclusions.criteria = values[row.selected];
            autoSaver.queue();
        });
        exclusionsGroup.add(row);
    }

    // --- Add exclusion entry ---
    const addEntry = new Adw.EntryRow({
        title: 'Add exclusion…',
    });
    const addBtn = new Gtk.Button({
        icon_name: 'list-add-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        tooltip_text: 'Add exclusion',
    });
    addEntry.add_suffix(addBtn);
    exclusionsGroup.add(addEntry);

    // Track item rows for removal
    const exclusionRows = [];

    /**
     * Add an exclusion value to the list and UI.
     * @param {string} value - The exclusion string to add
     */
    function addExclusion(value) {
        value = value.trim();
        if (!value || config.exclusions.list.includes(value)) return;

        config.exclusions.list.push(value);

        const itemRow = new Adw.ActionRow({ title: value });
        const removeBtn = new Gtk.Button({
            icon_name: 'edit-delete-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'error'],
            tooltip_text: 'Remove exclusion',
        });
        removeBtn.connect('clicked', () => {
            config.exclusions.list = config.exclusions.list.filter(e => e !== value);
            exclusionsGroup.remove(itemRow);
            const idx = exclusionRows.indexOf(itemRow);
            if (idx >= 0) exclusionRows.splice(idx, 1);
            autoSaver.queue();
        });
        itemRow.add_suffix(removeBtn);
        exclusionsGroup.add(itemRow);
        exclusionRows.push(itemRow);

        addEntry.set_text('');
        autoSaver.queue();
    }

    addBtn.connect('clicked', () => addExclusion(addEntry.get_text()));
    addEntry.connect('entry-activated', () => addExclusion(addEntry.get_text()));

    // Populate existing exclusions from config
    for (const item of config.exclusions.list) {
        const itemRow = new Adw.ActionRow({ title: item });
        const removeBtn = new Gtk.Button({
            icon_name: 'edit-delete-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'error'],
            tooltip_text: 'Remove exclusion',
        });
        removeBtn.connect('clicked', () => {
            config.exclusions.list = config.exclusions.list.filter(e => e !== item);
            exclusionsGroup.remove(itemRow);
            const idx = exclusionRows.indexOf(itemRow);
            if (idx >= 0) exclusionRows.splice(idx, 1);
            autoSaver.queue();
        });
        itemRow.add_suffix(removeBtn);
        exclusionsGroup.add(itemRow);
        exclusionRows.push(itemRow);
    }

    // =======================================================================
    // Cleanup on window close
    // =======================================================================

    window.connect('close-request', () => {
        autoSaver.destroy();
        for (const row of keybindingRows) {
            row.destroy();
        }
        return false; // allow default close
    });

    return page;
}
