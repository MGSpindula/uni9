# Registro de aprendizado

## 2026-07-15 — Input, raycast e Player

- O resultado do raycast contém o objeto atingido e o ponto da interseção; o ponto precisa continuar no fluxo quando uma regra depende de localização.
- Hover e seleção são estados diferentes: hover acompanha o mouse; seleção persiste.
- Navigation escolhe pontos, Locomotion move e AnimationController apresenta o estado. Misturar essas responsabilidades dificulta a evolução para caminhos.
- A câmera de sombras de uma luz direcional possui um volume limitado. Fora dele, uma malha pode continuar visível, mas não projetará sombra.

## 2026-07-15 — Animação e transformações

- `object3D` representa a posição física de uma Entity no mundo.
- `visual` é o lugar apropriado para offsets cosméticos, como o balanço da caminhada.
- Padrões de tween recorrentes devem virar presets parametrizáveis, não cópias de callbacks encadeados em cada objeto.
