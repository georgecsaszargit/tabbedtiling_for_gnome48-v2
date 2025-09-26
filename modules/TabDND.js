// modules/TabDND.js
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DRAG_THRESHOLD = 10;
const HOLD_TIMEOUT_MS = 250;

const log = msg => console.log(`[TabbedTiling.TabDND] ${msg}`);

let globalDragState = null;

export class TabDND {
    constructor(tabBar, windowManager) {
        this._tabBar = tabBar;
        this._windowManager = windowManager;
    }

    initPointerHandlers(tabActor) {
        tabActor._pressState = { pressTimeoutId: 0, details: null, dragStarted: false };

        tabActor.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;

            if (actor._pressState.pressTimeoutId) GLib.Source.remove(actor._pressState.pressTimeoutId);

            const [pressX, pressY] = event.get_coords();
            actor._pressState.details = { time: event.get_time(), x: pressX, y: pressY };
            actor._pressState.dragStarted = false;

            actor._pressState.pressTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_TIMEOUT_MS, () => {
                actor._pressState.pressTimeoutId = 0;
                if (actor._pressState.details) this._beginDrag(actor);
                return GLib.SOURCE_REMOVE;
            });

            return Clutter.EVENT_STOP;
        });

        tabActor.connect('motion-event', (actor, event) => {
            if (!actor.has_pointer || !actor._pressState.details || globalDragState) return Clutter.EVENT_PROPAGATE;
            
            const [currentX, currentY] = event.get_coords();
            const { x: startX, y: startY } = actor._pressState.details;
            if (Math.abs(currentX - startX) > DRAG_THRESHOLD || Math.abs(currentY - startY) > DRAG_THRESHOLD) {
                if (actor._pressState.pressTimeoutId) {
                    GLib.Source.remove(actor._pressState.pressTimeoutId);
                    actor._pressState.pressTimeoutId = 0;
                }
                this._beginDrag(actor);
            }
            return Clutter.EVENT_PROPAGATE;
        });

        tabActor.connect('button-release-event', (actor, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;

            if (actor._pressState.pressTimeoutId) {
                GLib.Source.remove(actor._pressState.pressTimeoutId);
                actor._pressState.pressTimeoutId = 0;
            }
            
            // Only fire a click if a drag never actually started.
            if (actor._pressState.details && !actor._pressState.dragStarted) {
                this._tabBar.emit('tab-clicked', actor._tabWindow);
            }

            // The global handler will reset dragStarted after cleanup.
            actor._pressState.details = null;
            return Clutter.EVENT_STOP;
        });
    }

    _beginDrag(startTabActor) {
        if (globalDragState) return;
        
        log(`[Drag Begin] Drag initiated for tab "${startTabActor.get_children()[0].get_children()[1].get_text()}" in Zone "${this._tabBar.zone.name}".`);
        startTabActor._pressState.dragStarted = true;
        
        const sourceTabBar = this._tabBar;
        const draggedTabs = sourceTabBar._getGroupedTabs(startTabActor);
        const draggedWindows = draggedTabs.map(t => t._tabWindow);
        
        const clone = new St.BoxLayout({ style_class: 'zone-tab-drag-clone' });
        if (draggedTabs.length > 1) log(`           ...this is a group drag with ${draggedTabs.length} tabs.`);
        let totalWidth = 0;
        draggedTabs.forEach((tab, i) => {
            const bin = new St.Bin({ child: new Clutter.Clone({ source: tab }) });
            clone.add_child(bin);
            totalWidth += tab.get_width();
            if (i < draggedTabs.length - 1) totalWidth += sourceTabBar._tabContainer.layout_manager.spacing;
        });
        
        const [stageX, stageY] = startTabActor.get_transformed_position();
        const [pointerX, pointerY] = global.get_pointer();
        
        Main.uiGroup.add_child(clone);
        clone.set_position(stageX, stageY);

        const placeholder = new St.Bin({
            style_class: 'zone-tab-drag-slot',
            width: totalWidth
        });

        globalDragState = {
            sourceTabBar,
            draggedTabs,
            draggedWindows,
            clone,
            placeholder,
            grabOffsetX: pointerX - stageX,
            grabOffsetY: pointerY - stageY,
            motionId: global.stage.connect('motion-event', this._onDragMotion.bind(this)),
            releaseId: global.stage.connect('button-release-event', this._onDragRelease.bind(this)),
        };

        draggedTabs.forEach(t => t.hide());
    }

    _onDragMotion(stage, event) {
        if (!globalDragState) return Clutter.EVENT_PROPAGATE;
        
        const [pointerX, pointerY] = event.get_coords();
        globalDragState.clone.set_position(
            pointerX - globalDragState.grabOffsetX,
            pointerY - globalDragState.grabOffsetY
        );

        const targetTabBar = this._findTargetTabBar(pointerX, pointerY);
        log(`[Drag Motion] Pointer at (${pointerX}, ${pointerY}). Target TabBar: ${targetTabBar ? targetTabBar.zone.name : 'None'}`);
        this._updatePlaceholder(targetTabBar, pointerX);

        return Clutter.EVENT_STOP;
    }

    _onDragRelease(stage, event) {
        if (!globalDragState || event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;

        global.stage.disconnect(globalDragState.motionId);
        global.stage.disconnect(globalDragState.releaseId);
        log(`[Drag Release] Drop detected.`);

        const { sourceTabBar, draggedWindows, draggedTabs, placeholder, clone } = globalDragState;
        const targetTabBarContainer = placeholder.get_parent();
        
        const targetZone = this._windowManager._zones.find(z => z._tabBar._tabContainer === targetTabBarContainer);
        const targetTabBar = targetZone ? targetZone._tabBar : null;

        if (targetTabBar) {
            const container = targetTabBar._tabContainer;
            const children = container.get_children();
            let dropIndex = children.indexOf(placeholder);
            
            container.remove_child(placeholder);

            if (sourceTabBar === targetTabBar) {
                log(`           ...Action: Reordering tabs in Zone "${targetTabBar.zone.name}".`);

                // The list of tabs that were NOT being dragged.
                const stationaryTabs = container.get_children().filter(c => !draggedTabs.includes(c));

                // The dropIndex was calculated relative to the list of visible (i.e., stationary) tabs.
                // So, we can construct the final order by splicing the dragged tabs into the stationary ones.
                const finalTabOrder = [...stationaryTabs];
                finalTabOrder.splice(dropIndex, 0, ...draggedTabs);

                log(`           ...Final tab order determined. Re-parenting ${finalTabOrder.length} tabs.`);

                // By adding them one by one, they will be placed correctly at the end of the container list.
                // Re-parent all tabs according to the new, correct order by first removing them all
                // and then adding them back in the final desired order.
                container.remove_all_children();                
                finalTabOrder.forEach(tab => {
                    // Since we removed all children, every tab can now be safely added back.
                    container.add_child(tab); 
                    if (draggedTabs.includes(tab)) {
                        tab.show();
                        tab.set_position(0, 0);
                    }
                });
            } else {
                // Move to a different zone. The original draggedTabs will be destroyed.
                log(`           ...Action: Moving tabs from Zone "${sourceTabBar.zone.name}" to Zone "${targetTabBar.zone.name}" at index ${dropIndex}.`);
                this._windowManager.moveWindowsToZone(draggedWindows, sourceTabBar.zone, targetTabBar.zone, dropIndex);
            }
        } else {
            // Dropped outside any valid tab bar, so cancel the drag by returning tabs to their original state.
            log(`           ...No valid target found. Cancelling drag.`);
            draggedTabs.forEach(t => t.show());
        }
        
        // Cleanup
        placeholder.destroy();
        Main.uiGroup.remove_child(clone);
        clone.destroy();
        globalDragState = null;

        // CRITICAL FIX for race condition:
        // Disarm the press state of the dropped tabs so their own button-release-event
        // handler doesn't mistakenly start a new drag.
        draggedTabs.forEach(actor => {
            if (actor && actor._pressState) {
                actor._pressState.details = null;
                actor._pressState.dragStarted = false;
            }
        });

        log(`           ...Finalizing styles and layout.`);
        // Update styles and sizes for all affected tab bars
        sourceTabBar._updateGroupStyles();
        sourceTabBar._updateTabSizes();
        if (targetTabBar && targetTabBar !== sourceTabBar) {
            targetTabBar._updateGroupStyles();
            targetTabBar._updateTabSizes();
        }

        return Clutter.EVENT_STOP;
    }

    _findTargetTabBar(x, y) {
        for (const zone of this._windowManager._zones) {
            const tabBar = zone._tabBar;
            if (!tabBar.visible) continue;
            const [barX, barY] = tabBar.get_transformed_position();
            const alloc = tabBar.get_allocation_box();
            if (x >= barX && x <= barX + alloc.get_width() && y >= barY && y <= barY + alloc.get_height()) {
                return tabBar;
            }
        }
        return null;
    }

    _updatePlaceholder(targetTabBar, pointerX) {
        const { placeholder } = globalDragState;
        const currentParent = placeholder.get_parent();
        const newParent = targetTabBar ? targetTabBar._tabContainer : null;

        if (currentParent !== newParent) {
            if (currentParent) currentParent.remove_child(placeholder);
            if (newParent) newParent.add_child(placeholder);
        }

        if (newParent) {
            const children = newParent.get_children().filter(c => c !== placeholder && c.visible);
            const [barX, ] = newParent.get_transformed_position();
            const pointerInBar = pointerX - barX;

            // Correctly find the first "gap" where the pointer is located.
            // Default to the very end of the tab bar.
            let dropIndex = children.length;
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                const childMidPoint = child.get_allocation_box().x1 + child.get_width() / 2;
                if (pointerInBar < childMidPoint) {
                    dropIndex = i;
                    break; // Found the insertion point, stop checking.
                }
            }

            // Group integrity checks
            const draggedId = globalDragState.draggedTabs[0].getGroupingId();
            const prevTab = children[dropIndex - 1];
            const nextTab = children[dropIndex];

            // Don't allow dropping into the middle of another group
            if (prevTab && nextTab && prevTab.getGroupingId() === nextTab.getGroupingId() && draggedId !== prevTab.getGroupingId()) {
                if (currentParent) currentParent.remove_child(placeholder);
                return;
            }

            // Don't allow splitting your own group (only relevant in source tab bar)
            if (targetTabBar === globalDragState.sourceTabBar) {
                const isPartOfDraggedGroup = (tab) => globalDragState.draggedTabs.includes(tab);
                if ((prevTab && !isPartOfDraggedGroup(prevTab) && nextTab && isPartOfDraggedGroup(nextTab)) ||
                    (prevTab && isPartOfDraggedGroup(prevTab) && nextTab && !isPartOfDraggedGroup(nextTab))) 
                {
                     // At a group boundary, this is fine
                } else if (prevTab && nextTab && !isPartOfDraggedGroup(prevTab) && !isPartOfDraggedGroup(nextTab)) {
                    // This is also fine (dropping between other tabs)
                } else if (prevTab || nextTab) {
                    // This is complex, but for now we allow it. A more robust check might be needed
                    // if edge cases appear (e.g. dropping at the start/end of the bar next to a non-group tab)
                }
            }

            if (newParent.get_children().indexOf(placeholder) !== dropIndex) {
                newParent.set_child_at_index(placeholder, dropIndex);
                newParent.queue_relayout();
            }
        }
    }

    destroy() {
        if (globalDragState) {
            // Force cleanup if a drag is somehow stuck
            global.stage.disconnect(globalDragState.motionId);
            global.stage.disconnect(globalDragState.releaseId);
            globalDragState.draggedTabs.forEach(t => t.show());
            if (globalDragState.placeholder.get_parent()) globalDragState.placeholder.get_parent().remove_child(globalDragState.placeholder);
            globalDragState.placeholder.destroy();
            Main.uiGroup.remove_child(globalDragState.clone);
            globalDragState.clone.destroy();
            globalDragState = null;
        }
    }
}
