// modules/Zone.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import { TabBar } from './TabBar.js';

const log = msg => console.log(`[TabbedTiling.Zone] ${msg}`);

export class Zone {
    constructor(zoneData, tabBarConfig, windowTracker, parentZone = null) {
        this.childZones = [];
        this.splitDirection = 'none'; // 'horizontal', 'vertical', or 'none'
        // Copy all properties from the config
        Object.assign(this, zoneData);

        // Set parentZone AFTER Object.assign to prevent it from being overwritten
        // by a null value from the zoneData.
        this.parentZone = parentZone;        
        this._snappedWindows = new Set();
        this._windowTracker = windowTracker;
        // Minimal MRU tracking: most-recently activated window first
        this._history = [];
        this._activeWindow = null;
        // Allow monitor-wide “force hide” of tab bar during max/fullscreen
        this._forceHidden = false; 
        
        this._tabBar = new TabBar(tabBarConfig);
        this._tabBar.connect('tab-clicked', (actor, window) => this.activateWindow(window));
        // When the close button on a tab is clicked, the 'tab-removed' signal is emitted.
        this._tabBar.connect('split-clicked', (actor, direction) => {
            this.split(direction);
        });
        this._tabBar.connect('merge-clicked', () => {
            if (this.parentZone) {
                this.parentZone.merge();
            }
        });        
        // We connect this to an action that closes the actual window.
        this._tabBar.connect('tab-removed', (actor, window) => {
            window.delete(global.get_current_time());
        });
        this._tabBar.connect('tab-moved', (actor, { fromZone, toZone, window }) => {
            // This is a placeholder for inter-zone dragging logic
        });

        this._updateTabBarPosition();
        this._updateActionButtons();        
        Main.layoutManager.addChrome(this._tabBar);
        this._isTabBarInChrome = true; // State tracker for layer changes
    }

    setLayer(isBehind) {
        if (!this._tabBar) return;

        if (isBehind && this._isTabBarInChrome) {
            // It's currently in chrome, so move it to the background.
            // removeChrome untracks the actor and removes it from the UI group.
            Main.layoutManager.removeChrome(this._tabBar);
            // Now add it to the background layer.
            Main.layoutManager._backgroundGroup.add_child(this._tabBar);
            this._tabBar.reactive = false; // Make it non-clickable
            this._isTabBarInChrome = false;
        } else if (!isBehind && !this._isTabBarInChrome) {
            // It's currently in the background, so move it back to chrome.
            // First, ensure it's removed from its current parent (the background group).
            const parent = this._tabBar.get_parent();
            if (parent) {
                parent.remove_child(this._tabBar);
            }
            // addChrome re-adds it to the UI layer and tracks it again.
            Main.layoutManager.addChrome(this._tabBar);
            this._tabBar.reactive = true; // Make it clickable again
            this._isTabBarInChrome = true;
        }
    }

