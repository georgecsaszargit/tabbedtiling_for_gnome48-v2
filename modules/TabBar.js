// modules/TabBar.js
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Tab } from './Tab.js';
import { TabDND } from './TabDND.js';


export const TabBar = GObject.registerClass({
    GTypeName: 'TabbedTiling_TabBar',
    Signals: {
        'tab-clicked': { param_types: [GObject.TYPE_OBJECT] }, // Meta.Window
        'tab-removed': { param_types: [GObject.TYPE_OBJECT] }, // Meta.Window
        'tab-moved':   { param_types: [GObject.TYPE_OBJECT] }, // Custom object
    },
}, class TabBar extends St.BoxLayout {
    _init(tabBarConfig, zone, windowManager) {
        super._init({
            style_class: 'zone-tab-bar',
            reactive: true,
            visible: false,
        });
        this.zone = zone; 
        this.windowManager = windowManager;               
        
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
        
        // Initialize Drag and Drop coordinator
        this._tabDND = new TabDND(this, this.windowManager);
    }

    addTab(window, index = -1) {
        if (this._tabs.has(window)) {
            this.setActiveTab(window);
            return;
        }

        const app = this._windowTracker.get_window_app(window);
        const tab = new Tab(window, app, this._config);
        // Apply corner radius from config
        tab.style = `border-radius: ${this._config.cornerRadius ?? 8}px ${this._config.cornerRadius ?? 8}px 0 0;`;
        
        tab.connect('close-clicked', () => this.emit('tab-removed', window));
        this._tabDND.initPointerHandlers(tab);

        this._tabs.set(window, tab);
        this._tabContainer.insert_child_at_index(tab, index);        

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

    _getGroupedTabs(startTab) {
        const allTabs = this._tabContainer.get_children();
        const startIndex = allTabs.indexOf(startTab);
        const groupId = startTab.getGroupingId();
        if (!groupId) return [startTab];

        const group = [startTab];
        // Search backwards
        for (let i = startIndex - 1; i >= 0 && allTabs[i].getGroupingId() === groupId; i--) group.unshift(allTabs[i]);
        // Search forwards
        for (let i = startIndex + 1; i < allTabs.length && allTabs[i].getGroupingId() === groupId; i++) group.push(allTabs[i]);
        return group;
    }    

    destroy() {
        this._tabDND.destroy();
        this._tabs.forEach(tab => tab.destroy());
        this._tabs.clear();
        super.destroy();
    }    
});
