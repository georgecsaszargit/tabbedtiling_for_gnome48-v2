// modules/WindowManager.js
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Mtk from 'gi://Mtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';

import { Zone } from './Zone.js';

const log = (msg) => console.log(`[TabbedTiling.WindowManager] ${msg}`);

export class WindowManager {
    constructor(configManager, highlighter) {
        this._configManager = configManager;
        this._highlighter = highlighter;
        this._zones = [];
        this._signalConnections = [];
        this._windowTracker = Shell.WindowTracker.get_default();
        // Track per-window state change handlers so we can disconnect safely
        this._windowStateSignals = new Map();
        this._loginProxy = null;
        // Hover polling while dragging (since MetaDisplay lacks grab-op-motion)
        this._tabBarsToggledBack = false;
        this._dragHoverTimerId = 0;
    }

    cycleTabNextInFocusedZone() {
        const focusedWindow = global.display.get_focus_window();
        if (!focusedWindow) return;

        const zone = this._findZoneForWindow(focusedWindow);
        if (zone) {
            zone.cycleTabNext();
        }
    }

    cycleTabPreviousInFocusedZone() {
        const focusedWindow = global.display.get_focus_window();
        if (!focusedWindow) return;

        const zone = this._findZoneForWindow(focusedWindow);
        if (zone) {
            zone.cycleTabPrevious();
        }
    }

    toggleTabBarsLayer() {
        this._tabBarsToggledBack = !this._tabBarsToggledBack;
        log(`Toggling tab bars layer. Now behind: ${this._tabBarsToggledBack}`);

        // This recursive function ensures we apply the setting to all zones,
        // including children created by splitting a zone.
        const applyToAll = (zone) => {
            zone.setLayer(this._tabBarsToggledBack);
            if (zone.childZones && zone.childZones.length > 0) {
                zone.childZones.forEach(applyToAll);
            }
        };

        this._zones.forEach(applyToAll);
    }

    _onFocusChanged() {
        const focused = global.display.get_focus_window();
        this._zones.forEach(z => z.reflectGlobalFocus(focused));
    }

    enable() {
        log("DEBUG: enable() called.");
        this.reloadConfiguration();
        this._connectSignals();
        this._updateAllZonesVisibility();
        this._snapExistingWindows();
        // Initialize correct highlighting on startup
        this._onFocusChanged();        
    }

    disable() {
        log("DEBUG: disable() called.");
        this._disconnectSignals();
        this._zones.forEach(zone => zone.destroy());
        this._zones = [];
        this._highlighter.hideHoverHighlight();
    }

    reloadConfiguration() {
        log("DEBUG: reloadConfiguration() called.");
        const config = this._configManager.load();

        this._zones.forEach(zone => zone.destroy());
        this._zones = [];

        config.zones.forEach(zoneData => {
            this._zones.push(new Zone(zoneData, config.tabBar, this._windowTracker));
        });

        log(`Loaded ${this._zones.length} zones.`);
        this._updateAllZonesVisibility();
        this._snapExistingWindows();
    }

