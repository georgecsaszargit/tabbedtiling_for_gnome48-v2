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
    }

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

    showHoverHighlight(zone) {
        if (!this._hoverHighlight) {
            this._hoverHighlight = this._createHighlightActor('zone-highlight');
        }

        const monitor = Main.layoutManager.monitors[zone.monitorIndex];
        if (!monitor) return;

        this._hoverHighlight.set_position(monitor.x + zone.x, monitor.y + zone.y);
        this._hoverHighlight.set_size(zone.width, zone.height);
        this._hoverHighlight.show();
    }

    hideHoverHighlight() {
        if (this._hoverHighlight) {
            this._hoverHighlight.hide();
        }
    }

    showAllPreviews(zones) {
        this.destroyPreviews(); // Clear any existing previews

        if (this._previewTimeoutId) {
            GLib.Source.remove(this._previewTimeoutId);
        }

        zones.forEach(zone => {
            const monitor = Main.layoutManager.monitors[zone.monitorIndex];
            if (!monitor) return;

            const actor = this._createHighlightActor('zone-highlight');
            actor.set_position(monitor.x + zone.x, monitor.y + zone.y);
            actor.set_size(zone.width, zone.height);
            actor.show();
            this._previewHighlights.push(actor);
        });

        // Previews automatically hide after a timeout
        this._previewTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_TIMEOUT_MS, () => {
            this.destroyPreviews();
            this._previewTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    destroyPreviews() {
        this._previewHighlights.forEach(actor => actor.destroy());
        this._previewHighlights = [];
    }

    destroy() {
        if (this._hoverHighlight) {
            this._hoverHighlight.destroy();
            this._hoverHighlight = null;
        }
        this.destroyPreviews();
    }
}
