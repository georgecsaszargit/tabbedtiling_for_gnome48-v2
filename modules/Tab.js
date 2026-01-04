// modules/Tab.js
import St from 'gi://St';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

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

        const box = new St.BoxLayout({
            style_class: 'zone-tab-content',
            x_expand: true,
        });
        this.set_child(box);

        // App Icon
        if (app) {
            const icon = new St.Icon({
                gicon: app.get_icon(),
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
        closeButton.connect('clicked', () => this.emit('close-clicked'));
        box.add_child(closeButton);

        // Connect to window title changes to update the tab
        this._titleChangedId = window.connect('notify::title', () => {
            label.set_text(this.getTabTitle());
        });

        // --- Right-Click Menu ---
        this.menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP);
        this.menu.actor.reactive = true; // Ensure menu can receive events

        const forceCloseItem = new PopupMenu.PopupMenuItem('Force Close');
        forceCloseItem.connect('activate', () => {
            // Re-use the existing 'close-clicked' signal for consistent behavior
            this.emit('close-clicked');
        });
        this.menu.addMenuItem(forceCloseItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const cancelItem = new PopupMenu.PopupMenuItem('Cancel');
        cancelItem.connect('activate', () => {
            this.menu.close();
        });
        this.menu.addMenuItem(cancelItem);

        Main.uiGroup.add_child(this.menu.actor);
        this.menu.actor.hide();

        this.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 3) { // 3 is the right mouse button
                this.menu.open(true);
                return Clutter.EVENT_STOP; // Stop event from propagating
            }
            return Clutter.EVENT_PROPAGATE;
        });    
    }

    getTabTitle() {
        const source = this._config.titleSource ?? 'windowTitle';
        if (source === 'appName' && this.app) return this.app.get_name();
        if (source === 'wmClass') return this.window.get_wm_class();

        // Default to window title with fallbacks
        return this.window.get_title() || (this.app ? this.app.get_name() : null) || this.window.get_wm_class() || 'Untitled';
    }

    getGroupingId() {
        const criteria = this._config.groupingCriteria ?? 'appName';
        if (criteria === 'wmClass') return this.window.get_wm_class();
        // Default to app name
        return this.app ? this.app.get_id() : (this.window.get_wm_class() || 'unknown');
    }

    getSortKey() {
        const criteria = this._config.sortingCriteria ?? 'windowTitle';
        if (criteria === 'appName' && this.app) return this.app.get_name();
        if (criteria === 'wmClass') return this.window.get_wm_class();

        // Default to window title with fallbacks
        return this.window.get_title() || (this.app ? this.app.get_name() : null) || this.window.get_wm_class() || 'Untitled';
    }

    getGroupSortKey() {
        const criteria = this._config.groupingCriteria ?? 'appName';
        if (criteria === 'wmClass') return this.window.get_wm_class() || 'unknown';
        // Default to app name, using the *display name* for sorting
        return this.app ? this.app.get_name() : (this.window.get_wm_class() || 'unknown');
    }

    destroy() {
        if (this._titleChangedId && this.window) {
            try {
                this.window.disconnect(this._titleChangedId);
            } catch (e) { /* ignore */ }
        }
        if (this.menu) {
            this.menu.destroy();
        }
        super.destroy();
    }
});
