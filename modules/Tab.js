// modules/Tab.js
import St from 'gi://St';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Clutter from 'gi://Clutter';

export const Tab = GObject.registerClass({
    GTypeName: 'TabbedTiling_Tab',
    Signals: {
        'close-clicked': {},
    },
}, class Tab extends St.Button {
    _init(window, app, config) {
        super._init({
            style_class: 'zone-tab',
            can_focus: true,
            reactive: true,
        });

        this.window = window;
        this.app = app;
        this._config = config; // Save config        
        this._destroyed = false;

        const box = new St.BoxLayout({
            style_class: 'zone-tab-content',
            x_expand: true,
        });
        this.set_child(box);

        // App Icon
        if (app) {
            const icon = new St.Icon({
                gicon: app ? app.get_icon() : null,
                style_class: 'zone-tab-app-icon',
                icon_size: this._config.iconSize ?? 16,                
            });
            box.add_child(icon);
        }

        // Title Label
        const label = new St.Label({
            text: this.getTabTitle(),
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'zone-tab-label',
        });
        // Apply font size from config
        label.style = `font-size: ${this._config.fontSize ?? 10}pt;`;        
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        box.add_child(label);

        // Spacer to push the close button to the right
        const spacer = new St.Bin({ x_expand: true });
        box.add_child(spacer);

        // Close Button
        const closeButton = new St.Button({ style_class: 'zone-tab-close-button' });
        closeButton.set_child(new St.Icon({
            icon_name: 'window-close-symbolic',
            icon_size: this._config.closeButtonSize ?? 12,
        }));
        closeButton.connect('clicked', () => {
            try {
                this.emit('close-clicked');
            } catch (e) {
                logError(e, 'TabbedTiling: Error emitting close-clicked');
            }
        });
        box.add_child(closeButton);

        // Connect to window title changes to update the tab
        try {
            this._titleChangedId = window.connect('notify::title', () => {
                if (this._destroyed || !this.window) return;
                try {
                    label.set_text(this.getTabTitle());
                } catch (e) {
                    logError(e, 'TabbedTiling: Error updating tab title');
                }
            });
        } catch (e) {
            logError(e, 'TabbedTiling: Error connecting title signal in Tab constructor');
            this._titleChangedId = null;
        }
    }

    getTabTitle() {
        try {
            const source = this._config.titleSource ?? 'windowTitle';
            if (source === 'appName' && this.app) return this.app.get_name();
            if (source === 'wmClass') return this.window.get_wm_class() ?? '';

            // Default to window title with fallbacks
            return this.window.get_title() || (this.app ? this.app.get_name() : null) || this.window.get_wm_class() || 'Untitled';
        } catch (e) {
            return 'Unknown';
        }
    }

    getGroupingId() {
        try {
            const criteria = this._config.groupingCriteria ?? 'appName';
            if (criteria === 'wmClass') return this.window.get_wm_class() ?? '';
            // Default to app name
            return this.app ? this.app.get_id() : (this.window.get_wm_class() ?? 'unknown');
        } catch (e) {
            return 'unknown';
        }
    }

    getSortKey() {
        try {
            const criteria = this._config.sortingCriteria ?? 'windowTitle';
            if (criteria === 'appName' && this.app) return this.app.get_name();
            if (criteria === 'wmClass') return this.window.get_wm_class() ?? '';

            // Default to window title with fallbacks
            return this.window.get_title() || (this.app ? this.app.get_name() : null) || this.window.get_wm_class() || 'Untitled';
        } catch (e) {
            return 'unknown';
        }
    }

    getGroupSortKey() {
        try {
            const criteria = this._config.groupingCriteria ?? 'appName';
            if (criteria === 'wmClass') return this.window.get_wm_class() ?? 'unknown';
            // Default to app name, using the *display name* for sorting
            return this.app ? this.app.get_name() : (this.window.get_wm_class() ?? 'unknown');
        } catch (e) {
            return 'unknown';
        }
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        try {
            if (this.window && this._titleChangedId) {
                try {
                    this.window.disconnect(this._titleChangedId);
                } catch (e) { /* ignore */ }
            }
        } catch (e) {
            logError(e, 'TabbedTiling: Error in Tab.destroy');
        }
        this._titleChangedId = 0;
        this.window = null;
        this.app = null;

        try {
            super.destroy();
        } catch (e) { }
    }
});
