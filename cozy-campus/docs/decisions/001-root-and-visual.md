# Decisão 001 — Separar raiz de gameplay e visual

## Contexto

O Player precisa caminhar enquanto recebe animações cosméticas, como balanço, respiração e, futuramente, clips de esqueleto. Alterar a mesma transformação por locomotion e animação causa tremores, altura incorreta e estado de rede ambíguo.

## Decisão

Entities móveis podem usar esta hierarquia:

```text
object3D (raiz física)
└── visual (modelo, armature, roupas e efeitos locais)
```

## Consequências

- Navigation e Locomotion alteram apenas a raiz.
- Animações cosméticas alteram `visual` ou os ossos abaixo dele.
- Transformações de gameplay deliberadas podem continuar mirando a raiz.
- Props estáticos não precisam criar um filho visual até que haja necessidade.
