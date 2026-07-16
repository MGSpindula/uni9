# Animação

## Camadas atuais

O protótipo possui duas formas complementares de animação:

1. `Tween`: valores numéricos interpolados e pertencentes a uma Entity.
2. `AnimationController`: estado visual contínuo do Player e ponto de entrada futuro para `THREE.AnimationMixer`.

## AnimationPresets

`AnimationPresets` é o catálogo de movimentos reutilizáveis sobre Tween.

| Preset | Uso |
| --- | --- |
| `to` | propriedade numérica, como rotação ou velocidade |
| `scaleTo` | escala até um vetor desejado |
| `scaleBounce` | cresce e retorna à escala inicial |
| `jump` | sobe e desce a partir da altura inicial |

Exemplo de feedback visual para uma Entity móvel:

```js
AnimationPresets.scaleBounce(this, {
    target: this.visual,
    multiplier: 1.1,
    outDuration: 0.12,
    returnDuration: 0.18
});
```

## Escolha do target

`target` é obrigatório conceitualmente, ainda que os presets tenham `entity.object3D` como default para objetos estáticos simples.

- `target: entity.object3D`: a transformação é real no mundo.
- `target: entity.visual`: a transformação é somente aparência local.

Um `jump` na raiz de um Player muda sua posição física. Um `jump` no visual é um salto cosmético e não deve afetar navegação ou rede.

## Próximos presets candidatos

Quando um padrão aparecer em pelo menos duas Entities, considere adicioná-lo: `shake`, `punchScale`, `fade`, `rotateTo` e `colorFlash`.
