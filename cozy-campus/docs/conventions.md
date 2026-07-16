# Convenções

## Estados

Use valores de `EntityState`; não crie strings como `"walk"` diretamente em sistemas de gameplay ou animação.

```js
this.setState(EntityState.WALKING);
this.setState(EntityState.IDLE);
```

O estado da Entity é a fonte de verdade. Controladores visuais reagem a ele por meio de `onStateChanged(previous, current)`.

## Interação

Subclasses implementam hooks, não substituem o fluxo base:

```js
onHover(object) {}
onUnhover(object) {}
onInteract(object, hit) {}
```

`Entity.hover`, `unhover` e `interact` preservam a passagem pelos efeitos e então chamam esses hooks.

## Transformações: raiz e visual

```text
entity.object3D  → raiz de gameplay no mundo
└── entity.visual → aparência/animação local opcional
```

- `object3D`: navegação, colisão, posição recebida da rede e transformações físicas.
- `visual`: balanço, squash/stretch, ossos, roupas e feedback cosmético.

Nem toda Entity simples precisa de `visual`. Uma cadeira estática pode usar `object3D` como toda a sua hierarquia visual. Personagens que se movimentam devem separar os dois nós.

## Animações

Uma Entity inicia a animação; `AnimationPresets` executa movimentos genéricos; `Tween` interpola valores e é atualizado por `Entity.update(delta)`.

Sempre informe `target: entity.visual` quando o movimento for apenas visual em uma entidade móvel.
