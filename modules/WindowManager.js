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
        connect(Main.layoutManager, 'monitors-changed', () => this.reloadConfiguration());

        // Manually create a proxy for LoginManager to handle suspend/resume.
        // This is more robust than using makeProxyWrapper, which was failing.
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
                                // This signal is emitted twice: once before sleep (starting=true)
                                // and once on wakeup (starting=false). We act on wakeup.
                                if (!starting) {
                                    log("DEBUG: System resumed from sleep, re-snapping windows.");
                                    // Use a timeout to ensure the session is fully awake
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

        const [, , mods] = global.get_pointer();
        if ((mods & Clutter.ModifierType.CONTROL_MASK) !== 0) {
            window._tilingBypass = true;
            return;
        }
        delete window._tilingBypass;

        const currentZone = this._findZoneForWindow(window);
        if (currentZone) {
            currentZone.unsnapWindow(window);
        }
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
        const targetZone = this._findZoneAt(pointerX, pointerY);

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

    _snapExistingWindows() {
        log("DEBUG: _snapExistingWindows() called.");
        const allWindows = global.get_window_actors().map(a => a.get_meta_window());
        allWindows.forEach(win => {
            if (this._isSnappable(win)) {
                const currentZone = this._findZoneForWindow(win);
                if (currentZone) {
                    currentZone.snapWindow(win);
                }
            }
        });
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
