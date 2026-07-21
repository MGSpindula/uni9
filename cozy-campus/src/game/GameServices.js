import { EntityRegistry } from "../core/EntityRegistry";
import { SelectionManager } from "../core/SelectionManager";
import { InteractionSystem } from "../core/InteractionSystem";
import { NavigationGraph } from "../navigation/NavigationGraph";
import { NavigationConnector } from "../navigation/NavigationConnector";
import { NavigationGraphHelper } from "../navigation/NavigationGraphHelper";
import { CharacterNavigationSystem } from "../navigation/CharacterNavigationSystem";

export class GameServices {
    constructor({ camera, element, onChanged }) {
        this.registry = new EntityRegistry();
        this.interactions = new InteractionSystem();
        this.selection = new SelectionManager(camera, this.registry, element, { onChanged });
        this.onChanged = onChanged;
    }
    createNavigation(configure) {
        this.navigationGraph = new NavigationGraph({ selectionRadius: 1.25 });
        configure(this.navigationGraph);
        this.navigationConnector = new NavigationConnector(this.navigationGraph);
        this.characterNavigation = new CharacterNavigationSystem({
            graph: this.navigationGraph,
            connector: this.navigationConnector,
            helper: null,
            onChanged: this.onChanged
        });
        this.navigationHelper = new NavigationGraphHelper(this.navigationGraph, {
            connector: this.navigationConnector,
            trafficState: this.characterNavigation.trafficState,
            routeGeometry: this.characterNavigation.routeGeometry
        });
        // Interaction points are authored after the graph in most levels.
        // Rebuild the debug drawing whenever action/approach points change.
        this.navigationConnector.onPointsChanged = () => {
            this.navigationHelper?.refresh();
            this.onChanged?.();
        };
        this.characterNavigation.helper = this.navigationHelper;
        return this.navigationHelper;
    }
    disposeNavigation() {
        this.characterNavigation?.dispose();
        this.navigationHelper?.dispose();
        if (this.navigationConnector) {
            this.navigationConnector.onPointsChanged = null;
        }
        this.characterNavigation = null;
        this.navigationHelper = null;
        this.navigationConnector = null;
        this.navigationGraph = null;
    }
    dispose() {
        this.disposeNavigation();
        this.selection.dispose();
        this.interactions.dispose();
        this.registry.clear();
    }
}
