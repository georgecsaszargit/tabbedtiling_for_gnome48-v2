# Profile System Design for Tabbed Tiling

## Overview
Add profile support so users can save different zone configurations and switch between them via the GNOME system tray.

## Requirements
- Profiles store **zone configurations only** (not tab bar settings)
- System tray icon provides **quick profile switching**
- Profile management (create, rename, delete) via **settings UI**
- Use **files** not dconf for storage
- All files stored in `~/.config/tabbedtiling/`

## File Structure

```
~/.config/tabbedtiling/
├── config.json              # Global settings (tabBar, exclusions, zoneGenerator defaults)
├── preview.json             # Preview zones for zone generator
├── profiles.json            # Profile metadata (list of profiles, active profile)
└── profiles/
    ├── Default/
    │   └── zones.json      # Zone config for "Default" profile
    ├── Work/
    │   └── zones.json      # Zone config for "Work" profile
    └── ...
```

### profiles.json Format
```json
{
  "activeProfile": "Default",
  "profiles": [
    { "name": "Default", "createdAt": "2024-01-01T00:00:00Z" },
    { "name": "Work", "createdAt": "2024-01-02T00:00:00Z" }
  ]
}
```

### Per-profile config.json Format
Same as current `config.json` zones structure:
```json
{
  "zones": [
    { "monitorIndex": 0, "x": 0, "y": 0, "width": 960, "height": 1080, "gap": 0, "isPrimary": true },
    { "monitorIndex": 0, "x": 960, "y": 0, "width": 960, "height": 1080, "gap": 0, "isPrimary": false }
  ]
}
```

## Module Design

### 1. ProfileManager (modules/ProfileManager.js)
**Responsibilities:**
- CRUD operations for profiles
- Load/save profiles.json
- Load/save individual profile configs
- Get and set active profile
- Export/import profile configurations

**Key Methods:**
- `getProfiles()` - returns list of all profiles
- `getActiveProfile()` - returns active profile name
- `setActiveProfile(name)` - sets active profile
- `createProfile(name)` - creates new profile with empty zones
- `deleteProfile(name)` - deletes a profile
- `renameProfile(oldName, newName)` - renames a profile
- `loadProfileConfig(name)` - loads zone config for a profile
- `saveProfileConfig(name, zones)` - saves zone config for a profile
- `duplicateProfile(sourceName, newName)` - copies a profile

### 2. SystemTray (modules/SystemTray.js)
**Responsibilities:**
- Create GNOME status indicator icon
- Build menu with profile list and switching
- Show current active profile with checkmark
- Handle profile switch events

**Key Methods:**
- `enable()` - create status indicator and menu
- `disable()` - remove status indicator
- `_buildMenu()` - rebuild the profile menu
- `_onProfileSelected(name)` - handle profile switch

**Menu Structure:**
```
[Icon]
└── Profile: <active profile name>
├── ✓ Default
├──   Work
├──   Gaming
├── ─────────────
├── Settings...
└── Quit
```

## Integration Changes

### extension.js
- Import and instantiate ProfileManager
- Import and instantiate SystemTray
- On enable: start SystemTray
- On disable: stop SystemTray
- SystemTray emits signal when profile changes → WindowManager.reloadConfiguration()

### WindowManager
- Accept ProfileManager reference
- When `reloadConfiguration()` is called, use ProfileManager to get zones for active profile

### ConfigManager
- Keep as-is for global settings
- Profile-specific zones handled by ProfileManager

### prefs.js
Add new "Profiles" section:
- List of profiles with rename/delete buttons
- Create new profile button
- Import/export profile buttons
- Active profile selector

## Implementation Order

1. Create `modules/ProfileManager.js`
2. Create `modules/SystemTray.js`
3. Update `extension.js` to integrate ProfileManager and SystemTray
4. Update `WindowManager` to use ProfileManager
5. Add profile management UI to `prefs.js`

## GNOME Shell API Notes

For system tray in GNOME Shell 48, use:
- `PanelMenuSystemButton` or `StatusSystemButton` from gschema
- Or use `imports.ui.panel` and create a status indicator

Alternative approach using `StatusIcon`:
```javascript
import StatusIcon from 'gi://StatusIcon';
```

For menu, use `PopupMenu`:
```javascript
imports.ui.popupMenu.PopupMenu;
```
