// prefs/ZoneEditorRow.js — Revamped zone editor widget for settings UI
// Runs in the prefs process only (GTK4 / libadwaita).
// Provides an expandable row with organized sub-sections for editing zone properties.

import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

// ---------------------------------------------------------------------------
// ZoneEditorRow
// ---------------------------------------------------------------------------

/**
 * An Adw.ExpanderRow that organizes zone editing into logical sections:
 * Identity, Position & Size, Gaps, and Actions.
 *
 * Signals:
 *   zone-changed — emitted on any property modification (for auto-save + live preview)
 *   zone-removed — emitted when the user confirms zone deletion
 */
export const ZoneEditorRow = GObject.registerClass({
    GTypeName: 'ZoneEditorRow',
    Signals: {
        'zone-changed': {},
        'zone-removed': {},
    },
}, class ZoneEditorRow extends Adw.ExpanderRow {
    /**
     * @param {Object} zoneData - Zone configuration object
     * @param {number} index - Zone index for identification
     * @param {number} resW - Monitor resolution width (for boundary clamping)
     * @param {number} resH - Monitor resolution height (for boundary clamping)
     */
    constructor(zoneData, index, resW, resH) {
        super({
            expanded: false,
        });

        this._index = index;
        this._resW = resW || 1920;
        this._resH = resH || 1080;
        this._updatingValue = false;

        // Add CSS class and provider for darker expanded content background
        this.add_css_class('zone-editor-row');
        ZoneEditorRow._ensureCssProvider();

        // Normalize legacy 'gap' field into per-side gaps
        const legacyGap = zoneData?.gap ?? null;
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

        // Set initial title and subtitle
        this._refreshTitle();
        this._refreshSubtitle();

        // Build all sections
        this._buildIdentitySection();
        this._buildPositionSizeSection();
        this._buildGapsSection();

        // Add delete button to the collapsed header (always visible)
        this._buildHeaderDeleteButton();
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Returns the current zone data object (suitable for serialization).
     * @returns {Object}
     */
    getZoneData() {
        const { name, monitorIndex, x, y, width, height, gaps, isPrimary } = this._zone;
        return { name, monitorIndex, x, y, width, height, gaps, isPrimary };
    }

    /**
     * Update the resolution bounds used for boundary clamping.
     * @param {number} resW - New resolution width
     * @param {number} resH - New resolution height
     */
    updateResolution(resW, resH) {
        this._resW = resW;
        this._resH = resH;

        // Update spin row upper limits
        if (this._xSpinRow) {
            this._xSpinRow.get_adjustment().set_upper(resW);
        }
        if (this._ySpinRow) {
            this._ySpinRow.get_adjustment().set_upper(resH);
        }
        if (this._wSpinRow) {
            this._wSpinRow.get_adjustment().set_upper(resW);
        }
        if (this._hSpinRow) {
            this._hSpinRow.get_adjustment().set_upper(resH);
        }

        // Re-clamp current values
        this._clampPosition();
    }

    /**
     * The zone index (for external identification).
     * @type {number}
     */
    get zoneIndex() {
        return this._index;
    }

    set zoneIndex(val) {
        this._index = val;
        this._refreshTitle();
    }

    // -----------------------------------------------------------------------
    // Section Builders
    // -----------------------------------------------------------------------

    _buildIdentitySection() {
        // Section header
        this._addSectionHeader('Identity');

        // Zone Name
        const nameRow = new Adw.EntryRow({
            title: 'Zone Name',
            text: this._zone.name,
        });
        nameRow.connect('changed', () => {
            this._zone.name = nameRow.get_text();
            this._refreshTitle();
            this._emitChanged();
        });
        this.add_row(nameRow);

        // Monitor Index
        const monAdj = new Gtk.Adjustment({
            lower: 0, upper: 63, step_increment: 1, page_increment: 5, value: this._zone.monitorIndex,
        });
        const monRow = new Adw.SpinRow({
            title: 'Monitor Index',
            adjustment: monAdj,
            numeric: true,
        });
        monAdj.connect('value-changed', () => {
            this._zone.monitorIndex = monAdj.get_value();
            this._refreshSubtitle();
            this._emitChanged();
        });
        this.add_row(monRow);

        // Primary Zone
        const primRow = new Adw.SwitchRow({
            title: 'Primary Zone',
            subtitle: 'Default zone for new windows on this monitor',
            active: this._zone.isPrimary,
        });
        primRow.connect('notify::active', () => {
            this._zone.isPrimary = primRow.get_active();
            this._emitChanged();
        });
        this.add_row(primRow);
    }

    _buildPositionSizeSection() {
        this._addSectionHeader('Position & Size');

        const resW = this._resW;
        const resH = this._resH;

        // X
        const xAdj = new Gtk.Adjustment({
            lower: 0, upper: resW, step_increment: 1, page_increment: 10, value: this._zone.x,
        });
        const xRow = new Adw.SpinRow({
            title: 'X',
            adjustment: xAdj,
            numeric: true,
        });
        xAdj.connect('value-changed', () => {
            if (this._updatingValue) return;
            const v = Math.round(xAdj.get_value());
            const maxX = Math.max(0, this._resW - this._zone.width);
            const clamped = Math.min(Math.max(0, v), maxX);
            this._zone.x = clamped;
            if (clamped !== v) {
                this._updatingValue = true;
                xAdj.set_value(clamped);
                this._updatingValue = false;
            }
            this._refreshSubtitle();
            this._emitChanged();
        });
        this._xSpinRow = xRow;
        this.add_row(xRow);

        // Y
        const yAdj = new Gtk.Adjustment({
            lower: 0, upper: resH, step_increment: 1, page_increment: 10, value: this._zone.y,
        });
        const yRow = new Adw.SpinRow({
            title: 'Y',
            adjustment: yAdj,
            numeric: true,
        });
        yAdj.connect('value-changed', () => {
            if (this._updatingValue) return;
            const v = Math.round(yAdj.get_value());
            const maxY = Math.max(0, this._resH - this._zone.height);
            const clamped = Math.min(Math.max(0, v), maxY);
            this._zone.y = clamped;
            if (clamped !== v) {
                this._updatingValue = true;
                yAdj.set_value(clamped);
                this._updatingValue = false;
            }
            this._refreshSubtitle();
            this._emitChanged();
        });
        this._ySpinRow = yRow;
        this.add_row(yRow);

        // Width
        const wAdj = new Gtk.Adjustment({
            lower: 0, upper: resW, step_increment: 1, page_increment: 10, value: this._zone.width,
        });
        const wRow = new Adw.SpinRow({
            title: 'Width',
            adjustment: wAdj,
            numeric: true,
        });
        wAdj.connect('value-changed', () => {
            if (this._updatingValue) return;
            const v = Math.round(wAdj.get_value());
            const maxW = Math.max(0, this._resW - this._zone.x);
            const clamped = Math.min(Math.max(0, v), maxW);
            this._zone.width = clamped;
            if (clamped !== v) {
                this._updatingValue = true;
                wAdj.set_value(clamped);
                this._updatingValue = false;
            }
            this._refreshSubtitle();
            this._emitChanged();
        });
        this._wSpinRow = wRow;
        this.add_row(wRow);

        // Height
        const hAdj = new Gtk.Adjustment({
            lower: 0, upper: resH, step_increment: 1, page_increment: 10, value: this._zone.height,
        });
        const hRow = new Adw.SpinRow({
            title: 'Height',
            adjustment: hAdj,
            numeric: true,
        });
        hAdj.connect('value-changed', () => {
            if (this._updatingValue) return;
            const v = Math.round(hAdj.get_value());
            const maxH = Math.max(0, this._resH - this._zone.y);
            const clamped = Math.min(Math.max(0, v), maxH);
            this._zone.height = clamped;
            if (clamped !== v) {
                this._updatingValue = true;
                hAdj.set_value(clamped);
                this._updatingValue = false;
            }
            this._refreshSubtitle();
            this._emitChanged();
        });
        this._hSpinRow = hRow;
        this.add_row(hRow);
    }

    _buildGapsSection() {
        this._addSectionHeader('Gaps');

        // "Set All Gaps" convenience row
        const allGapsAdj = new Gtk.Adjustment({
            lower: 0, upper: 256, step_increment: 1, page_increment: 8, value: this._zone.gaps.top,
        });
        const allGapsRow = new Adw.SpinRow({
            title: 'Set All Gaps',
            subtitle: 'Sets top, right, bottom, and left at once',
            adjustment: allGapsAdj,
            numeric: true,
        });
        allGapsAdj.connect('value-changed', () => {
            if (this._updatingValue) return;
            const v = Math.round(allGapsAdj.get_value());
            this._zone.gaps.top = v;
            this._zone.gaps.right = v;
            this._zone.gaps.bottom = v;
            this._zone.gaps.left = v;
            // Sync individual spin rows
            this._updatingValue = true;
            if (this._gapTopAdj) this._gapTopAdj.set_value(v);
            if (this._gapRightAdj) this._gapRightAdj.set_value(v);
            if (this._gapBottomAdj) this._gapBottomAdj.set_value(v);
            if (this._gapLeftAdj) this._gapLeftAdj.set_value(v);
            this._updatingValue = false;
            this._emitChanged();
        });
        this.add_row(allGapsRow);

        // Gap Top
        const gapTopAdj = new Gtk.Adjustment({
            lower: 0, upper: 256, step_increment: 1, page_increment: 8, value: this._zone.gaps.top,
        });
        const gapTopRow = new Adw.SpinRow({
            title: 'Gap Top',
            adjustment: gapTopAdj,
            numeric: true,
        });
        gapTopAdj.connect('value-changed', () => {
            if (this._updatingValue) return;
            this._zone.gaps.top = Math.round(gapTopAdj.get_value());
            this._emitChanged();
        });
        this._gapTopAdj = gapTopAdj;
        this.add_row(gapTopRow);

        // Gap Right
        const gapRightAdj = new Gtk.Adjustment({
            lower: 0, upper: 256, step_increment: 1, page_increment: 8, value: this._zone.gaps.right,
        });
        const gapRightRow = new Adw.SpinRow({
            title: 'Gap Right',
            adjustment: gapRightAdj,
            numeric: true,
        });
        gapRightAdj.connect('value-changed', () => {
            if (this._updatingValue) return;
            this._zone.gaps.right = Math.round(gapRightAdj.get_value());
            this._emitChanged();
        });
        this._gapRightAdj = gapRightAdj;
        this.add_row(gapRightRow);

        // Gap Bottom
        const gapBottomAdj = new Gtk.Adjustment({
            lower: 0, upper: 256, step_increment: 1, page_increment: 8, value: this._zone.gaps.bottom,
        });
        const gapBottomRow = new Adw.SpinRow({
            title: 'Gap Bottom',
            adjustment: gapBottomAdj,
            numeric: true,
        });
        gapBottomAdj.connect('value-changed', () => {
            if (this._updatingValue) return;
            this._zone.gaps.bottom = Math.round(gapBottomAdj.get_value());
            this._emitChanged();
        });
        this._gapBottomAdj = gapBottomAdj;
        this.add_row(gapBottomRow);

        // Gap Left
        const gapLeftAdj = new Gtk.Adjustment({
            lower: 0, upper: 256, step_increment: 1, page_increment: 8, value: this._zone.gaps.left,
        });
        const gapLeftRow = new Adw.SpinRow({
            title: 'Gap Left',
            adjustment: gapLeftAdj,
            numeric: true,
        });
        gapLeftAdj.connect('value-changed', () => {
            if (this._updatingValue) return;
            this._zone.gaps.left = Math.round(gapLeftAdj.get_value());
            this._emitChanged();
        });
        this._gapLeftAdj = gapLeftAdj;
        this.add_row(gapLeftRow);
    }

    _buildHeaderDeleteButton() {
        const deleteBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Delete Zone',
        });
        deleteBtn.add_css_class('flat');
        deleteBtn.add_css_class('destructive-action');
        deleteBtn.connect('clicked', () => this._confirmDelete());
        this.add_suffix(deleteBtn);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Adds a visual section header as an ActionRow with bold markup.
     * @param {string} label - Section title
     */
    _addSectionHeader(label) {
        const headerRow = new Adw.ActionRow({
            title: `<b>${label}</b>`,
            // Disable activation so the row is purely decorative
            activatable: false,
            selectable: false,
        });
        headerRow.add_css_class('property-row');
        // Use markup in title
        headerRow.set_use_markup(true);
        this.add_row(headerRow);
    }

    _refreshTitle() {
        const name = this._zone.name;
        this.set_title(name ? name : `Zone ${this._index + 1}`);
    }

    _refreshSubtitle() {
        const z = this._zone;
        this.set_subtitle(
            `Monitor ${z.monitorIndex} · ${z.width}×${z.height} at (${z.x}, ${z.y})`
        );
    }

    _emitChanged() {
        this.emit('zone-changed');
    }

    _clampPosition() {
        // Ensure X + Width <= resW and Y + Height <= resH after resolution change
        const z = this._zone;
        if (z.x + z.width > this._resW) {
            z.width = Math.max(0, this._resW - z.x);
            if (this._wSpinRow) {
                this._updatingValue = true;
                this._wSpinRow.get_adjustment().set_value(z.width);
                this._updatingValue = false;
            }
        }
        if (z.y + z.height > this._resH) {
            z.height = Math.max(0, this._resH - z.y);
            if (this._hSpinRow) {
                this._updatingValue = true;
                this._hSpinRow.get_adjustment().set_value(z.height);
                this._updatingValue = false;
            }
        }
        this._refreshSubtitle();
    }

    /**
     * Ensures a shared CSS provider is loaded for expanded-row styling.
     * Called once per widget instance but only adds the provider once.
     */
    static _ensureCssProvider() {
        if (ZoneEditorRow._cssProviderAdded) return;
        ZoneEditorRow._cssProviderAdded = true;

        const css = `
            row.expander.zone-editor-row {
                background-color: white;
            }
            row.expander.zone-editor-row list {
                background-color: rgba(0, 0, 0, 0.06);
            }
            row.expander.generator-expander-row {
                background-color: white;
            }
            row.expander.generator-expander-row list {
                background-color: rgba(0, 0, 0, 0.06);
            }
        `;
        const provider = new Gtk.CssProvider();
        provider.load_from_string(css);
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
    }

    /**
     * Shows an Adw.AlertDialog to confirm zone deletion.
     */
    _confirmDelete() {
        const dialog = new Adw.AlertDialog({
            heading: 'Delete Zone?',
            body: `Are you sure you want to delete "${this._zone.name || `Zone ${this._index + 1}`}"? This cannot be undone.`,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');

        dialog.connect('response', (_dlg, response) => {
            if (response === 'delete') {
                this.emit('zone-removed');
            }
        });

        // Present the dialog relative to this widget's root window
        const root = this.get_root();
        dialog.present(root);
    }
});
