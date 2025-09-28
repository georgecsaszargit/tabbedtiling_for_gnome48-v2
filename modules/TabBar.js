// modules/TabBar.js
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';

import { Tab } from './Tab.js';

const log = msg => console.log(`[TabbedTiling.TabBar] ${msg}`);

export const TabBar = GObject.registerClass({
    GTypeName: 'TabbedTiling_TabBar',
    Signals: {
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
        this._tabs = new Map();
        this._windowTracker = Shell.WindowTracker.get_default();

        // Settings-driven colors (with sensible fallbacks)
        this._activeBgColor = String(this._config.activeBgColor ?? 'rgba(0, 110, 200, 0.8)');
        this._groupBorderColor = String(this._config.groupBorderColor ?? '#4A90E2');

        this._tabContainer = new St.BoxLayout({
            style_class: 'zone-tab-container',
            style: `spacing: ${this._config.spacing ?? 4}px;`
        });
        this.add_child(this._tabContainer);        
    }

    /* ---------- tiny helpers to compose inline styles without clobbering ---------- */

    _ensureStyleSlots(tab) {
        // Keep separate parts and join them so set_style never overwrites others
        if (!tab.__ttStyleParts) {
            tab.__ttStyleParts = {
                radius: '',     // e.g., 'border-radius: 8px 8px 0 0;'
                bg: '',         // e.g., 'background-color: rgba(...);'
                border: '',     // e.g., 'border-color: #4A90E2;'
            };
        }
        return tab.__ttStyleParts;
    }

    _applyInlineStyle(tab) {
        const p = this._ensureStyleSlots(tab);
        tab.set_style(`${p.radius}${p.bg}${p.border}`);
    }

    _setRadius(tab, css) {
        const p = this._ensureStyleSlots(tab);
        p.radius = css ? `border-radius: ${css};` : '';
        this._applyInlineStyle(tab);
    }

    _setBg(tab, css) {
        const p = this._ensureStyleSlots(tab);
        p.bg = css ? `background-color: ${css};` : '';
        this._applyInlineStyle(tab);
    }

    _setBorderColor(tab, css) {
        const p = this._ensureStyleSlots(tab);
        p.border = css ? `border-color: ${css};` : '';
        this._applyInlineStyle(tab);
    }

    /* ----------------------------------------------------------------------------- */

    addTab(window) {
        if (this._tabs.has(window)) {
            this.setActiveTab(window);
            return;
        }

        const app = this._windowTracker.get_window_app(window);
        const tab = new Tab(window, app, this._config);
        
        tab.connect('close-clicked', () => this.emit('tab-removed', window));
        tab.connect('button-press-event', (_actor, _event) => {
            try {
                this.emit('tab-clicked', window);
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
                // settings-defined active bg
                this._setBg(tab, this._activeBgColor);
            } else {
                tab.remove_style_class_name('active');
                // clear bg override; fall back to CSS default
                this._setBg(tab, '');
            }
        }
    }

    reorderTabs(zoneName = 'Unknown') {
        const tabs = this._tabContainer.get_children();

        if (tabs.length < 2) {
            this._updateGroupStyles();
            return;
        }

        const sortOrder = (this._config.sortingOrder === 'DESC') ? -1 : 1;

        tabs.sort((a, b) => {
            const groupA = a.getGroupSortKey()?.toLowerCase() ?? '';
            const groupB = b.getGroupSortKey()?.toLowerCase() ?? '';

            if (groupA < groupB) return -1 * sortOrder;
            if (groupA > groupB) return 1 * sortOrder;

            const keyA = a.getSortKey()?.toLowerCase() ?? '';
            const keyB = b.getSortKey()?.toLowerCase() ?? '';

            let result = 0;
            if (keyA < keyB) result = -1;
            if (keyA > keyB) result = 1;

            return result * sortOrder;
        });

        tabs.forEach((tab, index) => {
            this._tabContainer.set_child_at_index(tab, index);
        });

        this._updateGroupStyles();
        this._updateTabSizes();
    }

    getTabs() {
        return this._tabContainer.get_children();
    }

    _updateTabSizes() {
        const children = this._tabContainer.get_children();
        if (children.length === 0) return;

        const availableWidth = this.get_width();
        const maxWidth = this._config.maxWidth ?? 250;

        const widestPreferred = children.reduce((max, c) => {
            return Math.max(max, c.get_preferred_width(-1)[1]);
        }, 0);

        const idealWidth = Math.min(widestPreferred, maxWidth);

        if (idealWidth * children.length > availableWidth) {
            const newWidth = Math.floor(availableWidth / children.length);
            children.forEach(c => c.set_width(newWidth));
        } else {
            children.forEach(c => c.set_width(idealWidth));
        }
    }

    _updateGroupStyles() {
        const children = this._tabContainer.get_children();
        const baseR = Number(this._config.cornerRadius ?? 8);

        if (children.length <= 1) {
            children.forEach(c => {
                c.remove_style_class_name('grouped-start');
                c.remove_style_class_name('grouped-middle');
                c.remove_style_class_name('grouped-end');
                // (1) Single tab → both corners rounded
                this._setRadius(c, `${baseR}px ${baseR}px 0 0`);
                // Not grouped → default border color from CSS, so clear any inline
                this._setBorderColor(c, '');
            });
            return;
        }

        for (let i = 0; i < children.length; i++) {
            const currentTab = children[i];
            const prevTab = children[i - 1] ?? null;
            const nextTab = children[i + 1] ?? null;

            const currentId = currentTab.getGroupingId();
            const prevId = prevTab ? prevTab.getGroupingId() : null;
            const nextId = nextTab ? nextTab.getGroupingId() : null;

            currentTab.remove_style_class_name('grouped-start');
            currentTab.remove_style_class_name('grouped-middle');
            currentTab.remove_style_class_name('grouped-end');

            // Default (solo) → both rounded + default border
            let radiusCss = `${baseR}px ${baseR}px 0 0`;
            let borderColorCss = '';

            if (currentId && currentId === nextId && currentId !== prevId) {
                currentTab.add_style_class_name('grouped-start');
                // (2)(3) First in group → only top-left
                radiusCss = `${baseR}px 0 0 0`;
                borderColorCss = this._groupBorderColor;
            } else if (currentId && currentId === prevId && currentId === nextId) {
                currentTab.add_style_class_name('grouped-middle');
                // (6) Middle in group → no radii
                radiusCss = `0`;
                borderColorCss = this._groupBorderColor;
            } else if (currentId && currentId === prevId && currentId !== nextId) {
                currentTab.add_style_class_name('grouped-end');
                // (4)(5) Last in group → only top-right
                radiusCss = `0 ${baseR}px 0 0`;
                borderColorCss = this._groupBorderColor;
            }

            this._setRadius(currentTab, radiusCss);
            this._setBorderColor(currentTab, borderColorCss);
        }
    }

    destroy() {
        this._tabs.forEach(tab => tab.destroy());
        this._tabs.clear();
        super.destroy();
    }
});

