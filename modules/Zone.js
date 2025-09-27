// modules/Zone.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';

import { TabBar } from './TabBar.js';

const log = msg => console.log(`[TabbedTiling.Zone] ${msg}`);

export class Zone {
    constructor(zoneData, tabBarConfig, windowTracker) {
        // Copy all properties from the config
        Object.assign(this, zoneData);

        this._snappedWindows = new Set();
        this._windowTracker = windowTracker;

        this._tabBar = new TabBar(tabBarConfig);
        this._tabBar.connect('tab-clicked', (actor, window) => this.activateWindow(window));
        this._tabBar.connect('tab-removed', (actor, window) => this.unsnapWindow(window));
        this._tabBar.connect('tab-moved', (actor, { fromZone, toZone, window }) => {
            // This is a placeholder for inter-zone dragging logic
        });
        
        this._updateTabBarPosition();
        Main.layoutManager.addChrome(this._tabBar);
    }

    get monitor() {
        return Main.layoutManager.monitors[this.monitorIndex];
    }
    
    get rect() {
        if (!this.monitor) return null;
        return {
            x: this.monitor.x + this.x,
            y: this.monitor.y + this.y,
            width: this.width,
            height: this.height,
        };
    }

    _updateTabBarPosition() {
        if (!this.rect) return;
        const tabBarHeight = this._tabBar.height;
        this._tabBar.set_position(
            this.rect.x + this.gap,
            this.rect.y + this.gap
        );
        this._tabBar.set_size(this.rect.width - (2 * this.gap), tabBarHeight);
    }
    
    snapWindow(window) {
        if (!this.rect) return;

        if (window.get_maximized()) {
            window.unmaximize(Meta.MaximizeFlags.BOTH);
        }

        const tabBarHeight = this._tabBar.height;
        const newX = this.rect.x + this.gap;
        const newY = this.rect.y + this.gap + tabBarHeight; // Position window below tab bar
        const newWidth = this.rect.width - (2 * this.gap);
        const newHeight = this.rect.height - (2 * this.gap) - tabBarHeight;

        window.move_resize_frame(true, newX, newY, newWidth, newHeight);

        if (!this._snappedWindows.has(window)) {
            this._snappedWindows.add(window);
            window._tilingZoneId = this.name; // Tag the window
            this._tabBar.addTab(window);
        }
        
        this.activateWindow(window);
        this._updateVisibility();
    }

    unsnapWindow(window) {
        if (this._snappedWindows.has(window)) {
            this._snappedWindows.delete(window);
            delete window._tilingZoneId;
            this._tabBar.removeTab(window);

            // Activate the next tab if available
            if (this._snappedWindows.size > 0) {
                const nextWindow = this._snappedWindows.values().next().value;
                this.activateWindow(nextWindow);
            }
        }
        this._updateVisibility();
    }
    
    activateWindow(window) {
        if (this._snappedWindows.has(window)) {
            window.activate(global.get_current_time());
            this._tabBar.setActiveTab(window);
        }
    }

    containsWindow(window) {
        return this._snappedWindows.has(window);
    }

    _updateVisibility() {
        const shouldBeVisible = this._snappedWindows.size > 0;
        if (this._tabBar.visible !== shouldBeVisible) {
            this._tabBar.visible = shouldBeVisible;
        }
    }

    reorderTabs() {
        this._tabBar.reorderTabs(this.name);
    }

    getTabs() {
        return this._tabBar.getTabs();
    }

    destroy() {
        // Unsnap all windows before destroying
        [...this._snappedWindows].forEach(win => this.unsnapWindow(win));
        if (this._tabBar) {
            this._tabBar.destroy();
            this._tabBar = null;
        }
    }
}
