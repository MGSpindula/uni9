export const EntityState = Object.freeze({

    IDLE: "idle",

    WALKING: "walking",

    WAITING: "waiting",

    // Reached a destination but is still occupying the graph center.
    STOPPING: "stopping",

    // Moved to an idle spot and is no longer obstructing circulation.
    DWELLING: "dwelling",

    HOVERED: "hovered",

    SELECTED: "selected",

    COOLDOWN: "cooldown",

    DISABLED: "disabled",

    DESTROYED: "destroyed"

});
