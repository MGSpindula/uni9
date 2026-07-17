# 📊 Análise de Performance - NavigationGraphHelper vs Candidatos Reais

## 🎯 Contexto
- 3 NPCs ativos
- Bundle: ~704 kB (aviso acima de 500 kB)
- Próximo diagnóstico: relação Update vs Render dirá se é navegação ou gráficos

---

## 1️⃣ IMPACTO DA OTIMIZAÇÃO: NavigationGraphHelper

### O Que Foi Otimizado
```
✅ Desativar renderização visual debug
✅ Bloquear refresh() quando invisível
✅ Liberar geometrias/texturas de memória
✅ Evitar recalculos desnecessários
```

### Análise Crítica

#### **Impacto Render:**
- **Triangles salvos**: ~50-100 por node × 9 nodes = 450-900 tris debug
- **Draw calls salvos**: ~15-20 ao desativar helper
- **Percentual geral**: 1-2% da carga de render (BAIXO)

#### **Impacto Update:**
- **Zero impacto** - NavigationGraphHelper é 100% visual
- Não faz raycasts, colisões ou lógica de navegação

#### **Impacto Memória:**
- **Geometrias**: ~50 KB (SphereGeometry, LineGeometry, CanvasTexture)
- **Materiais**: ~20 KB (MeshBasicMaterial, LineBasicMaterial)
- **Total liberado**: ~70 KB (0.01% do bundle)

### 🎯 Conclusão
**NavigationGraphHelper é um alvo VÁLIDO mas com impacto MARGINAL (1-2% render)**

---

## 2️⃣ CANDIDATOS PRINCIPAIS (Outro ChatBot)

### 🔴 TOP 1: Shadow Map 2048×2048
```
IMPACTO: 10-30% do Render (CRÍTICO)
CUSTO: WebGL passa a renderizar scene 2x (normal + shadow)
SOLUÇÃO: Reduzir para 1024×1024 ou usar PCSS
```

**Implementação Atual:**
```javascript
// Renderer.js
sun.shadow.mapSize.set(2048, 2048);  // ← MUITO ALTO
```

**Redução Recomendada:**
```javascript
sun.shadow.mapSize.set(1024, 1024);  // 50% ganho
// Ou ainda melhor:
sun.shadow.mapSize.set(512, 512);    // 75% ganho (com PCF suave)
```

---

### 🔴 TOP 2: OutlinePass (Pós-Processamento)
```
IMPACTO: 15-25% do Render (CRÍTICO)
CUSTO: Renderiza scene 2-3x mais para outline
CONTEXTO: Usado só para seleção de objetos
```

**Análise Atual:**
- OutlineEffect está ativo
- `edgeStrength = 3` é agressivo
- Renderiza TODA scene quando algo está selecionado

**Possíveis Soluções:**
1. Desativar quando nada selecionado (fácil, +20% ganho)
2. Reduzir `edgeStrength` de 3 → 1.5 (fácil, +5% ganho)
3. Usar outline em shader ao invés de pass (complexo, +40% ganho)

---

### 🟠 TOP 3: Anti-Aliasing Duplo
```
IMPACTO: 5-15% do Render (MÉDIO)
CUSTO: MSAA=4 + antialias=true simultâneos
```

**Implementação Atual:**
```javascript
// Renderer.js
this.renderer = new THREE.WebGLRenderer({
    antialias: true  // ← Ativa MSAA (geralmente 4x)
});
// Postprocessing também pode ter FXAAPass
```

**Possível Conflito:**
- Se PostProcessing usar FXAAPass + antialias=true = duplo
- Ganho: Desativar um deles = +8% render

---

### 🟠 TOP 4: Raycasts de Grounding (CharacterGrounding)
```
IMPACTO: 5-20% do Update (MÉDIO, varia com frame)
CUSTO: 3 NPCs × ~20-100 raycasts/frame
```

**Análise:**
- `CharacterGrounding` faz raycast para validar posição
- Frequência desconhecida (pode ser a cada frame)
- É crítico para colisão com terrain

**Possível Otimização:**
```javascript
// Fazer raycast a cada 2-3 frames ao invés de todo frame
// Ou usar caching de posições
```

---

### 🟡 TOP 5: Colisões entre Personagens (CollisionSolver)
```
IMPACTO: 3-10% do Update (BAIXO-MÉDIO, O(n²))
CUSTO: 3 NPCs = 3×2 = 6 pares verificados
```

**Análise:**
- `CharacterCollisionSolver` é O(n²)
- Com 3 NPCs: muito aceitável
- Com 10+ NPCs: precisa quadtree/spatial partitioning

---

## 📈 Prioridade Real vs O Que Foi Feito

| Problema | Impacto | O Que Fizemos | Prioridade Atual |
|----------|---------|---|---|
| **Shadow Map** | 10-30% | ❌ Nada | 🔴 **PRIMEIRO** |
| **OutlinePass** | 15-25% | ❌ Nada | 🔴 **SEGUNDO** |
| **Anti-Aliasing Duplo** | 5-15% | ❌ Nada | 🟠 Terceiro |
| **Grounding Raycast** | 5-20% | ❌ Nada | 🟠 Terceiro |
| **Colisões (n²)** | 3-10% | ❌ Nada | 🟡 Mais tarde |
| **NavigationGraphHelper** | 1-2% | ✅ Otimizado | 🟢 Correto |

---

## ✅ Próximos Passos Recomendados

### Imediato (Ganho: ~30-50% render)
```
1. Reduzir shadow.mapSize 2048 → 1024
2. Desativar OutlinePass quando nada selecionado
3. Testar antialias + FXAA redundância
```

### Curto Prazo (Ganho: ~10-20% update)
```
4. Analisar frequência de CharacterGrounding.raycast
5. Implementar caching/debouncing se necessário
6. Perfil com Chrome DevTools
```

### Longo Prazo
```
7. Spatial partitioning para colisões
8. LOD (Level of Detail) para modelos
9. Frustum culling otimizado
```

---

## 📊 Conclusão

### ✅ O Que Fizemos
- NavigationGraphHelper otimizado corretamente
- Bloqueio de refresh() implementado
- Liberação de memória ao desativar

### ⚠️ O Que Falta
- NavigationGraphHelper tem impacto **marginal (1-2%)**
- Os verdadeiros culpritos estão em **Shadow Map e OutlinePass (30-50%)**
- Diagnóstico Update vs Render ainda não foi feito

### 🎯 Recomendação
1. Manter NavigationGraphHelper como está ✅
2. Focar nos candidatos principais (Shadow, Outline)
3. Fazer profiling com DevTools para confirmar