    setTabBarVisible(visible) {
        // Called by WindowManager to hide ALL tab bars on a monitor while
        // a snapped window is maximized/fullscreen.
        // Respect _forceHidden as an override (can be toggled by WindowManager if used).
        if (this._forceHidden) {
            this._tabBar.hide();
            return;
        }
        if (visible) {
            this._tabBar.show();
        } else {
            this._tabBar.hide();
        }
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

    _getGaps() {
        // Normalize gaps from config:
        // prefer this.gaps{top,right,bottom,left}; fall back to legacy numeric this.gap; else zeros
        const g = this.gaps && typeof this.gaps === 'object' ? this.gaps : null;
        const legacy = (typeof this.gap === 'number') ? this.gap : 0;
        return {
            top: Number(g?.top ?? legacy ?? 0),
            right: Number(g?.right ?? legacy ?? 0),
            bottom: Number(g?.bottom ?? legacy ?? 0),
            left: Number(g?.left ?? legacy ?? 0),
        };
    }

    _updateTabBarPosition() {
        if (!this.rect) return;
        const tabBarHeight = this._tabBar.height;
        const { top, right, left } = this._getGaps();
        this._tabBar.set_position(this.rect.x + left, this.rect.y + top);
        this._tabBar.set_size(this.rect.width - (left + right), tabBarHeight);
    }

    _ensureUntiled(window) {
        // Some apps (including GNOME Terminal) can be in a "tiled" state.
        // Just unmaximizing is not always enough; explicitly clear tiling.
        try {
            const maxFlags = (typeof window.get_maximized === 'function') ? window.get_maximized() : Meta.MaximizeFlags.NONE;
            if (maxFlags !== Meta.MaximizeFlags.NONE) {
                window.unmaximize(Meta.MaximizeFlags.BOTH);
            }
            if (typeof window.get_tile_type === 'function' &&
                window.get_tile_type() !== Meta.TileMode.NONE &&
                typeof window.tile === 'function') {
                window.tile(Meta.TileMode.NONE);
            }
        } catch (_) {
            // Ignore if not supported on this shell version.
        }
    }

    _twoStepMoveResize(window, x, y, w, h) {
        // Some clients ignore a single move+resize request (especially with increments).
        // Do a two-step: move first, then resize on idle, then a final move_resize as a fallback.
        window.move_frame(true, x, y);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            window.move_resize_frame(true, x, y, w, h);
            return GLib.SOURCE_REMOVE;
        });
    }
   
    /**
     * Try to respect WM_NORMAL_HINTS resize increments for apps like GNOME Terminal.
     * There isn't a stable public GJS API to read the raw size hints directly,
     * so we use a conservative heuristic:
     *  - Detect well-known terminal classes.
     *  - Apply typical increment values observed via `xprop` (width 10px, height 19px)
     *    with base sizes (68x101). These may vary slightly with theme/fonts, but
     *    will usually be accepted by the client, ensuring snaps “stick”.
     *
     * If the window doesn't match, we return the requested size unchanged.
     */
    _quantizeToSizeHints(window, requestedW, requestedH) {
        try {
            const klass = (window.get_wm_class && window.get_wm_class()) || '';
            const isTerminal =
                klass.toLowerCase().includes('gnome-terminal') ||
                klass.toLowerCase().includes('org.gnome.terminal') ||
                klass.toLowerCase().includes('kgx') ||                      // GNOME Console
                klass.toLowerCase().includes('konsole') ||                  // KDE Konsole
                klass.toLowerCase().includes('alacritty') ||
                klass.toLowerCase().includes('kitty') ||
                klass.toLowerCase().includes('xterm');

            if (!isTerminal)
                return [requestedW, requestedH];

            // Defaults derived from your xprop for GNOME Terminal:
            //   base size: 68x101, increments: 10x19
            // NOTE: If your terminal uses different font metrics, tweak here.
            const baseW = 68;
            const baseH = 101;
            const incW  = 10;
            const incH  = 19;

            // Snap down to the nearest valid multiple so the client always accepts it.
            const adjW = baseW + Math.max(0, Math.floor((requestedW - baseW) / incW)) * incW;
            const adjH = baseH + Math.max(0, Math.floor((requestedH - baseH) / incH)) * incH;
            return [adjW, adjH];
        } catch (_e) {
            return [requestedW, requestedH];
        }
    }

    snapWindow(window) {
        // If this is a parent zone, delegate snap to the first child.
        if (this.childZones.length > 0) {
            this.childZones[0].snapWindow(window);
            return;
        }        
        // GUARD: Never attempt to snap a window that is already maximized or fullscreen.
        // This prevents a race condition where the maximize signal is caught, but another
        // process tries to re-snap the window before its state is fully settled.
		if ((window.get_maximized && window.get_maximized()) || (window.is_fullscreen && window.is_fullscreen())) {
	        return;
	    }
        // If the window is already in another zone (including a sibling), unsnap it first.
        // This is a more robust way to handle moves between zones.
        if (window._tilingZone && window._tilingZone !== this) {
            window._tilingZone.unsnapWindow(window);
        }

        if (!this._snappedWindows.has(window)) {
            this._snappedWindows.add(window);
            window._tilingZoneId = this.name; // Tag the window
            window._tilingZone = this; // Direct reference for easier moves
            this._tabBar.addTab(window);
        }        
        if (!this.rect) return;

        // Ensure not maximized/tiled before attempting to move.
        this._ensureUntiled(window);

        const tabBarHeight = this._tabBar.height;
        const { top, right, bottom, left } = this._getGaps();
        const newX = this.rect.x + left;
        const newY = this.rect.y + top + tabBarHeight; // window below tab bar
        let newWidth = this.rect.width - (left + right);
        let newHeight = this.rect.height - (top + bottom) - tabBarHeight;

        // Respect client resize increments when applicable (e.g., terminals).
        // This prevents Mutter from ignoring our move/resize when sizes are invalid.
        const [adjW, adjH] = this._quantizeToSizeHints(window, newWidth, newHeight);
        newWidth = adjW;
        newHeight = adjH;

        // Perform a two-step move+resize to coax stubborn clients (e.g., GNOME Terminal).
        this._twoStepMoveResize(window, newX, newY, newWidth, newHeight);
        // Final belt-and-suspenders attempt with user_op=false in case the WM treats it differently.
        // (Keeps behavior you added later in the file.)        
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            try {
                window.move_resize_frame(false, newX, newY, newWidth, newHeight);
            } catch (_) {}
            return GLib.SOURCE_REMOVE;
        });

        this.activateWindow(window);
        this._updateVisibility();
    }

    unsnapWindow(window) {
        const wasActive = (this._activeWindow === window);
        if (this._snappedWindows.has(window)) {
            this._snappedWindows.delete(window);
            delete window._tilingZoneId;
            delete window._tilingZone;
            this._tabBar.removeTab(window);

            // Remove from MRU history (and prune any stale refs while we're here)
            this._history = this._history.filter(w => w && w !== window && this._snappedWindows.has(w));

            // If the removed one was active, try to restore the most recent valid one
            if (wasActive) {
                const fallback = this._history.find(w => this._snappedWindows.has(w));
                if (fallback) {
                    this.activateWindow(fallback);
                } else if (this._snappedWindows.size > 0) {
                    // Final fallback: first remaining window in the zone
                    const nextWindow = this._snappedWindows.values().next().value;
                    this.activateWindow(nextWindow);
                } else {
                    // Zone is empty
                    this._activeWindow = null;
                }
            }
        }
        this._updateVisibility();
    }

	/**
     * Safely re-applies snap constraints to a window.
     * This is intended to be called after a state change (like un-maximizing)
     * has settled, to restore the window to its correct zone position.
     */
    restoreSnap(window) {
        if (this._snappedWindows.has(window)) {
            // The guard clause in snapWindow is still important
            this.snapWindow(window);
        }
    }

    cycleTabNext() {
        if (!this._activeWindow) return;

        const tabs = this._tabBar.getTabs();
        if (tabs.length < 2) return;

        const currentIndex = tabs.findIndex(tab => tab.window === this._activeWindow);

        // If found and not the last tab, move to the next one
        if (currentIndex > -1 && currentIndex < tabs.length - 1) {
            const nextTab = tabs[currentIndex + 1];
            if (nextTab && nextTab.window) {
                this.activateWindow(nextTab.window);
            }
        }
    }

    cycleTabPrevious() {
        if (!this._activeWindow) return;

        const tabs = this._tabBar.getTabs();
        if (tabs.length < 2) return;

        const currentIndex = tabs.findIndex(tab => tab.window === this._activeWindow);

        // If found and not the first tab, move to the previous one
        if (currentIndex > 0) {
            const prevTab = tabs[currentIndex - 1];
            if (prevTab && prevTab.window) {
                this.activateWindow(prevTab.window);
            }
        }
    }

    activateWindow(window) {
        if (this._snappedWindows.has(window)) {
            window.activate(global.get_current_time());
            this._tabBar.setActiveTab(window);
            // Immediately update the yellow "globally focused" highlight for this tab.
            // This ensures the tab turns yellow even before the compositor reports focus.
            if (this._tabBar && this._tabBar.reflectGlobalFocus)
                this._tabBar.reflectGlobalFocus(window);            
            // Record MRU (most recent first), dedupe, cap to 5
            this._activeWindow = window;
            this._history = this._history.filter(w => w && w !== window && this._snappedWindows.has(w));
            this._history.unshift(window);
            if (this._history.length > 5)
                this._history.length = 5;            
        }
    }

    cycleTabNext() {
        const tabs = this.getTabs();
        if (tabs.length < 2) return;

        const currentIndex = tabs.findIndex(t => t.window === this._activeWindow);
        if (currentIndex !== -1 && currentIndex < tabs.length - 1) {
            const nextTab = tabs[currentIndex + 1];
            if (nextTab && nextTab.window) {
                this.activateWindow(nextTab.window);
            }
        }
    }

    cycleTabPrevious() {
        const tabs = this.getTabs();
        if (tabs.length < 2) return;

        const currentIndex = tabs.findIndex(t => t.window === this._activeWindow);
        if (currentIndex > 0) {
            const prevTab = tabs[currentIndex - 1];
            if (prevTab && prevTab.window) {
                this.activateWindow(prevTab.window);
            }
        }
    }

    // Called by WindowManager when the global focus changes.
    reflectGlobalFocus(focusedWindow) {
        if (this._tabBar)
            this._tabBar.reflectGlobalFocus(focusedWindow);
    }

    containsWindow(window) {
        return this._snappedWindows.has(window);
    }

    setForceHidden(hidden) {
        if (this._forceHidden === hidden) {
            return;
        }
        this._forceHidden = hidden;
        this._updateVisibility();
    }

    _updateVisibility() {
        const hasWindows = this._snappedWindows.size > 0;
        const shouldBeVisible = hasWindows && !this._forceHidden;
        if (shouldBeVisible)
            this._tabBar.show();
        else
            this._tabBar.hide();
    }

    reorderTabs() {
        this._tabBar.reorderTabs(this.name);
    }

    getSnappedWindows() {
        // Return a copy to allow safe iteration while the original set might be modified.
        return new Set(this._snappedWindows);
    }

    getAllLeafZones() {
        if (this.childZones.length === 0) {
            return [this];
        }
        return this.childZones.flatMap(child => child.getAllLeafZones());
    }

    findLeafZoneAt(x, y) {
        // If this is a parent, search children recursively.
        if (this.childZones.length > 0) {
            for (const child of this.childZones) {
                const found = child.findLeafZoneAt(x, y);
                if (found) return found;
            }
            return null;
        }

        // Otherwise, this is a leaf. Check if the point is within its bounds.
        const rect = this.rect;
        if (!rect) return null;

        if (x >= rect.x && x < rect.x + rect.width &&
            y >= rect.y && y < rect.y + rect.height) {
            return this;
        }
        return null;
    }

    findZoneForWindow(window) {
        // If this is a parent, search children recursively.
        if (this.childZones.length > 0) {
            for (const child of this.childZones) {
                const found = child.findZoneForWindow(window);
                if (found) return found;
            }
            return null;
        }
        // Otherwise, this is a leaf. Check if it contains the window.
        return this.containsWindow(window) ? this : null;
    }

    split(direction) {
        // Can only split a leaf zone that isn't already part of a split
        if (this.childZones.length > 0 || !['horizontal', 'vertical'].includes(direction)) {
            return;
        }

        this.splitDirection = direction;
        const windowsToMove = [...this.getSnappedWindows()];
        windowsToMove.forEach(w => this.unsnapWindow(w)); // Unsnap but keep track

        const childData1 = { ...this }; // Copy properties
        const childData2 = { ...this };

        if (direction === 'horizontal') {
            const newHeight = Math.floor(this.height / 2);
            childData1.height = newHeight;
            childData2.height = this.height - newHeight;
            childData2.y = this.y + newHeight;
        } else { // vertical
            const newWidth = Math.floor(this.width / 2);
            childData1.width = newWidth;
            childData2.width = this.width - newWidth;
            childData2.x = this.x + newWidth;
        }

        const child1 = new Zone(childData1, this._tabBar._config, this._windowTracker, this);
        const child2 = new Zone(childData2, this._tabBar._config, this._windowTracker, this);
        this.childZones = [child1, child2];

        // Move original windows to the first child
        windowsToMove.forEach(w => child1.snapWindow(w));

        this.setTabBarVisible(false);
        this._updateActionButtons();
    }

    merge() {
        // Can only merge if this zone is a parent
        if (this.childZones.length === 0) {
            return;
        }

        const windowsToMove = this.childZones.flatMap(child => [...child.getSnappedWindows()]);

        // Destroy children, which will unsnap their windows
        this.childZones.forEach(child => child.destroy());
        this.childZones = [];
        this.splitDirection = 'none';

        // Re-snap all collected windows to this now-merged zone
        windowsToMove.forEach(w => this.snapWindow(w));

        this._updateVisibility();
        this._updateActionButtons();
    }

    _updateActionButtons() {
        this._tabBar.updateActionButtons(this.childZones.length > 0, !!this.parentZone);
    }

    getTabs() {
        return this._tabBar.getTabs();
    }

    destroy() {
        // Recursively destroy children first
        if (this.childZones.length > 0) {
            [...this.childZones].forEach(child => child.destroy());
            this.childZones = [];
        }        
        // Unsnap all windows before destroying
        [...this._snappedWindows].forEach(win => this.unsnapWindow(win));
        if (this._tabBar) {
            this._tabBar.destroy();
            this._tabBar = null;
        }
    }
}