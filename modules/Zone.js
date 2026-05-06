// modules/Zone.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import { TabBar } from './TabBar.js';

const log = msg => console.log(`[TabbedTiling.Zone] ${msg}`);

// Fix 1 & 2: Module-level whitelist of safe config properties that may be
// copied from zoneData JSON into a Zone instance.  EXCLUDES internal state
// (anything starting with '_') and method names.
const SAFE_ZONE_PROPS = [
    'x', 'y', 'width', 'height',
    'monitorIndex', 'splitDirection', 'splitRatio',
    'childZones', 'layer', 'name', 'gaps', 'gap', 'isPrimary',
];

export class Zone {
    constructor(zoneData, tabBarConfig, windowTracker, parentZone = null) {
        // Fix 8: destroyed guard
        this._isDestroyed = false;

        this.childZones = [];
        this.splitDirection = 'none'; // 'horizontal', 'vertical', or 'none'

        // Fix 1: Only copy known safe configuration properties from zoneData
        for (const key of SAFE_ZONE_PROPS) {
            if (key in zoneData) {
                this[key] = zoneData[key];
            }
        }

        // Set parentZone AFTER property copy to prevent it from being overwritten
        // by a null value from the zoneData.
        this.parentZone = parentZone;        
        this._snappedWindows = new Set();
        this._windowTracker = windowTracker;
        // Minimal MRU tracking: most-recently activated window first
        this._history = [];
        this._activeWindow = null;
        // Allow monitor-wide "force hide" of tab bar during max/fullscreen
        this._forceHidden = false;
        // Fix 3: Track pending timer/idle source IDs for cleanup
        this._pendingSourceIds = new Set();
        
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
            try {
                window.delete(global.get_current_time());
            } catch (e) {
                logError(e, 'TabbedTiling: Error deleting window');
            }
        });
        this._tabBar.connect('tab-moved', (actor, { fromZone, toZone, window }) => {
            // This is a placeholder for inter-zone dragging logic
        });

        this._updateTabBarPosition();
        this._updateActionButtons();        
        // Default to being in the background layer.
        Main.layoutManager._backgroundGroup.add_child(this._tabBar);
        this._tabBar.reactive = false;
        this._isTabBarInChrome = false; // State tracker for layer changes
    }

    // Fix 3: Safe timer/idle helpers that track source IDs for cleanup
    _safeTimeoutAdd(priority, interval, callback) {
        const id = GLib.timeout_add(priority, interval, () => {
            try {
                this._pendingSourceIds?.delete(id);
                // Fix 8: early exit if destroyed
                if (this._isDestroyed) return GLib.SOURCE_REMOVE;
                return callback();
            } catch (e) {
                logError(e, 'TabbedTiling: Error in Zone timeout callback');
                return GLib.SOURCE_REMOVE;
            }
        });
        this._pendingSourceIds?.add(id);
        return id;
    }

    _safeIdleAdd(priority, callback) {
        const id = GLib.idle_add(priority, () => {
            try {
                this._pendingSourceIds?.delete(id);
                // Fix 8: early exit if destroyed
                if (this._isDestroyed) return GLib.SOURCE_REMOVE;
                return callback();
            } catch (e) {
                logError(e, 'TabbedTiling: Error in Zone idle callback');
                return GLib.SOURCE_REMOVE;
            }
        });
        this._pendingSourceIds?.add(id);
        return id;
    }

    // Fix 4: Wrap setLayer in try-catch since it manipulates chrome
    setLayer(isBehind) {
        if (!this._tabBar) return;

        try {
            if (isBehind && this._isTabBarInChrome) {
                // It's currently in chrome, so move it to the background.
                try {
                    Main.layoutManager.removeChrome(this._tabBar);
                } catch (e) {
                    logError(e, 'TabbedTiling: Failed to removeChrome in setLayer');
                }
                this._isTabBarInChrome = false; // Mark as removed regardless
                try {
                    Main.layoutManager._backgroundGroup.add_child(this._tabBar);
                    this._tabBar.reactive = false; // Make it non-clickable
                } catch (e) {
                    logError(e, 'TabbedTiling: Failed to add to backgroundGroup in setLayer');
                }
            } else if (!isBehind && !this._isTabBarInChrome) {
                // It's currently in the background, so move it back to chrome.
                // First, ensure it's removed from its current parent (the background group).
                try {
                    const parent = this._tabBar.get_parent?.();
                    if (parent) {
                        parent.remove_child(this._tabBar);
                    }
                } catch (e) {
                    logError(e, 'TabbedTiling: Failed to remove from parent in setLayer');
                }
                // addChrome re-adds it to the UI layer and tracks it again.
                try {
                    Main.layoutManager.addChrome(this._tabBar);
                    this._tabBar.reactive = true; // Make it clickable again
                    this._isTabBarInChrome = true; // Only set on success
                } catch (e) {
                    logError(e, 'TabbedTiling: Failed to addChrome in setLayer');
                }
            }
        } catch (e) {
            logError(e, 'TabbedTiling: Error in Zone.setLayer');
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

    // Fix 7: Safe monitor getter with bounds check
    get monitor() {
        if (this.monitorIndex === undefined || this.monitorIndex < 0 ||
            this.monitorIndex >= Main.layoutManager.monitors.length) {
            return null;
        }
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

    // Fix 5: Add window validity check in idle callback
    _twoStepMoveResize(window, x, y, w, h) {
        // Some clients ignore a single move+resize request (especially with increments).
        // Do a two-step: move first, then resize on idle, then a final move_resize as a fallback.
        if (!window || !window.get_compositor_private()) return;
        window.move_frame(true, x, y);
        this._safeIdleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                if (!window || !window.get_compositor_private()) return GLib.SOURCE_REMOVE;
                window.move_resize_frame(true, x, y, w, h);
            } catch (e) {
                logError(e, 'TabbedTiling: Error in _twoStepMoveResize');
            }
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
     *    will usually be accepted by the client, ensuring snaps "stick".
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

    // Fix 9: Wrap snapWindow in try-catch
    snapWindow(window) {
        try {
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
            try {
                if (window._tilingZone && window._tilingZone !== this) {
                    window._tilingZone.unsnapWindow(window);
                }
            } catch (e) {
                // Old zone was destroyed, clear stale reference
                window._tilingZone = null;
                logError(e, 'TabbedTiling: Error unsnapping from previous zone');
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
            this._safeTimeoutAdd(GLib.PRIORITY_DEFAULT, 50, () => {
                try {
                    if (!window || !window.get_compositor_private()) return GLib.SOURCE_REMOVE;
                    window.move_resize_frame(false, newX, newY, newWidth, newHeight);
                } catch (_) {}
                return GLib.SOURCE_REMOVE;
            });

            this.activateWindow(window);
            this._updateVisibility();
        } catch (e) {
            logError(e, 'TabbedTiling: Error in Zone.snapWindow');
        }
    }

    // Fix 9: Wrap unsnapWindow in try-catch
    unsnapWindow(window) {
        try {
            const title = (() => { try { return window.get_title(); } catch(e) { return '<destroyed>'; } })();
            const wmClass = (() => { try { return window.get_wm_class(); } catch(e) { return '<unknown>'; } })();
            log(`unsnapWindow: Window "${title}" (wmClass=${wmClass}) called on zone "${this.name}"`);
            log(`unsnapWindow: window.get_compositor_private() = ${!!window.get_compositor_private()}, _snappedWindows.has(window) = ${this._snappedWindows.has(window)}`);
            
            if (!window || !window.get_compositor_private()) {
                log(`unsnapWindow: Window actor invalid. _snappedWindows.has(window) = ${this._snappedWindows.has(window)}`);
                // Window already destroyed — just clean up bookkeeping
                if (window && this._snappedWindows.has(window)) {
                    log(`unsnapWindow: Cleaning up stale reference for destroyed window`);
                    this._snappedWindows.delete(window);
                    delete window._tilingZoneId;
                    delete window._tilingZone;
                    log(`unsnapWindow: Calling _tabBar.removeTab for destroyed window`);
                    this._tabBar.removeTab(window);
                    this._history = this._history.filter(w => w && w !== window && this._snappedWindows.has(w));
                    if (this._activeWindow === window) this._activeWindow = null;
                }
                this._updateVisibility();
                return;
            }
            const wasActive = (this._activeWindow === window);
            if (this._snappedWindows.has(window)) {
                log(`unsnapWindow: Removing window from _snappedWindows and calling _tabBar.removeTab`);
                this._snappedWindows.delete(window);
                delete window._tilingZoneId;
                delete window._tilingZone;
                log(`unsnapWindow: Calling _tabBar.removeTab`);
                this._tabBar.removeTab(window);
                log(`unsnapWindow: _tabBar._tabs.size after removeTab = ${this._tabBar._tabs.size}`);

                // Remove from MRU history (and prune any stale refs while we're here)
                this._history = this._history.filter(w => w && w !== window && this._snappedWindows.has(w));

                // If the removed one was active, try to restore the most recent valid one
                if (wasActive) {
                    // Find the next window to activate, prioritizing MRU history.
                    let nextToActivate = this._history.find(w => this._snappedWindows.has(w));
                    if (!nextToActivate && this._snappedWindows.size > 0) {
                        // Final fallback: first remaining window in the zone.
                        nextToActivate = this._snappedWindows.values().next().value;
                    }

                    if (nextToActivate) {
                        // DEFER activation until the window manager is idle. This is the key fix
                        // to prevent a race condition when a window is closed and focus shifts
                        // simultaneously, which can crash mutter.
                        this._safeIdleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            // Re-verify the window is still valid before activating.
                            if (this._snappedWindows.has(nextToActivate)) {
                                this.activateWindow(nextToActivate);
                            }
                            return GLib.SOURCE_REMOVE;
                        });
                    } else {
                        // The zone is now empty.
                        this._activeWindow = null;
                    }
                }
            }
            this._updateVisibility();
        } catch (e) {
            logError(e, 'TabbedTiling: Error in Zone.unsnapWindow');
        }
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

    // Fix 6: Only one definition of cycleTabNext (the more encapsulated version)
    cycleTabNext() {
        try {
            const tabs = this.getTabs();
            if (tabs.length < 2) return;

            const currentIndex = tabs.findIndex(t => t.window === this._activeWindow);
            if (currentIndex !== -1 && currentIndex < tabs.length - 1) {
                const nextTab = tabs[currentIndex + 1];
                if (nextTab && nextTab.window) {
                    this.activateWindow(nextTab.window);
                }
            }
        } catch (e) {
            logError(e, 'TabbedTiling: Error in Zone.cycleTabNext');
        }
    }

    // Fix 6: Only one definition of cycleTabPrevious (the more encapsulated version)
    cycleTabPrevious() {
        try {
            const tabs = this.getTabs();
            if (tabs.length < 2) return;

            const currentIndex = tabs.findIndex(t => t.window === this._activeWindow);
            if (currentIndex > 0) {
                const prevTab = tabs[currentIndex - 1];
                if (prevTab && prevTab.window) {
                    this.activateWindow(prevTab.window);
                }
            }
        } catch (e) {
            logError(e, 'TabbedTiling: Error in Zone.cycleTabPrevious');
        }
    }

    // Fix 10: Add null check and try-catch to activateWindow
    activateWindow(window) {
        if (!this._tabBar || !window) return;
        try {
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
        } catch (e) {
            logError(e, 'TabbedTiling: Error in Zone.activateWindow');
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

    // Fix 2: split() uses SAFE_ZONE_PROPS instead of { ...this }
    split(direction) {
        // Can only split a leaf zone that isn't already part of a split
        if (this.childZones.length > 0 || !['horizontal', 'vertical'].includes(direction)) {
            return;
        }

        this.splitDirection = direction;
        const windowsToMove = [...this.getSnappedWindows()];
        windowsToMove.forEach(w => this.unsnapWindow(w)); // Unsnap but keep track

        // Fix 2: Only copy config properties, not internal state
        const childData1 = {};
        const childData2 = {};
        for (const key of SAFE_ZONE_PROPS) {
            if (key in this) {
                childData1[key] = this[key];
                childData2[key] = this[key];
            }
        }
        // Clear childZones on the child data (they are new leaf zones)
        childData1.childZones = [];
        childData2.childZones = [];
        childData1.splitDirection = 'none';
        childData2.splitDirection = 'none';

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

        // Re-snap all collected windows to this now-merged zone, validating each
        windowsToMove.forEach(w => {
            try {
                if (w && w.get_compositor_private()) {
                    this.snapWindow(w);
                }
            } catch (e) {
                logError(e, 'TabbedTiling: Error re-snapping window during merge');
            }
        });

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
        // Fix 8: Mark as destroyed immediately
        this._isDestroyed = true;

        // Recursively destroy children first
        if (this.childZones.length > 0) {
            [...this.childZones].forEach(child => child.destroy());
            this.childZones = [];
        }
        // Unsnap all windows BEFORE clearing source IDs so any new sources
        // created by unsnapWindow are tracked and cleaned up below.
        [...this._snappedWindows].forEach(win => this.unsnapWindow(win));

        // Fix 3: Cancel all pending timer/idle sources (including any added by unsnap)
        this._pendingSourceIds.forEach(id => {
            try { GLib.source_remove(id); } catch (e) { /* already removed */ }
        });
        this._pendingSourceIds.clear();

        if (this._tabBar) {
            try {
                if (this._isTabBarInChrome) {
                    Main.layoutManager.removeChrome(this._tabBar);
                } else {
                    const parent = this._tabBar.get_parent?.();
                    if (parent) parent.remove_child(this._tabBar);
                }
            } catch (e) {
                // Best-effort removal from parent
            }
            try {
                this._tabBar.destroy();
            } catch (e) { }
            this._tabBar = null;
        }
    }
}
