// prefs/AppearancePage.js — Appearance page builder (tab bar visual settings)
// Runs in the prefs process only (GTK4 / libadwaita, GNOME 48).

import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Adw from 'gi://Adw';

import { saveConfig } from './ConfigIO.js';
import { AutoSaver } from './AutoSaver.js';

const log = msg => console.log(`[TabbedTiling.AppearancePage] ${msg}`);

// ---------------------------------------------------------------------------
// Helper: parse an RGBA string into a Gdk.RGBA
// ---------------------------------------------------------------------------

function _parseRgba(str, fallback) {
    const rgba = new Gdk.RGBA();
    if (str && rgba.parse(str)) return rgba;
    const fb = new Gdk.RGBA();
    fb.parse(fallback || 'rgba(0,0,0,1)');
    return fb;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build the "Appearance" preferences page.
 * @param {Adw.PreferencesWindow} window - The prefs window (needed for dialogs)
 * @param {Adw.ToastOverlay} toastOverlay - Toast overlay for feedback
 * @param {object} config - Shared configuration object (mutated in place)
 * @returns {Adw.PreferencesPage}
 */
export function buildAppearancePage(window, toastOverlay, config) {
    const page = new Adw.PreferencesPage({
        title: 'Appearance',
        icon_name: 'applications-graphics-symbolic',
    });

    // Ensure tabBar sub-object exists
    config.tabBar ??= {};

    const autoSaver = new AutoSaver(
        () => saveConfig(config),
        toastOverlay,
        'Appearance saved'
    );

    // =======================================================================
    // GROUP 1: Colors
    // =======================================================================

    const colorsGroup = new Adw.PreferencesGroup({
        title: 'Colors',
        description: 'Configure tab bar colors and opacity',
    });
    page.add(colorsGroup);

    // Helper: create a color picker row
    function addColorRow(title, subtitle, configKey, defaultValue) {
        const row = new Adw.ActionRow({ title, subtitle });
        const colorDialog = new Gtk.ColorDialog({ with_alpha: true });
        const colorBtn = new Gtk.ColorDialogButton({
            dialog: colorDialog,
            valign: Gtk.Align.CENTER,
        });

        // Set initial color
        const initialRgba = _parseRgba(config.tabBar[configKey], defaultValue);
        colorBtn.set_rgba(initialRgba);

        // Detect changes
        colorBtn.connect('notify::rgba', () => {
            const newColor = colorBtn.get_rgba();
            config.tabBar[configKey] = newColor.to_string();
            autoSaver.queue();
        });

        row.add_suffix(colorBtn);
        row.activatable_widget = colorBtn;
        colorsGroup.add(row);
        return colorBtn;
    }

    addColorRow(
        'Tab Background',
        'Background color of inactive tabs in the tab bar',
        'backgroundColor',
        'rgba(30,30,30,0.85)'
    );

    addColorRow(
        'Active Tab',
        'Background color of the focused tab within its zone',
        'activeBgColor',
        'rgba(0,110,200,0.8)'
    );

    addColorRow(
        'Focused Tab',
        'Background color of the tab with keyboard focus (global active)',
        'globalActiveBgColor',
        'rgba(255,230,0,0.9)'
    );

    addColorRow(
        'Group Border',
        'Border color for grouped tabs in the tab bar',
        'groupBorderColor',
        '#4A90E2'
    );

    // =======================================================================
    // GROUP 2: Dimensions
    // =======================================================================

    const dimensionsGroup = new Adw.PreferencesGroup({
        title: 'Dimensions',
        description: 'Size and spacing settings for the tab bar',
    });
    page.add(dimensionsGroup);

    // Helper: create a SpinRow
    function addSpinRow(title, subtitle, configKey, min, max, defaultValue) {
        const currentValue = config.tabBar[configKey] ?? defaultValue;
        const adjustment = new Gtk.Adjustment({
            lower: min,
            upper: max,
            step_increment: 1,
            page_increment: 10,
            value: currentValue,
        });
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment,
            numeric: true,
        });

        adjustment.connect('value-changed', () => {
            config.tabBar[configKey] = adjustment.get_value();
            autoSaver.queue();
        });

        dimensionsGroup.add(row);
        return row;
    }

    addSpinRow(
        'Tab Bar Height',
        'Height of the tab bar in pixels',
        'height',
        16, 256, 32
    );

    addSpinRow(
        'Corner Radius',
        'Rounding of tab bar corners in pixels',
        'cornerRadius',
        0, 32, 8
    );

    addSpinRow(
        'Icon Size',
        'Size of application icons in the tab bar',
        'iconSize',
        8, 48, 16
    );

    addSpinRow(
        'Font Size',
        'Font size for tab titles in points',
        'fontSize',
        6, 24, 10
    );

    addSpinRow(
        'Tab Spacing',
        'Space between tabs in the tab bar',
        'spacing',
        0, 32, 4
    );

    addSpinRow(
        'Max Tab Width',
        'Maximum width of a single tab in pixels',
        'maxWidth',
        50, 1000, 250
    );

    addSpinRow(
        'Close Button Size',
        'Size of the close button on each tab',
        'closeButtonSize',
        8, 32, 12
    );

    // =======================================================================
    // Cleanup on window close
    // =======================================================================

    window.connect('close-request', () => {
        autoSaver.destroy();
        return false; // allow default close
    });

    return page;
}
