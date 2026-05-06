import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {loadConfig} from './prefs/ConfigIO.js';
import {buildProfilesPage} from './prefs/ProfilesPage.js';
import {buildAppearancePage} from './prefs/AppearancePage.js';
import {buildBehaviorPage} from './prefs/BehaviorPage.js';
import {buildAboutPage} from './prefs/AboutPage.js';

// ---------------------------------------------------------------------------
// Scoped CSS for the prefs window
// ---------------------------------------------------------------------------
//
// All rules are scoped under the `.tt-prefs` class (added to the prefs
// window root) so that these styles do NOT leak into other GTK apps or the
// wider shell. Colors are explicit so the appearance is consistent between
// light and dark system themes.
//
// Card / row background:   white (#ffffff)
// Expanded nested content: darker gray (#e8e8e8)
// Text color:              near-black (#1a1a1a) with softer dim/subtitle
// ---------------------------------------------------------------------------

const TT_PREFS_CSS = `
/* --- Outer "card" containers (AdwPreferencesGroup's boxed-list) --- */
.tt-prefs .boxed-list,
.tt-prefs list.boxed-list,
.tt-prefs listview.boxed-list {
    background-color: #ffffff;
    color: #1a1a1a;
    border: 1px solid rgba(0, 0, 0, 0.12);
}

/* --- All rows inside boxed lists (ActionRow, ComboRow, SpinRow,
       SwitchRow, EntryRow, ExpanderRow header, etc.) --- */
.tt-prefs .boxed-list row,
.tt-prefs .boxed-list > row,
.tt-prefs row.activatable,
.tt-prefs row.header,
.tt-prefs row.entry,
.tt-prefs row.combo,
.tt-prefs row.spin,
.tt-prefs row.action,
.tt-prefs row.expander,
.tt-prefs row.expander > box,
.tt-prefs .card {
    background-color: #ffffff;
    color: #1a1a1a;
}

/* --- Readable text colors regardless of system theme --- */
.tt-prefs .boxed-list row label,
.tt-prefs .boxed-list row .title {
    color: #1a1a1a;
}
.tt-prefs .boxed-list row .subtitle,
.tt-prefs .boxed-list row .dim-label,
.tt-prefs .boxed-list row label.dim-label {
    color: rgba(0, 0, 0, 0.55);
}

/* --- Hover / active feedback on white rows (subtle) --- */
.tt-prefs .boxed-list row.activatable:hover {
    background-color: rgba(0, 0, 0, 0.04);
}
.tt-prefs .boxed-list row.activatable:active,
.tt-prefs .boxed-list row.activatable:selected {
    background-color: rgba(0, 0, 0, 0.06);
    color: #1a1a1a;
}

/* --- AdwExpanderRow: darker background for the nested/expanded area --- */
/*     Adwaita marks the inner list with .nested — we also match any      */
/*     list or preferences group placed inside an expander row as a       */
/*     safety net for custom expandable rows.                             */
.tt-prefs row.expander list.nested,
.tt-prefs row.expander > list,
.tt-prefs row.expander .nested,
.tt-prefs row.expander .expander-row-content,
.tt-prefs row.expander preferencesgroup,
.tt-prefs row.expander preferencesgroup listview,
.tt-prefs row.expander preferencesgroup list {
    background-color: #e8e8e8;
}

/* Rows inside the nested/expanded area inherit the darker background */
.tt-prefs row.expander list.nested > row,
.tt-prefs row.expander list.nested row,
.tt-prefs row.expander > list > row,
.tt-prefs row.expander > list row,
.tt-prefs row.expander .nested row {
    background-color: #e8e8e8;
    color: #1a1a1a;
}

/* Hover state inside the darker nested area: slightly darker still */
.tt-prefs row.expander list.nested row.activatable:hover,
.tt-prefs row.expander > list row.activatable:hover,
.tt-prefs row.expander .nested row.activatable:hover {
    background-color: rgba(0, 0, 0, 0.08);
}
`;

// Install the CSS provider exactly once per display.
let _ttPrefsCssInstalled = false;
function _installPrefsCss() {
    if (_ttPrefsCssInstalled) return;
    const display = Gdk.Display.get_default();
    if (!display) return;

    const provider = new Gtk.CssProvider();
    provider.load_from_string(TT_PREFS_CSS);
    Gtk.StyleContext.add_provider_for_display(
        display,
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    );
    _ttPrefsCssInstalled = true;
}

export default class TabbedTilingPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Configure window
        window.set_default_size(750, 820);
        window.set_search_enabled(true);

        // Install the scoped CSS provider and tag this window so rules
        // apply ONLY to our preferences window.
        _installPrefsCss();
        window.add_css_class('tt-prefs');

        // GSettings for keybindings/behavior
        const settings = this.getSettings();

        // Load config ONCE and share across all pages to prevent
        // concurrent copies from overwriting each other's changes.
        const config = loadConfig();

        // Build and add pages in tab order.
        // Adw.PreferencesWindow supports add_toast() directly, so pass
        // the window itself wherever page builders need a toast overlay.
        window.add(buildProfilesPage(window, window, config));
        window.add(buildAppearancePage(window, window, config));
        window.add(buildBehaviorPage(window, window, settings, config));
        window.add(buildAboutPage(window, window));
    }
}
