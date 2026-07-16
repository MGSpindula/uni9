# Documentação do Cozy Campus Engine

Esta documentação explica **por que** os sistemas existem, suas fronteiras e os fluxos entre eles. Para nomes e assinaturas exatas, consulte também o código.

## Mapa

- [Arquitetura](architecture.md): visão do projeto e responsabilidades.
- [Convenções](conventions.md): regras para Entity, `object3D`/`visual`, states e tweens.
- [Input e seleção](systems/input-selection.md): clique, raycast e hover.
- [Player e movimento](systems/player-movement.md): Navigation, Locomotion e AnimationController.
- [Animação](systems/animation.md): Tween, presets e transformações visuais.
- [Pós-processamento](systems/postprocessing.md): pipeline de renderização e efeitos.
- [Decisão 001](decisions/001-root-and-visual.md): raiz de gameplay e filho visual.
- [Registro de aprendizado](learning-log.md): descobertas feitas durante o desenvolvimento.

## Como manter

Ao finalizar uma mudança relevante:

1. Atualize a página do sistema afetado.
2. Registre uma decisão em `decisions/` quando ela restringir escolhas futuras.
3. Adicione uma nota curta em `learning-log.md` se houver uma descoberta útil.

Prefira exemplos pequenos e diagramas de fluxo. Não replique cada método do código: documente a intenção e as regras de uso.
