# Input e seleção

## Problema que resolve

Transformar eventos do navegador em interação com Entities sem acoplar o input a objetos concretos, efeitos de outline ou regras de gameplay.

## Fluxo

```text
mousemove / click
  → Input emite MouseMove ou Click
  → Scene encaminha ao SelectionManager
  → Raycast encontra objeto Three.js
  → EntityRegistry recupera a Entity correspondente
  → SelectionManager chama o hook apropriado
```

## Classes envolvidas

- `Input`: publicador de `MouseMove`, `MouseEnter`, `MouseLeave` e `Click`.
- `Raycast`: converte o ponto do mouse em um teste contra a cena.
- `EntityRegistry`: mapeia `Object3D` para `Entity` e permite registro/remoção.
- `SelectionManager`: guarda a Entity/objeto em hover e distribui efeitos.

## Hover e seleção não são iguais

Hover acompanha o mouse e pode desaparecer a qualquer momento. Seleção deve persistir após o mouse sair, sendo útil para inspector e gizmos no futuro.

O `SelectionManager` já possui espaço separado para ambos os estados, embora o protótipo use hover como comportamento principal.

## Armadilha

Uma interseção do Three.js contém mais que a malha: contém, por exemplo, o ponto atingido. Quando uma interação depende de localização — como clicar no piso para mover o Player — esse dado deve atravessar o fluxo até `onInteract(object, hit)`; não o reduza prematuramente a apenas uma malha.
