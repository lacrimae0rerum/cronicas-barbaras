# Crónicas Bárbaras — Visor del Grafo de Conocimiento

Visor estático del grafo de conocimiento del podcast *Crónicas Bárbaras*.
147 episodios, ~2500 entidades, 22 comunidades temáticas.

**Live**: https://lacrimae0rerum.github.io/cronicas-barbaras/

## Funcionalidades

- Modos de vista: comunidades (hulls convexos por macro-tema) / episodios.
- Color por tipo de entidad o por comunidad.
- **Beautify**: traslación rígida por comunidad hacia targets cacheados +
  separación a nivel de cluster + resolución de colisiones.
- **Sliders**: distancia entre nodos de una comunidad, distancia entre
  clusters, sin alterar la estructura interna.
- **Selección**: al hacer click en un nodo, se dibujan solo sus edges con
  flechas direccionales en el color del nodo fuente.
- Sidebar con detalle de la entidad, episodios y vecinos.
- Búsqueda por nombre con navegación directa.
- Deep linking por URL: `?select=<id>&mode=community&color=type&beautify=1`.
- Timeline inferior con los 147 episodios ordenados por fecha.

## Stack

Canvas 2D puro, d3-force solo para la simulación de beautify, HTML/CSS/JS
vanilla sin build step.

El pipeline de extracción y procesamiento que produce `data/graph.json` vive
en un repositorio privado aparte.
