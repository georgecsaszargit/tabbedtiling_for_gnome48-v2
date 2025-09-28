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
        this._loginProxy = null;
    }

    enable() {
        log("DEBUG: enable() called.");
        this.reloadConfiguration();
        this._connectSignals();
        this._snapExistingWindows();
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
    }

    _isSnappable(window) {
        if (!window || window.is_fullscreen()) return false;
        const type = window.get_window_type();
        return type === Meta.WindowType.NORMAL;
    }

    _onGrabOpBegin(display, window, op) {
        if (!this._isSnappable(window)) return;
        const currentZone = this._findZoneForWindow(window);

        const [, , mods] = global.get_pointer();
        if ((mods & Clutter.ModifierType.CONTROL_MASK) !== 0) {
            window._tilingBypass = true;
            return;
        }
        delete window._tilingBypass;

        if (currentZone) {
            window.raise();
            window._tilingOriginalZone = currentZone;
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
        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (!monitor) return null;

        let best = { zone: null, dist: Infinity };
        for (const zone of this._zones) {
            if (zone.monitorIndex !== monitorIndex) continue;
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

        this._highlighter.hideHoverHighlight();

        const [pointerX, pointerY] = global.get_pointer();
        // 1) Try direct hit
        let targetZone = this._findZoneAt(pointerX, pointerY);

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

    _onTrackedWindowsChanged() {
        const trackedWindows = new Set(global.get_window_actors().map(a => a.get_meta_window()));

        for (const zone of this._zones) {
            const snappedWindows = zone.getSnappedWindows();
            for (const window of snappedWindows) {
                if (!trackedWindows.has(window)) {
                    log(`Window "${window.get_title()}" is no longer tracked, removing from zone "${zone.name}".`);
                    zone.unsnapWindow(window);
                }
            }
        }
    }

    _snapExistingWindows() {
        log("DEBUG: _snapExistingWindows() called.");
        const allWindows = global.get_window_actors().map(a => a.get_meta_window());
        allWindows.forEach(window => {
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
        this._zones.forEach(zone => zone.reorderTabs());
        this._logZoneStates();
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
        return this._findZoneAt(centerX, centerY);
    }

    _findZoneAt(x, y) {
        const monitorIndex = global.display.get_monitor_index_for_rect(
            new Mtk.Rectangle({ x, y, width: 1, height: 1 })
        );
        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (!monitor) return null;

        for (const zone of this._zones) {
            if (zone.monitorIndex !== monitorIndex) continue;

            const zoneRect = {
                x: monitor.x + zone.x,
                y: monitor.y + zone.y,
                width: zone.width,
                height: zone.height,
            };

            if (x >= zoneRect.x && x <= zoneRect.x + zoneRect.width &&
                y >= zoneRect.y && y <= zoneRect.y + zoneRect.height) {
                return zone;
            }
        }
        return null;
    }

    _findZoneForWindow(window) {
        return this._zones.find(zone => zone.containsWindow(window));
    }
}
