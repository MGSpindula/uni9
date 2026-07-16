# Pós-processamento

## Pipeline

```text
RenderPass
  → efeitos registrados
  → OutputPass
```

`PostProcessing` conhece somente a interface base de um efeito. Ele não deve conter condicionais para `OutlineEffect`, Bloom ou qualquer efeito específico.

## Interface de efeito

Um efeito expõe seu pass por `getPass()` e pode participar do ciclo de vida:

```text
initialize → resize → enable/disable → dispose
```

`OutlineEffect` é registrado tanto no `PostProcessing` (para renderizar) quanto no `SelectionManager` (para reagir a hover). A Entity decide se aceita outline por meio de `hasOutline()`.
