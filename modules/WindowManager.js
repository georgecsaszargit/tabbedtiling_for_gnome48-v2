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
    constructor(configManager, highlighter, profileManager = null) {
        this._configManager = configManager;
        this._highlighter = highlighter;
        this._profileManager = profileManager;
        this._zones = [];
        this._signalConnections = [];
        this._windowTracker = Shell.WindowTracker.get_default();
        // Track per-window state change handlers so we can disconnect safely
        this._windowStateSignals = new Map();
        this._loginProxy = null;
        // Hover polling while dragging (since MetaDisplay lacks grab-op-motion)
        this._tabBarsToggledBack = true; // Start with tab bars in the background
        this._dragHoverTimerId = 0;
        // Fix 2: Track all pending GLib source IDs for safe cleanup
        this._pendingSourceIds = new Set();
        // Fix 8: Disabled guard to prevent callbacks from running after disable()
        this._isDisabled = false;
    }

    // Fix 2: Safe wrappers for GLib.timeout_add / GLib.idle_add
    _safeTimeoutAdd(priority, interval, callback) {
        const id = GLib.timeout_add(priority, interval, () => {
            try {
                this._pendingSourceIds?.delete(id);
                return callback();
            } catch (e) {
                logError(e, 'TabbedTiling: Error in timeout callback');
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
                return callback();
            } catch (e) {
                logError(e, 'TabbedTiling: Error in idle callback');
                return GLib.SOURCE_REMOVE;
            }
        });
        this._pendingSourceIds?.add(id);
        return id;
    }

    // Crash-proofing: Validate that a Meta.Window is still usable
    _isWindowValid(window) {
        try {
            if (!window) return false;
            if (!window.get_compositor_private()) return false;
            return true;
        } catch (e) {
            return false;
        }
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
        this._isDisabled = false;
        this.reloadConfiguration();
        this._connectSignals();
        this._updateAllZonesVisibility();
        this._snapExistingWindows();
        // Initialize correct highlighting on startup
        this._onFocusChanged();        
    }

    disable() {
        if (this._isDisabled) return; // Guard against double-calls
        log("DEBUG: disable() called.");
        // Fix 8: Set disabled guard immediately
        this._isDisabled = true;
        // Cancel D-Bus proxy creation if still in flight
        if (this._dbusCancellable) {
            this._dbusCancellable.cancel();
            this._dbusCancellable = null;
        }
        // Fix 2: Cancel all pending timer/idle sources before anything else
        this._pendingSourceIds.forEach(id => {
            try { GLib.source_remove(id); } catch (e) { /* already removed */ }
        });
        this._pendingSourceIds.clear();
        this._disconnectSignals();
        this._zones.forEach(zone => zone.destroy());
        this._zones = [];
        this._highlighter.hideHoverHighlight();
    }

    /**
     * Pause tiling: destroy all zones, unsnap windows, disconnect signals.
     * The extension remains loaded but inactive.
     */
    pause() {
        log("Pausing tiling...");
        this._disconnectSignals();
        this._zones.forEach(zone => zone.destroy());
        this._zones = [];
        this._highlighter.hideHoverHighlight();
        this._isPaused = true;
        log("Tiling paused.");
    }

    /**
     * Resume tiling: reload configuration, reconnect signals, re-snap windows.
     */
    resume() {
        log("Resuming tiling...");
        this._isPaused = false;
        this.reloadConfiguration();
        this._connectSignals();
        this._updateAllZonesVisibility();
        this._snapExistingWindows();
        this._onFocusChanged();
        log("Tiling resumed.");
    }

    get isPaused() {
        return !!this._isPaused;
    }

    reloadConfiguration() {
        log("DEBUG: reloadConfiguration() called.");
        const config = this._configManager.load();

        this._zones.forEach(zone => zone.destroy());
        this._zones = [];

        // Get zones from ProfileManager if available, otherwise use config
        let zonesToLoad;
        if (this._profileManager) {
            // Re-read profiles from disk to pick up changes from prefs window
            this._profileManager.load();
            const activeProfile = this._profileManager.getActiveProfile();
            const profileConfig = this._profileManager.loadProfileConfig(activeProfile);
            zonesToLoad = profileConfig.zones || [];
            log(`Loading zones from profile: ${activeProfile}`);
        } else {
            zonesToLoad = config.zones || [];
        }

        zonesToLoad.forEach(zoneData => {
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

        // Fix 7: Wrap grab-op-begin handler in try-catch
        connect(global.display, 'grab-op-begin', (display, window, op) => {
            try {
                if (this._isDisabled) return; // Fix 8
                this._onGrabOpBegin(display, window, op);
            } catch (e) {
                logError(e, 'TabbedTiling: Error in grab-op-begin handler');
            }
        });
        // Fix 7: Wrap grab-op-end handler in try-catch
        connect(global.display, 'grab-op-end', (display, window) => {
            try {
                if (this._isDisabled) return; // Fix 8
                this._onGrabOpEnd(display, window);
            } catch (e) {
                logError(e, 'TabbedTiling: Error in grab-op-end handler');
            }
        });
        // Fix 7: Wrap window-created handler in try-catch
        connect(global.display, 'window-created', (display, window) => {
            try {
                if (this._isDisabled) return; // Fix 8
                this._onWindowCreated(display, window);
            } catch (e) {
                logError(e, 'TabbedTiling: Error in window-created handler');
            }
        });
        // Fix 7: Wrap tracked-windows-changed handler in try-catch
        connect(this._windowTracker, 'tracked-windows-changed', () => {
            try {
                if (this._isDisabled) return; // Fix 8
                this._onTrackedWindowsChanged();
            } catch (e) {
                logError(e, 'TabbedTiling: Error in tracked-windows-changed handler');
            }
        });
        connect(Main.layoutManager, 'monitors-changed', () => {
            try {
                if (this._isDisabled) return;
                this.reloadConfiguration();
            } catch (e) {
                logError(e, 'TabbedTiling: Error in monitors-changed handler');
            }
        });
        // Keep tab highlights in sync with true keyboard focus
        connect(global.display, 'notify::focus-window', () => {
            try {
                if (this._isDisabled) return;
                this._onFocusChanged();
            } catch (e) {
                logError(e, 'TabbedTiling: Error in focus-changed handler');
            }
        });

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

            // Create a cancellable so we can abort the async proxy if disable() is called
            this._dbusCancellable = new Gio.Cancellable();

            Gio.DBusProxy.new_for_bus(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                interfaceInfo,
                'org.freedesktop.login1',      // name
                '/org/freedesktop/login1',      // object path
                'org.freedesktop.login1.Manager', // interface name
                this._dbusCancellable, // cancellable
                (source_object, res) => {
                    try {
                        const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                        log("DEBUG: LoginManager proxy created successfully.");
                        this._loginProxy = proxy;

                        // Fix 3: Check if extension was disabled during async proxy creation
                        if (this._isDisabled) return;

                        // Fix 7: Wrap PrepareForSleep D-Bus signal handler in try-catch
                        connect(this._loginProxy, 'g-signal', (p, sender, signal, params) => {
                            try {
                                if (this._isDisabled) return; // Fix 8
                                if (signal === 'PrepareForSleep') {
                                    const starting = params.get_child_value(0).get_boolean();
                                    if (!starting) {
                                        log("DEBUG: System resumed from sleep, re-snapping windows.");
                                        this._safeTimeoutAdd(GLib.PRIORITY_DEFAULT, 1000, () => {
                                            if (this._isDisabled) return GLib.SOURCE_REMOVE; // Fix 8
                                            this._snapExistingWindows();
                                            return GLib.SOURCE_REMOVE;
                                        });
                                    }
                                }
                            } catch (e) {
                                logError(e, 'TabbedTiling: Error in PrepareForSleep handler');
                            }
                        });
                    } catch (e) {
                        // If cancelled, this is expected during disable() - don't log as error
                        if (this._isDisabled || (e.matches && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))) {
                            return;
                        }
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

        const title = (() => { try { return window.get_title(); } catch(e) { return '<unknown>'; } })();
        const wmClass = (() => { try { return window.get_wm_class(); } catch(e) { return '<unknown>'; } })();
        log(`_trackWindowState: Tracking window "${title}" (wmClass=${wmClass})`);

        // The 'actor' is the actual visual object on the screen. This is what we need to watch.
        const actor = window.get_compositor_private();
        if (!actor) {
            log(`_trackWindowState: Cannot track window "${title}" - no compositor private (actor)`);
            return; // Cannot track if there is no actor
        }

        let checkQueued = false; // A flag to prevent the handler from running too many times during a resize.

        const onAllocationChanged = () => {
            // If a check is already scheduled for the next idle moment, don't queue another.
            if (checkQueued) return;
            checkQueued = true;

            // Use GLib.idle_add via safe wrapper. This waits until Mutter has
            // completely finished its current drawing and layout cycle before we run our code.
            this._safeIdleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                checkQueued = false; // Allow the next allocation change to queue a new check.

                try {
                    // Fix 8: Check if disabled
                    if (this._isDisabled) return GLib.SOURCE_REMOVE;

                    // Ensure the window wasn't destroyed while we were waiting.
                    if (!this._isWindowValid(window)) {
                        log(`_trackWindowState: onAllocationChanged - window "${title}" is no longer valid`);
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
                } catch (e) {
                    logError(e, 'TabbedTiling: Error in _trackWindowState idle callback');
                }
                
                return GLib.SOURCE_REMOVE; // This idle task is done.
            });
        };

        // Fix 1: Store {obj, id} pairs so each signal is disconnected from its correct source
        const signals = [
            { obj: actor, id: actor.connect('notify::allocation', onAllocationChanged) },
            { obj: window, id: window.connect('unmanaged', () => {
                log(`_trackWindowState: 'unmanaged' signal fired for window "${title}"`);
                return this._onWindowUnmanaged(window);
            }) }
        ];
        this._windowStateSignals.set(window, signals);
        log(`_trackWindowState: Connected 'unmanaged' signal for window "${title}" (signal id=${signals[1].id})`);
    }

    // Fix 1: Disconnect each signal from its correct source object
    _untrackWindowState(window) {
        const signals = this._windowStateSignals.get(window);
        if (signals) {
            signals.forEach(sig => {
                try { sig.obj.disconnect(sig.id); } catch (e) { /* ignore */ }
            });
            this._windowStateSignals.delete(window);
        }
    }

    // Called when a window is closed/unmanaged. Remove it from its zone and clean up.
    _onWindowUnmanaged(window) {
        try {
            const title = (() => { try { return window.get_title(); } catch(e) { return '<destroyed>'; } })();
            const wmClass = (() => { try { return window.get_wm_class(); } catch(e) { return '<unknown>'; } })();
            log(`_onWindowUnmanaged: Window "${title}" (wmClass=${wmClass}) received 'unmanaged' signal`);
            
            if (!window || this._isDisabled) {
                log(`_onWindowUnmanaged: Skipping - window=${!!window}, _isDisabled=${this._isDisabled}`);
                return;
            }
            
            // Check if window is already invalid
            const isValid = this._isWindowValid(window);
            log(`_onWindowUnmanaged: Window validity check: ${isValid}`);
            
            // Remove from zone before untracking so the tab is removed from the tab bar
            const zone = this._findZoneForWindow(window);
            if (zone) {
                const title = (() => { try { return window.get_title(); } catch(e) { return '<destroyed>'; } })();
                log(`_onWindowUnmanaged: Found zone "${zone.name}" for window "${title}", calling unsnapWindow`);
                log(`_onWindowUnmanaged: Zone has ${zone._snappedWindows.size} snapped windows before unsnap`);
                zone.unsnapWindow(window);
                log(`_onWindowUnmanaged: Zone has ${zone._snappedWindows.size} snapped windows after unsnap`);
            } else {
                log(`_onWindowUnmanaged: WARNING - No zone found for window "${title}" (wmClass=${wmClass})`);
                // Debug: list all zones and their windows
                log(`_onWindowUnmanaged: All zones state:`);
                this._zones.forEach(z => {
                    const tabCount = z._tabBar ? z._tabBar._tabs.size : 0;
                    log(`  - Zone "${z.name}" (monitor=${z.monitorIndex}): ${z._snappedWindows.size} snapped, ${tabCount} tabs`);
                });
            }
        } catch (e) {
            logError(e, 'TabbedTiling: Error in _onWindowUnmanaged');
        }
        // Always disconnect signals and remove from tracking
        this._untrackWindowState(window);
    }

    // Fix 1: Disconnect all tracked window state signals from correct source objects
    _disconnectWindowStateSignals() {
        this._windowStateSignals.forEach((signals, window) => {
            signals.forEach(sig => {
                try { sig.obj.disconnect(sig.id); } catch (e) { /* ignore */ }
            });
        });
        this._windowStateSignals.clear();
    }

    _startDragHoverTimer() {
        if (this._dragHoverTimerId) return;
        // Fix 4: Use PRIORITY_DEFAULT_IDLE and 33ms to prevent main loop saturation
        this._dragHoverTimerId = this._safeTimeoutAdd(GLib.PRIORITY_DEFAULT_IDLE, 33, () => {
            if (this._isDisabled) return GLib.SOURCE_REMOVE; // Fix 8
            this._updateHoverHighlightFromPointer();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopDragHoverTimer() {
        if (this._dragHoverTimerId) {
            try {
                GLib.source_remove(this._dragHoverTimerId);
            } catch (e) { /* already removed */ }
            this._pendingSourceIds?.delete(this._dragHoverTimerId);
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

        // Fix 5: Null monitor check
        if (!monitor) return null;

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
        if (!window) return;
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
        this._safeTimeoutAdd(GLib.PRIORITY_DEFAULT, 200, () => {
            if (this._isDisabled) return GLib.SOURCE_REMOVE; // Fix 8
            if (!window || !this._isSnappable(window)) return GLib.SOURCE_REMOVE;
            this._trackWindowState(window); // Track state changes (maximized, etc.)
            const monitorIndex = window.get_monitor();
            const primaryZone = this._zones.find(z =>
                z.monitorIndex === monitorIndex && z.isPrimary
            );

            if (primaryZone) {
                // Fix 6: Safe window title access
                const title = (() => { try { return window.get_title(); } catch(e) { return '<destroyed>'; } })();
                log(`New window "${title}" snapping to primary zone.`);
                primaryZone.snapWindow(window);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Re-run per monitor when tracked windows list changes (e.g., window closed)
    _onTrackedWindowsChanged() {
        try {
            const currentWindows = new Set(global.get_window_actors().map(a => a.get_meta_window()));
            const previouslyTracked = new Set(this._windowStateSignals.keys());
            log(`_onTrackedWindowsChanged: currentWindows=${currentWindows.size}, previouslyTracked=${previouslyTracked.size}`);

            // Untrack closed windows and remove them from zones
            for (const window of previouslyTracked) {
                if (!currentWindows.has(window)) {
                    const title = (() => { try { return window.get_title(); } catch(e) { return '<destroyed>'; } })();
                    const wmClass = (() => { try { return window.get_wm_class(); } catch(e) { return '<unknown>'; } })();
                    log(`_onTrackedWindowsChanged: Window "${title}" (wmClass=${wmClass}) is no longer in currentWindows`);
                    
                    // Find the zone BEFORE untracking, so we can remove the tab
                    const zone = this._findZoneForWindow(window);
                    if (zone) {
                        log(`_onTrackedWindowsChanged: Found zone "${zone.name}" for window "${title}", calling unsnapWindow`);
                        // Call unsnapWindow regardless of window validity - it handles destroyed windows
                        zone.unsnapWindow(window);
                    } else {
                        log(`_onTrackedWindowsChanged: WARNING - No zone found for window "${title}" (wmClass=${wmClass})`);
                    }
                    
                    try {
                        this._untrackWindowState(window);
                    } catch (e) {
                        logError(e, 'TabbedTiling: Error untracking window state');
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
        } catch (e) {
            logError(e, 'TabbedTiling: Error in _onTrackedWindowsChanged');
        }
    }

    _updateAllZonesVisibility() {
        const allWindows = global.get_window_actors().map(a => a.get_meta_window());
        const monitorsWithMaximizedWindows = new Set();
        allWindows.forEach(win => {
            try {
                if (!win) return;
                if ((win.get_maximized && win.get_maximized()) || (win.is_fullscreen && win.is_fullscreen())) {
                    monitorsWithMaximizedWindows.add(win.get_monitor());
                }
            } catch (e) {
                // Window may have been destroyed, skip it
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
        log(`_snapExistingWindows: Starting, zones=${this._zones.length}`);
        const allWindows = global.get_window_actors().map(a => a.get_meta_window());
        log(`_snapExistingWindows: Found ${allWindows.length} windows`);
        
        let snappedCount = 0;
        allWindows.forEach(window => {
            try {
                const title = (() => { try { return window.get_title(); } catch(e) { return '<unknown>'; } })();
                const wmClass = (() => { try { return window.get_wm_class(); } catch(e) { return '<unknown>'; } })();
                log(`_snapExistingWindows: Processing window "${title}" (wmClass=${wmClass})`);
                
                this._trackWindowState(window);
                
                const isSnappable = this._isSnappable(window);
                log(`_snapExistingWindows: window "${title}" isSnappable=${isSnappable}`);
                
                if (isSnappable) {
                    let targetZone = this._findZoneForWindow(window);
                    log(`_snapExistingWindows: window "${title}" _findZoneForWindow returned ${targetZone ? targetZone.name : 'null'}`);

                    if (!targetZone) {
                        targetZone = this._findBestZoneForWindow(window);
                        log(`_snapExistingWindows: window "${title}" _findBestZoneForWindow returned ${targetZone ? targetZone.name : 'null'}`);
                    }

                    if (targetZone) {
                        log(`_snapExistingWindows: Snapping window "${title}" to zone "${targetZone.name}"`);
                        targetZone.snapWindow(window);
                        snappedCount++;
                    } else {
                        log(`_snapExistingWindows: WARNING - No target zone for window "${title}"`);
                    }
                }
            } catch (e) {
                // Window may have been destroyed, skip it
                logError(e, 'TabbedTiling: Error in _snapExistingWindows');
            }
        });
        
        log(`_snapExistingWindows: Completed, snapped ${snappedCount}/${allWindows.length} windows`);
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
                // Fix 6: Safe window title access
                const windowTitle = (() => { try { return tab.window.get_title() || 'N/A'; } catch(e) { return '<destroyed>'; } })();
                const wmClass = (() => { try { return tab.window.get_wm_class() || 'N/A'; } catch(e) { return '<destroyed>'; } })();
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
        try {
            if (window._tilingZone && window._tilingZone.containsWindow(window)) {
                return window._tilingZone;
            }
        } catch (e) {
            // Zone was destroyed, clear stale reference
            window._tilingZone = null;
        }

        // Fallback: search all zones recursively
        for (const zone of this._zones) {
            const found = zone.findZoneForWindow(window);
            if (found) return found;
        }
        return null;
    }
}
