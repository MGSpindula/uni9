# Arquitetura

## Objetivo

O Cozy Campus é um conjunto de ambientes independentes, interativos por clique. Three.js renderiza o mundo; regras de gameplay e interface não devem ficar presas às malhas ou ao canvas.

## Fluxo de interação atual

```text
Browser event
  → Input
  → SelectionManager
  → Raycast + EntityRegistry
  → Entity.onInteract(...)
  → regra de gameplay
```

`Input` não conhece `Entity`, `Player` ou efeitos visuais. Ele apenas emite eventos do canvas. `SelectionManager` interpreta esses eventos no contexto da cena e gerencia o hover.

## Fluxo de movimento atual

```text
Floor recebe interação
  → Scene encaminha a intenção ao Player
  → Player.moveTo(position)
  → Navigation fornece o próximo ponto da rota
  → Locomotion move a raiz
  → AnimationController representa o estado
```

Hoje a rota possui apenas um ponto. Mais tarde `Navigation` poderá trocar essa implementação por uma rede de caminhos criada no Blender sem mudar a API do Player ou da Locomotion.

## Responsabilidades

| Área | Responsabilidade | Não deve fazer |
| --- | --- | --- |
| `core/Entity` | estado, interação, tween e ciclo de vida de uma entidade | conhecer detalhes de cena ou input |
| `core/Input` | emitir eventos do navegador | resolver raycast ou gameplay |
| `core/SelectionManager` | hover, clique e efeitos de seleção | implementar regras de cada objeto |
| `navigation/Navigation` | rota corrente de um agente | alterar posição física |
| `navigation/NavigationGraph` | nós, conexões e validação de rotas | escolher caminho ou mover agentes |
| `characters/Locomotion` | deslocamento e rotação | escolher rota ou animação |
| `characters/AnimationController` | estado visual e mixer | mover a raiz no mundo |
| `postprocessing/` | passes de renderização | conhecer entidades concretas |
| `Scene` | compor sistemas e conectar dependências | concentrar regras específicas de objetos |

## Estrutura atual

```text
src/
├── characters/       Player, Locomotion, AnimationController
├── core/             abstrações de gameplay e interação
├── navigation/       grafo compartilhado e rotas dos agentes
├── objects/          entidades concretas do protótipo
├── postprocessing/   compositor e efeitos de renderização
├── Renderer.js       WebGLRenderer
└── Scene.js          composição da cena
```