    _connectSignals() {
        log("DEBUG: _connectSignals() called.");
        const connect = (gobj, name, cb) => {
            const id = gobj.connect(name, cb);
            this._signalConnections.push({ gobj, id });
        };

        connect(global.display, 'grab-op-begin', this._onGrabOpBegin.bind(this));
        connect(global.display, 'grab-op-end', this._onGrabOpEnd.bind(this));
        connect(global.display, 'window-created', this._onWindowCreated.bind(this));
        connect(this._windowTracker, 'tracked-windows-changed', this._onTrackedWindowsChanged.bind(this));
        connect(Main.layoutManager, 'monitors-changed', () => this.reloadConfiguration());
        // Keep tab highlights in sync with true keyboard focus
        connect(global.display, 'notify::focus-window', this._onFocusChanged.bind(this));

        // Manually create a proxy for LoginManager to handle suspend/resume.
        const LoginManagerIface = `
        <node>
            <interface name="org.freedesktop.login1.Manager">
                <signal name="PrepareForSleep">
                    <arg type="b" name="starting"/>
                </signal>
            </interface>
        </node>`;

        log("DEBUG: Attempting to create LoginManager proxy...");
        try {
            const info = Gio.DBusNodeInfo.new_for_xml(LoginManagerIface);
            const interfaceInfo = info.interfaces.find(i => i.name === 'org.freedesktop.login1.Manager');

            Gio.DBusProxy.new_for_bus(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                interfaceInfo,
                'org.freedesktop.login1',      // name
                '/org/freedesktop/login1',      // object path
                'org.freedesktop.login1.Manager', // interface name
                null, // cancellable
                (source_object, res) => {
                    try {
                        const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                        log("DEBUG: LoginManager proxy created successfully.");
                        this._loginProxy = proxy;

                        connect(this._loginProxy, 'g-signal', (p, sender, signal, params) => {
                             if (signal === 'PrepareForSleep') {
                                const starting = params.get_child_value(0).get_boolean();
                                if (!starting) {
                                    log("DEBUG: System resumed from sleep, re-snapping windows.");
                                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                                        this._snapExistingWindows();
                                        return GLib.SOURCE_REMOVE;
                                    });
                                }
                             }
                        });
                    } catch (e) {
                        log(`ERROR: Failed to finalize LoginManager proxy or connect signal. Error: ${e.message}`);
                    }
                }
            );
        } catch (e) {
            log(`ERROR: Could not create LoginManager proxy. D-Bus XML may be invalid. Error: ${e.message}`);
        }
    }

    _disconnectSignals() {
        log("DEBUG: _disconnectSignals() called.");
        this._signalConnections.forEach(({ gobj, id }) => {
            try {
                gobj.disconnect(id);
            } catch (e) {
                // Ignore errors if object is already gone
            }
        });
        this._signalConnections = [];
        this._loginProxy = null;
        this._disconnectWindowStateSignals();
        this._stopDragHoverTimer();
    }

    /**
     * Tracks state changes for a window (maximize, fullscreen) to manage tab bar visibility
     * and re-snap behavior. This is the definitive, race-condition-safe implementation.
     */
    _trackWindowState(window) {
        if (!window || this._windowStateSignals.has(window)) {
            return;
        }

        // The 'actor' is the actual visual object on the screen. This is what we need to watch.
        const actor = window.get_compositor_private();
        if (!actor) {
            return; // Cannot track if there is no actor
        }

        let checkQueued = false; // A flag to prevent the handler from running too many times during a resize.

        const onAllocationChanged = () => {
            // If a check is already scheduled for the next idle moment, don't queue another.
            if (checkQueued) return;
            checkQueued = true;

            // Use GLib.idle_add. This is the crucial part. It waits until Mutter has
            // completely finished its current drawing and layout cycle before we run our code.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                checkQueued = false; // Allow the next allocation change to queue a new check.

                // Ensure the window wasn't destroyed while we were waiting.
                if (!window || window.get_display() === null) {
                    return GLib.SOURCE_REMOVE;
                }

                // Step 1: Always, always update the visibility of tab bars first.
                this._updateAllZonesVisibility();

                // Step 2: Now that the UI is correct, check if the window is back to a normal state.
                const isMaximized = window.get_maximized() !== Meta.MaximizeFlags.NONE;
                const isFullscreen = window.is_fullscreen();

                // Step 3: If it's normal, it is now 100% safe to restore its snapped position.
                if (!isMaximized && !isFullscreen) {
                    const zone = this._findZoneForWindow(window);
                    if (zone) {
                        zone.restoreSnap(window);
                    }
                }
                
                return GLib.SOURCE_REMOVE; // This idle task is done.
            });
        };

        const ids = [
            // The CORRECTED signal: listen to the actor's allocation, not the window's properties.
            actor.connect('notify::allocation', onAllocationChanged),
            // We still need to clean up when the window is closed.
            window.connect('unmanaged', () => this._untrackWindowState(window))
        ];

        this._windowStateSignals.set(window, ids);
    }

    _untrackWindowState(window) {
        if (this._windowStateSignals.has(window)) {
            this._windowStateSignals.get(window).forEach(id => {
                try {
                    if (window.is_remote() === false) { // Check if the window object is still valid
                         window.disconnect(id);
                    }
                } catch (e) { /* ignore errors on already destroyed objects */ }
            });
            this._windowStateSignals.delete(window);
        }
    }

    _disconnectWindowStateSignals() {
        this._windowStateSignals.forEach((ids, window) => {
            ids.forEach(id => {
                try {
                    if (window.is_remote() === false) {
                        window.disconnect(id);
                    }
                } catch (e) { /* ignore */ }
            });
        });
        this._windowStateSignals.clear();
    }

    _startDragHoverTimer() {
        if (this._dragHoverTimerId) return;
        // ~60fps polling (about 16ms). Cheap and reliable on both X11/Wayland.
        this._dragHoverTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            this._updateHoverHighlightFromPointer();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopDragHoverTimer() {
        if (this._dragHoverTimerId) {
            GLib.Source.remove(this._dragHoverTimerId);
            this._dragHoverTimerId = 0;
        }
        this._highlighter.hideHoverHighlight();
    }

    _updateHoverHighlightFromPointer() {
        const [x, y, mods] = global.get_pointer();
        // If Ctrl is held, or we don't currently have a snappable drag, hide highlight.
        if ((mods & Clutter.ModifierType.CONTROL_MASK) !== 0) {
            this._highlighter.hideHoverHighlight();
            return;
        }
        // IMPORTANT: We must search for the specific LEAF zone under the cursor.
        // A parent zone is just a container and shouldn't be highlighted itself.
        const zone = this._findLeafZoneAt(x, y) ?? this._findNearestZoneWithinThreshold(x, y, 48);
        if (zone) {
            // Get the tab bar height from the configuration to calculate the correct highlight area.
            const config = this._configManager.getConfig();
            const tabBarHeight = config.tabBar?.height ?? 32; // Use optional chaining and a fallback.

            // The highlight should only cover the area *below* the tab bar.
            const highlightHeight = zone.height - tabBarHeight;

            // Only show the highlight if there's actual space for it.
            if (highlightHeight > 0) {
                const highlightRect = {
                    monitorIndex: zone.monitorIndex,
                    x: zone.x,
                    y: zone.y + tabBarHeight, // Shift the highlight down.
                    width: zone.width,
                    height: highlightHeight,   // Make the highlight shorter.
                };
                this._highlighter.showHoverHighlight(highlightRect);
            } else {
                this._highlighter.hideHoverHighlight();
            }
        } else {
            this._highlighter.hideHoverHighlight();
        }
    }

    _isSnappable(window) {
        if (!window || window.is_fullscreen()) {
            return false;
        }

        // NEW: Check against exclusion list
        const config = this._configManager.getConfig();
        const exclusions = config.exclusions ?? { list: [], criteria: 'wmClass' };
        if (exclusions.list && exclusions.list.length > 0) {
            let windowId = null;
            if (exclusions.criteria === 'appName') {
                const app = this._windowTracker.get_window_app(window);
                if (app) {
                    windowId = app.get_name();
                }
            } else { // default to 'wmClass'
                windowId = window.get_wm_class();
            }

            if (windowId && exclusions.list.some(item => windowId.includes(item))) {
                log(`Window "${windowId}" is in the exclusion list. Tiling will be skipped.`);
                return false;
            }
        }
        const type = window.get_window_type();
        return type === Meta.WindowType.NORMAL;
    }

    _onGrabOpBegin(display, window, op) {
        if (!this._isSnappable(window)) return;

        // Bypass tiling logic if holding CTRL
        const [, , mods] = global.get_pointer();
        if ((mods & Clutter.ModifierType.CONTROL_MASK) !== 0) {
            window._tilingBypass = true;
            // Ensure any hover highlight is hidden while bypassing
            this._highlighter.hideHoverHighlight();
            this._stopDragHoverTimer();
            return;
        }
        delete window._tilingBypass; // Clear it if CTRL isn't held

        // ONLY apply moving logic for MOVING ops. For RESIZING, we do nothing.
        if (op === Meta.GrabOp.MOVING) {
            const currentZone = this._findZoneForWindow(window);
            if (currentZone) {
                window.raise();
                window._tilingOriginalZone = currentZone;
            }
            // Begin hover polling for live zone highlight
            this._startDragHoverTimer();
        } else {
            // For any other operation (like resizing), set the bypass flag.
            // This prevents _onGrabOpEnd from trying to re-snap the window.
            window._tilingBypass = true;
            this._stopDragHoverTimer();
        }
    }

    _distancePointToRect(x, y, rect) {
        // rect: {x, y, width, height}
        const rx1 = rect.x;
        const ry1 = rect.y;
        const rx2 = rect.x + rect.width;
        const ry2 = rect.y + rect.height;

        // dx/dy are zero if the point is inside the interval
        const dx = (x < rx1) ? (rx1 - x) : (x > rx2) ? (x - rx2) : 0;
        const dy = (y < ry1) ? (ry1 - y) : (y > ry2) ? (y - ry2) : 0;
        // Euclidean distance to the rectangle (0 if inside)
        return Math.hypot(dx, dy);
    }

    _findNearestZoneWithinThreshold(x, y, thresholdPx = 48) {
        // Find the closest zone (by rect distance) on the pointer's monitor,
        // accepting it if the pointer is within `thresholdPx` of the zone.
        const monitorIndex = global.display.get_monitor_index_for_rect(
            new Mtk.Rectangle({ x, y, width: 1, height: 1 })
        );

        let best = { zone: null, dist: Infinity };
        // Get all leaf zones on the current monitor
        const leafZonesOnMonitor = this._zones
            .flatMap(zone => zone.getAllLeafZones())
            .filter(leaf => leaf.monitorIndex === monitorIndex);

        if (leafZonesOnMonitor.length === 0) return null;
        const monitor = Main.layoutManager.monitors[monitorIndex];

        for (const zone of leafZonesOnMonitor) {
            const rect = {
                x: monitor.x + zone.x,
                y: monitor.y + zone.y,
                width: zone.width,
                height: zone.height,
            };
            const d = this._distancePointToRect(x, y, rect);
            if (d < best.dist) {
                best = { zone, dist: d };
            }
        }
        return (best.zone && best.dist <= thresholdPx) ? best.zone : null;
    }

    _onGrabOpEnd(display, window) {
        if (window._tilingBypass) {
            delete window._tilingBypass;
            this._highlighter.hideHoverHighlight();
            return;
        }

        if (!this._isSnappable(window)) return;
        this._stopDragHoverTimer();
        this._highlighter.hideHoverHighlight();

        const [pointerX, pointerY] = global.get_pointer();
        // 1) Try direct hit
        let targetZone = this._findLeafZoneAt(pointerX, pointerY);

        const originalZone = window._tilingOriginalZone;
        if (originalZone) {
            delete window._tilingOriginalZone;
        }

        // If we dragged out of all zones (e.g., to the very top pixel),
        // 2) Try nearest zone within a small threshold
        if (!targetZone) {
            targetZone = this._findNearestZoneWithinThreshold(pointerX, pointerY, 48);
        }

        // 3) If still nothing, and we had an original zone on the same monitor,
        //    snap back to the original zone (graceful fallback).
        if (!targetZone && originalZone) {
            const monitorAtDrop = global.display.get_monitor_index_for_rect(
                new Mtk.Rectangle({ x: pointerX, y: pointerY, width: 1, height: 1 })
            );
            if (monitorAtDrop === originalZone.monitorIndex) {
                targetZone = originalZone;
            }
        }

        if (originalZone && targetZone && targetZone !== originalZone) {
            originalZone.unsnapWindow(window);
        }

        if (targetZone) {
            targetZone.snapWindow(window);
        }
    }

    _onWindowCreated(display, window) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            if (!window || !this._isSnappable(window)) return GLib.SOURCE_REMOVE;
            this._trackWindowState(window); // Track state changes (maximized, etc.)
            const monitorIndex = window.get_monitor();
            const primaryZone = this._zones.find(z =>
                z.monitorIndex === monitorIndex && z.isPrimary
            );

            if (primaryZone) {
                log(`New window "${window.get_title()}" snapping to primary zone.`);
                primaryZone.snapWindow(window);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Re-run per monitor when tracked windows list changes (e.g., window closed)
    _onTrackedWindowsChanged() {
        const currentWindows = new Set(global.get_window_actors().map(a => a.get_meta_window()));
        const previouslyTracked = new Set(this._windowStateSignals.keys());

        // Untrack closed windows and remove them from zones
        for (const window of previouslyTracked) {
            if (!currentWindows.has(window)) {
                this._untrackWindowState(window);
                const zone = this._findZoneForWindow(window);
                if (zone) {
                    log(`Window "${window.get_title()}" is no longer tracked, removing from zone "${zone.name}".`);
                    zone.unsnapWindow(window);
                }
            }
        }

        // Track new windows
        for (const window of currentWindows) {
            if (!previouslyTracked.has(window)) {
                this._trackWindowState(window);
            }
        }
        this._updateAllZonesVisibility();
    }

    _updateAllZonesVisibility() {
        const allWindows = global.get_window_actors().map(a => a.get_meta_window());
        const monitorsWithMaximizedWindows = new Set();
        allWindows.forEach(win => {
            if ((win.get_maximized && win.get_maximized()) || (win.is_fullscreen && win.is_fullscreen())) {
                monitorsWithMaximizedWindows.add(win.get_monitor());
            }
        });
        const monitors = Main.layoutManager.monitors || [];
        for (let i = 0; i < monitors.length; i++) {
            const shouldHide = monitorsWithMaximizedWindows.has(i);
            this._zones.forEach(zone => {
                if (zone.monitorIndex === i) {
                    zone.setForceHidden(shouldHide);
                }
            });
        }
    }

    _snapExistingWindows() {
        const allWindows = global.get_window_actors().map(a => a.get_meta_window());
        allWindows.forEach(window => {
            this._trackWindowState(window);
            if (this._isSnappable(window)) {
                let targetZone = this._findZoneForWindow(window);

                if (!targetZone) {
                    targetZone = this._findBestZoneForWindow(window);
                }

                if (targetZone) {
                    targetZone.snapWindow(window);
                }
            }
        });
        this._updateAllZonesVisibility();
        this._zones.forEach(zone => zone.reorderTabs());
    }

    _logZoneStates() {
        log('--- Final Zone States ---');
        this._zones.forEach(zone => {
            const tabs = zone.getTabs();
            if (tabs.length === 0) return;

            log(`Zone "${zone.name}" contains ${tabs.length} tabs:`);
            tabs.forEach((tab, index) => {
                const appName = tab.app ? tab.app.get_name() : 'N/A';
                const windowTitle = tab.window.get_title() || 'N/A';
                const wmClass = tab.window.get_wm_class() || 'N/A';
                log(`  - [${index}] App='${appName}', Title='${windowTitle}', WMClass='${wmClass}'`);
            });
        });
    }

    _findBestZoneForWindow(window) {
        if (!window) return null;
        const frame = window.get_frame_rect();
        const centerX = frame.x + frame.width / 2;
        const centerY = frame.y + frame.height / 2;
        return this._findLeafZoneAt(centerX, centerY);
    }

    _findLeafZoneAt(x, y) {
        for (const zone of this._zones) {
            // Search through the zone and its children recursively
            const leafZone = zone.findLeafZoneAt(x, y);
            if (leafZone) return leafZone;
        }
        return null;
    }

    _findZoneForWindow(window) {
        // Check the direct reference first for performance
        if (window._tilingZone && window._tilingZone.containsWindow(window)) {
            return window._tilingZone;
        }

        // Fallback: search all zones recursively
        for (const zone of this._zones) {
            const found = zone.findZoneForWindow(window);
            if (found) return found;
        }
        return null;
    }
}