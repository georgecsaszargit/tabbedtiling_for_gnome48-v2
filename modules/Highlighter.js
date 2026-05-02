// modules/Highlighter.js
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

const PREVIEW_TIMEOUT_MS = 5000; // 5 seconds

export class Highlighter {
    constructor() {
        this._hoverHighlight = null;
        this._previewHighlights = [];
        this._previewTimeoutId = 0;
        this._destroyed = false;
        this._persistentActors = new Set();
    }

    /**
     * Create a highlight actor in the chrome layer (above all windows).
     * Used for drag-hover highlights that should be visible above everything.
     */
    _createHighlightActor(styleClass) {
        const actor = new St.Bin({
            style_class: styleClass,
            reactive: false,
            can_focus: false,
            x_expand: true,
            y_expand: true,
        });
        Main.layoutManager.addChrome(actor, { affectsStruts: false });
        actor.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        return actor;
    }

    /**
     * Create a highlight actor for persistent live-edit previews.
     * Added directly to uiGroup (NOT via addChrome) so it's visible but
     * does NOT participate in input tracking — clicks pass through to windows below.
     * Reduced opacity so the prefs window remains readable underneath.
     */
    _createPersistentHighlightActor(styleClass) {
        const actor = new St.Bin({
            style_class: styleClass,
            reactive: false,
            can_focus: false,
            x_expand: false,
            y_expand: false,
            opacity: 80, // ~30% opacity (0-255 scale) so prefs window is readable
        });
        // Add directly to uiGroup without chrome tracking.
        // This keeps the actor visible but fully input-transparent.
        Main.layoutManager.uiGroup.add_child(actor);
        this._persistentActors.add(actor);
        actor.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        return actor;
    }

    showHoverHighlight(rect) {
        try {
            if (!this._hoverHighlight) {
                this._hoverHighlight = this._createHighlightActor('zone-highlight');
            }

            const monitor = Main.layoutManager.monitors[rect.monitorIndex];
            if (!monitor) return;

            this._hoverHighlight.set_position(monitor.x + rect.x, monitor.y + rect.y);
            this._hoverHighlight.set_size(rect.width, rect.height);
            this._hoverHighlight.show();
        } catch (e) {
            logError(e, 'TabbedTiling: Error in Highlighter.showHoverHighlight');
        }
    }

    hideHoverHighlight() {
        if (this._destroyed) return;
        try {
            if (this._hoverHighlight) {
                this._hoverHighlight.hide();
            }
        } catch (e) {
            logError(e, 'TabbedTiling: Error in Highlighter.hideHoverHighlight');
        }
    }

    updateHoverHighlight(rect) {
        try {
            this.showHoverHighlight(rect);
        } catch (e) {
            logError(e, 'TabbedTiling: Error in Highlighter.updateHoverHighlight');
        }
    }

    /**
     * Show preview overlays for the given zones.
     * @param {Array} zones - Zone data objects with monitorIndex, x, y, width, height
     * @param {boolean} persistent - If true, overlays are placed BELOW windows (non-blocking)
     *                               and stay visible until explicitly cleared (no auto-hide timeout)
     */
    showAllPreviews(zones, persistent = false) {
        try {
            this.destroyPreviews(); // Clear any existing previews

            if (this._previewTimeoutId) {
                GLib.source_remove(this._previewTimeoutId);
                this._previewTimeoutId = 0;
            }

            zones.forEach(zone => {
                if (!zone || !zone.monitor && zone.monitorIndex === undefined) return;

                const monitor = Main.layoutManager.monitors[zone.monitorIndex];
                if (!monitor) return;

                // Persistent previews use reduced opacity; non-persistent use full opacity
                const actor = persistent
                    ? this._createPersistentHighlightActor('zone-highlight')
                    : this._createHighlightActor('zone-highlight');
                actor.set_position(monitor.x + zone.x, monitor.y + zone.y);
                actor.set_size(zone.width, zone.height);
                actor.show();
                this._previewHighlights.push(actor);
            });

            // Only auto-hide if not persistent
            if (!persistent) {
                this._previewTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_TIMEOUT_MS, () => {
                    this.destroyPreviews();
                    this._previewTimeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                });
            }
        } catch (e) {
            logError(e, 'TabbedTiling: Error in Highlighter.showAllPreviews');
        }
    }

    destroyPreviews() {
        try {
            this._previewHighlights.forEach(actor => {
                try {
                    if (this._persistentActors.has(actor)) {
                        const parent = actor.get_parent?.();
                        if (parent) parent.remove_child(actor);
                        this._persistentActors.delete(actor);
                    } else {
                        Main.layoutManager.removeChrome(actor);
                    }
                } catch (e) {
                    // Ignore - best effort removal
                }
                try {
                    actor.destroy();
                } catch (e) {
                    // Actor may already be destroyed
                }
            });
            this._previewHighlights = [];
            if (this._previewTimeoutId) {
                try { GLib.source_remove(this._previewTimeoutId); } catch (e) { }
                this._previewTimeoutId = 0;
            }
        } catch (e) {
            logError(e, 'TabbedTiling: Error in Highlighter.destroyPreviews');
        }
    }

    destroy() {
        try {
            if (this._destroyed) return;
            this._destroyed = true;

            if (this._previewTimeoutId) {
                GLib.source_remove(this._previewTimeoutId);
                this._previewTimeoutId = 0;
            }

            if (this._hoverHighlight) {
                try {
                    Main.layoutManager.removeChrome(this._hoverHighlight);
                } catch (e) { /* ignore */ }
                try {
                    this._hoverHighlight.destroy();
                } catch (e) { /* ignore */ }
                this._hoverHighlight = null;
            }

            this.destroyPreviews();
        } catch (e) {
            logError(e, 'TabbedTiling: Error in Highlighter.destroy');
        }
    }
}
