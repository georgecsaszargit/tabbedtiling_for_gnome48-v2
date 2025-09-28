// modules/Zone.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';

import { TabBar } from './TabBar.js';

const log = msg => console.log(`[TabbedTiling.Zone] ${msg}`);

export class Zone {
    constructor(zoneData, tabBarConfig, windowTracker) {
        // Copy all properties from the config
        Object.assign(this, zoneData);

        this._snappedWindows = new Set();
        this._windowTracker = windowTracker;
        // Minimal MRU tracking: most-recently activated window first
        this._history = [];
        this._activeWindow = null;      
        
        this._forceHidden = false; // NEW: for fullscreen/maximized handling          

        this._tabBar = new TabBar(tabBarConfig);
        this._tabBar.connect('tab-clicked', (actor, window) => this.activateWindow(window));
        // When the close button on a tab is clicked, the 'tab-removed' signal is emitted.
        // We connect this to an action that closes the actual window.
        this._tabBar.connect('tab-removed', (actor, window) => {
            window.delete(global.get_current_time());
        });
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
            if (window.get_maximized()) {
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
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            try {
                window.move_resize_frame(false, newX, newY, newWidth, newHeight);
            } catch (_) {}
            return GLib.SOURCE_REMOVE;
        });

        if (!this._snappedWindows.has(window)) {
            this._snappedWindows.add(window);
            window._tilingZoneId = this.name; // Tag the window
            this._tabBar.addTab(window);
        }

        this.activateWindow(window);
        this._updateVisibility();
    }

    unsnapWindow(window) {
        const wasActive = (this._activeWindow === window);
        if (this._snappedWindows.has(window)) {
            this._snappedWindows.delete(window);
            delete window._tilingZoneId;
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

    activateWindow(window) {
        if (this._snappedWindows.has(window)) {
            window.activate(global.get_current_time());
            this._tabBar.setActiveTab(window);
            // Record MRU (most recent first), dedupe, cap to 5
            this._activeWindow = window;
            this._history = this._history.filter(w => w && w !== window && this._snappedWindows.has(w));
            this._history.unshift(window);
            if (this._history.length > 5)
                this._history.length = 5;            
        }
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
        if (this._tabBar.visible !== shouldBeVisible) {
            this._tabBar.visible = shouldBeVisible;
        }
    }

    reorderTabs() {
        this._tabBar.reorderTabs(this.name);
    }

    getSnappedWindows() {
        // Return a copy to allow safe iteration while the original set might be modified.
        return new Set(this._snappedWindows);
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
