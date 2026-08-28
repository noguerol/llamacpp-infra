# Plan de llamacpp-infra

## Status: 6/12 completed

- ⏳ Pending: 6
- ✅ Completed: 6

## ⏳ Pending

- [ ] Ids compactos en toPiModel con etiqueta de máquina (host:port); el id crudo del servidor se guarda en serverModelId y en los mapas serverModelIds/compactModelIds.
- [ ] Hook 0 de reescritura: before_provider_request (registrado primero, la cadena de hooks de pi encadena payloads) traduce el id compacto → id crudo antes de que la petición salga de pi. El servidor siempre recibe el path/alias que él mismo anunció.
- [ ] Thinking budget nativo: los modelos llama.cpp se registran con reasoning: true + thinkingTokenBudgetField, así el footer muestra Nombre (host:port) • medium y pi envía el budget automáticamente; los budgets por modelo configurados en la extensión siguen teniendo prioridad.
- [ ] Migración de config: las claves de modelOptions en formato legacy host:port/model se migran solas al id compacto en el primer scan (y se elimina la clave vieja).
- [ ] Warmup adaptado: plantillas keyed por id compacto; las peticiones de prefill usan el id crudo (nueva opción requestModelFor en PromptWarmer).
- [ ] Colisiones: con prefixModelIds: false el id es solo el nombre; la etiqueta de máquina se re-añade solo si hay colisión; duplicados añaden el id de servidor.

## ✅ Completed

- [x] Explorar la estructura del repo y localizar la extensión, documentación y scripts de release/publicación (took 00:08:59)
- [x] Publicar release v1.1.0 en GitHub público y npm; verificar estado de remoto privado (took 00:00:05)
- [x] Implementar ids compactos (nombre + máquina entre paréntesis) con reescritura del payload al id real del servidor (took 00:06:51)
- [x] Migrar claves de modelOptions al nuevo formato de id y mantener soporte legacy (took 00:04:56)
- [x] Adaptar warmup, ZINC, métricas y UI al nuevo formato de id
- [x] Tests con mock server, actualizar docs (README/About), version 1.2.0, commit/push/npm

---
*Last updated: 28/8/2026, 22:21:12*