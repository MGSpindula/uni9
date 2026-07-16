# Player e movimento

## Problema que resolve

Fazer o Player reagir a um destino sem misturar planejamento de rota, deslocamento físico e apresentação visual.

## Componentes

```text
Player
├── Navigation          rota atual e próximo ponto
├── Locomotion          posição e rotação da raiz
└── AnimationController estado visual e AnimationMixer futuro
```

## Exemplo de fluxo

```js
player.moveTo(destination);
```

1. `Navigation.setDestination` guarda uma rota.
2. `Player` muda para `EntityState.WALKING`.
3. Em cada frame, `Locomotion.moveTo` aproxima a raiz do próximo ponto.
4. Ao chegar, `Navigation.advance` escolhe o próximo ponto ou encerra a rota.
5. Sem pontos restantes, o Player volta para `EntityState.IDLE`.

## Rotas manuais

Antes do BFS, uma rota pode ser declarada explicitamente:

```js
const path = graph.createPath([
    "entrance",
    "main-hall",
    "table-01"
]);

player.followPath(path);
```

`NavigationGraph` valida se os nós existem e se cada par consecutivo está conectado. Ele não escolhe o caminho; o BFS assumirá essa responsabilidade futuramente.

## O que ainda é propositalmente simples

Não há NavMesh nem busca automática de grafo. `moveTo` continua criando uma rota direta de um ponto, enquanto `followPath` recebe uma lista manual validada pelo grafo.

## Regra importante

`Locomotion` move `player.object3D`; `AnimationController` altera somente `player.visual`. Isso impede que o balanço da caminhada altere a posição usada pela navegação.
