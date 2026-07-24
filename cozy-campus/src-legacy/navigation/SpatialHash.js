// Uniform XZ grid for broad-phase proximity queries. It stores references but
// owns no collision policy; CharacterCollisionFailsafe remains responsible for
// vertical overlap, prediction, lane exceptions and yielding.
export class SpatialHash {

    constructor(cellSize = 2) {

        this.cellSize = cellSize;
        this.cells = new Map();

    }

    rebuild(items, getPosition = item => item.object3D.position) {

        this.cells.clear();

        for (const item of items) {

            const position = getPosition(item);
            const key = this.getKey(position.x, position.z);
            const cell = this.cells.get(key) ?? [];

            cell.push(item);
            this.cells.set(key, cell);

        }

    }

    queryRadius(position, radius, result = []) {

        result.length = 0;

        const minimumX = Math.floor((position.x - radius) / this.cellSize);
        const maximumX = Math.floor((position.x + radius) / this.cellSize);
        const minimumZ = Math.floor((position.z - radius) / this.cellSize);
        const maximumZ = Math.floor((position.z + radius) / this.cellSize);

        for (let x = minimumX; x <= maximumX; x++) {
            for (let z = minimumZ; z <= maximumZ; z++) {

                const cell = this.cells.get(`${x}:${z}`);
                if (cell) result.push(...cell);

            }
        }

        return result;

    }

    getKey(x, z) {

        return `${Math.floor(x / this.cellSize)}:` +
            `${Math.floor(z / this.cellSize)}`;

    }

}
