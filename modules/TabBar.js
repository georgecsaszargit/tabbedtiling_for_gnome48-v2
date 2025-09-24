// modules/TabBar.js
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
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
        this._config = tabBarConfig;
        this._tabs = new Map(); // Meta.Window -> Tab instance
        this._windowTracker = Shell.WindowTracker.get_default();
    }

    addTab(window) {
        if (this._tabs.has(window)) {
            this.setActiveTab(window);
            return;
        }

        const app = this._windowTracker.get_window_app(window);
        const tab = new Tab(window, app, this._config);
        
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
        this.add_child(tab);

        this._updateGroupStyles();
    }

    removeTab(window) {
        if (this._tabs.has(window)) {
            const tab = this._tabs.get(window);
            this.remove_child(tab);
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

    _getAppId(window) {
        const app = this._windowTracker.get_window_app(window);
        return app ? app.get_id() : (window.get_wm_class() || 'unknown');
    }

    _updateGroupStyles() {
        const children = this.get_children();
        if (children.length <= 1) {
            children.forEach(c => {
                c.remove_style_class_name('grouped-start');
                c.remove_style_class_name('grouped-middle');
                c.remove_style_class_name('grouped-end');
            });
            return;
        }

        for (let i = 0; i < children.length; i++) {
            const currentTab = children[i];
            const prevTab = children[i - 1];
            const nextTab = children[i + 1];

            const currentId = this._getAppId(currentTab.window);
            const prevId = prevTab ? this._getAppId(prevTab.window) : null;
            const nextId = nextTab ? this._getAppId(nextTab.window) : null;

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
