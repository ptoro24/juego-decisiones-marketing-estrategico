# Juego Decisiones de Marketing · Ecotec MBA

Simulador de estrategia competitiva (líder y retador) y plan de marketing, con **torneo en línea por salas**.

- `public/index.html`: el juego completo (profesor y grupos usan la misma página).
- `netlify/functions/api.mts`: API de salas (`/api/*`) con Netlify Blobs.

## Cómo se usa en clase
1. El profesor abre el sitio → Ruta A → **Torneo por grupos** → **Sala en línea** → **Crear sala**.
2. Proyecta el código. Cada grupo abre el sitio, toca **Unirme**, escribe el código y elige o crea su grupo.
3. Ritmo **en vivo** (el profesor avanza las rondas) o **cada grupo a su ritmo** (tiempo total y ranking en vivo).

## Publicar
Sube estos archivos a GitHub (sin `node_modules`). En Netlify: *Add new project → Import from GitHub*;
la configuración se lee de `netlify.toml` (carpeta publicada: `public`; funciones: `netlify/functions`).
