// modules/TabBar.js
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
// import Meta from 'gi://Meta'; // (optional) if you want to type-check Meta.Window

import { Tab } from './Tab.js';

export const TabBar = GObject.registerClass({
    GTypeName: 'TabbedTiling_TabBar',
    Signals: {
        // Use TYPE_OBJECT for GObject instances (e.g., Meta.Window). TYPE_POINTER causes G_POINTER conversion errors.
        'tab-clicked': { param_types: [GObject.TYPE_OBJECT] }, // Meta.Window
        'tab-removed': { param_types: [GObject.TYPE_OBJECT] }, // Meta.Window
        'tab-moved':   { param_types: [GObject.TYPE_OBJECT] }, // Custom object
    },
}, class TabBar extends St.BoxLayout {
    _init(tabBarConfig) {
        super._init({
            style_class: 'zone-tab-bar',
            reactive: true,
            visible: false,
        });
        
        this.set_height(tabBarConfig.height || 32);
        this.style = `background-color: ${tabBarConfig.backgroundColor};`;        
        this._config = tabBarConfig;
        this._tabs = new Map(); // Meta.Window -> Tab instance
        this._windowTracker = Shell.WindowTracker.get_default();
        // Use a container for tabs to manage layout. Spacing is a CSS property.
        this._tabContainer = new St.BoxLayout({
            style_class: 'zone-tab-container',
            style: `spacing: ${this._config.spacing ?? 4}px;`
        });
        this.add_child(this._tabContainer);        
    }

    addTab(window) {
        if (this._tabs.has(window)) {
            this.setActiveTab(window);
            return;
        }

        const app = this._windowTracker.get_window_app(window);
        const tab = new Tab(window, app, this._config);
        // Apply corner radius from config
        tab.style = `border-radius: ${this._config.cornerRadius ?? 8}px ${this._config.cornerRadius ?? 8}px 0 0;`;        
        
        tab.connect('close-clicked', () => this.emit('tab-removed', window));
        // Ensure the handler is a function (not an immediate call) and returns a valid Clutter event code.
        // Also accept (actor, event) signature to avoid any accidental param marshalling issues.
        tab.connect('button-press-event', (_actor, _event) => {
            try {
                this.emit('tab-clicked', window); // window is a GObject (Meta.Window), matches TYPE_OBJECT
            } catch (e) {
                logError(e, 'Emitting tab-clicked failed');
            }
            return Clutter.EVENT_STOP;
        });

        this._tabs.set(window, tab);
        this._tabContainer.add_child(tab);

        this._updateGroupStyles();
        this._updateTabSizes();        
    }

    removeTab(window) {
        if (this._tabs.has(window)) {
            const tab = this._tabs.get(window);
            this._tabContainer.remove_child(tab);
            tab.destroy();
            this._tabs.delete(window);
            this._updateGroupStyles();
        }
    }
    
    setActiveTab(window) {
        for (const [win, tab] of this._tabs.entries()) {
            if (win === window) {
                tab.add_style_class_name('active');
            } else {
                tab.remove_style_class_name('active');
            }
        }
    }

    _updateTabSizes() {
        const children = this._tabContainer.get_children();
        if (children.length === 0) return;

        const maxWidth = this._config.maxWidth ?? 250;

        // Temporarily set all tabs to preferred width to measure total
        children.forEach(c => c.set_width(-1));

        // Use a short timeout to allow preferred widths to be calculated
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const totalWidth = children.reduce((sum, c) => sum + c.get_width(), 0);
            const availableWidth = this.get_width();

            if (totalWidth > availableWidth) {
                // Shrink tabs if they overflow
                const newWidth = Math.floor(availableWidth / children.length);
                children.forEach(c => c.set_width(Math.min(newWidth, maxWidth)));
            } else {
                // Otherwise, use preferred width up to the max
                children.forEach(c => c.set_width(Math.min(c.get_preferred_width(-1)[1], maxWidth)));
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateGroupStyles() {
        const children = this._tabContainer.get_children();
        if (children.length <= 1) {
            children.forEach(c => {
                c.remove_style_class_name('grouped-start');
                c.remove_style_class_name('grouped-middle');
                c.remove_style_class_name('grouped-end');
            });
            return;
        }

        for (let i = 0; i < children.length; i++) {
            const currentTab = children[i]; // This is a Tab instance
            const prevTab = children[i - 1] ?? null;
            const nextTab = children[i + 1] ?? null;

            const currentId = currentTab.getGroupingId();
            const prevId = prevTab ? prevTab.getGroupingId() : null;
            const nextId = nextTab ? nextTab.getGroupingId() : null;

            currentTab.remove_style_class_name('grouped-start');
            currentTab.remove_style_class_name('grouped-middle');
            currentTab.remove_style_class_name('grouped-end');

            if (currentId === nextId && currentId !== prevId) {
                currentTab.add_style_class_name('grouped-start');
            } else if (currentId === prevId && currentId === nextId) {
                currentTab.add_style_class_name('grouped-middle');
            } else if (currentId === prevId && currentId !== nextId) {
                currentTab.add_style_class_name('grouped-end');
            }
        }
    }

    destroy() {
        this._tabs.forEach(tab => tab.destroy());
        this._tabs.clear();
        super.destroy();
    }
});
