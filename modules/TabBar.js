// modules/TabBar.js
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
// import Meta from 'gi://Meta'; // (optional) if you want to type-check Meta.Window

import { Tab } from './Tab.js';

const log = msg => console.log(`[TabbedTiling.TabBar] ${msg}`);

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

        this.reorderTabs();
    }

    removeTab(window) {
        if (this._tabs.has(window)) {
            const tab = this._tabs.get(window);
            this._tabContainer.remove_child(tab);
            tab.destroy();
            this._tabs.delete(window);
            this.reorderTabs();
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

    reorderTabs() {
        const tabs = this._tabContainer.get_children();

        // No need to sort 0 or 1 tab, but we must update styles to remove grouping.
        if (tabs.length < 2) {
            this._updateGroupStyles();
            return;
        }

        tabs.sort((a, b) => {
            const groupA = a.getGroupingId();
            const groupB = b.getGroupingId();

            if (groupA < groupB) return -1;
            if (groupA > groupB) return 1;

            // If groups are the same, sort by title
            const titleA = a.getTabTitle().toLowerCase();
            const titleB = b.getTabTitle().toLowerCase();

            if (titleA < titleB) return -1;
            if (titleA > titleB) return 1;

            return 0;
        });

        log(`Reordering ${tabs.length} tabs. New order:`);
        tabs.forEach((tab, index) => {
            log(`  - [${index}] Group='${tab.getGroupingId()}', Title='${tab.getTabTitle()}'`);
            this._tabContainer.set_child_at_index(tab, index);
        });

        this._updateGroupStyles();
        this._updateTabSizes();
    }

    _updateTabSizes() {
        const children = this._tabContainer.get_children();
        if (children.length === 0) return;

        const availableWidth = this.get_width();
        const maxWidth = this._config.maxWidth ?? 250;

        // Find the preferred width of the widest tab to make all tabs equal.
        const widestPreferred = children.reduce((max, c) => {
            return Math.max(max, c.get_preferred_width(-1)[1]);
        }, 0);

        // Determine the ideal width for each tab, capped by maxWidth.
        const idealWidth = Math.min(widestPreferred, maxWidth);

        if (idealWidth * children.length > availableWidth) {
            // If the ideal width causes an overflow, shrink all tabs equally to fit.
            const newWidth = Math.floor(availableWidth / children.length);
            children.forEach(c => c.set_width(newWidth));
        } else {
            // Otherwise, set all tabs to the same ideal width.
            children.forEach(c => c.set_width(idealWidth));
        }
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
