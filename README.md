# Juego Decisiones de Marketing · Ecotec MBA (V10)

Simulador de estrategia competitiva (líder y retador) y plan de marketing, con **torneo en línea por salas**.

- `public/index.html`: el juego completo (profesor y grupos usan la misma página).
- `netlify/functions/api.mts`: API de salas (`/api/*`) con Netlify Blobs.

## Cómo se usa en clase
1. El profesor abre el sitio → Ruta A → **Torneo por grupos** → **Sala en línea** → **Crear sala**.
2. Comparte el código (o el enlace). Cada alumno abre el sitio en su computador, toca **Unirme**, escribe el código y su nombre.
3. Grupos: los alumnos eligen o crean su grupo, o el profesor los asigna con un clic (o los reparte automáticamente).
   Cada grupo tiene además un enlace directo (🔗) que lleva a sus integrantes a ese grupo.
4. Cada alumno ve el caso completo en su computador. La respuesta es una por grupo: cualquier integrante la envía o la cambia, y todos ven lo que envió su grupo.
5. Ritmo **en vivo** (el profesor avanza las rondas) o **cada grupo a su ritmo** (tiempo total y ranking en vivo).

## Publicar
Sube estos archivos a GitHub (sin `node_modules`). En Netlify: *Add new project → Import from GitHub*;
la configuración se lee de `netlify.toml` (carpeta publicada: `public`; funciones: `netlify/functions`).
