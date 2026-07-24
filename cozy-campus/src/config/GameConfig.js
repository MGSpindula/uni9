function deepFreeze(value) {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
        return value
    }

    for (const child of Object.values(value)) {
        deepFreeze(child)
    }

    return Object.freeze(value)
}

const DEVELOPMENT = import.meta.env.DEV

export const GAME_CONFIG = deepFreeze({
    app: {
        mountSelector: "#app",
    },

    debug: {
        enabled: DEVELOPMENT,
        visible: DEVELOPMENT,
        exposeGlobal: DEVELOPMENT,

        navigationVisible: DEVELOPMENT,
        performanceVisible: DEVELOPMENT,
        characterVisible: DEVELOPMENT,

        performanceMode: "compact",
        performanceRefreshInterval: 500,

        measurePerformance: DEVELOPMENT,
    },

    loop: {
        maxDelta: 1 / 15,
        pauseWhenHidden: true,
    },

    render: {
        qualityPreset: "high",

        clearColor: 0xe9e3d8,
        clearAlpha: 1,

        powerPreference: "high-performance",

        camera: {
            fieldOfView: 60,
            near: 0.1,
            far: 150,

            position: {
                x: 0,
                y: 6,
                z: 12,
            },

            target: {
                x: 0,
                y: 0,
                z: 0,
            },
        },

        qualityPresets: {
            low: {
                pixelRatio: 1,
                shadows: false,
                multisampling: 0,
            },

            medium: {
                pixelRatio: 1.25,
                shadows: true,
                multisampling: 2,
            },

            high: {
                pixelRatio: 1.5,
                shadows: true,
                multisampling: 4,
            },
        },
    },

    navigation: {
        projectionHalfExtents: {
            x: 1.5,
            y: 3,
            z: 1.5,
        },

        crowd: {
            maxAgentRadius: 0.75,
            fixedTimeStep: 1 / 60,
            maxSubSteps: 2,
            maxAccumulatedTime: 1 / 10,
        },

        defaultAgent: {
            radius: 0.42,
            height: 1.8,
            maxSpeed: 2.2,
            maxAcceleration: 8,
        },
    },
})
