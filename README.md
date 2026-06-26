# MercaPrecios

Juego multijugador web para adivinar el precio de artículos de Mercadona, inspirado en la estructura de `jalonsomerchan/democrazy`.

## Qué incluye

- SPA en `index.html` con Tailwind por CDN.
- `js/GameAPI.js` usando `https://alon.one/juegos/api`.
- `js/mercaprecios.js` con salas, jugadores, estado compartido, IttySockets y fallback por polling.
- Carga del catálogo real desde `data/products.json`.
- Carga de categorías desde `data/categories.json`.
- Scraper automático en `scripts/update-catalog.mjs` para actualizar datos desde `https://datania.github.io/mercadona-catalog/index.html`.
- Workflow `.github/workflows/update-catalog.yml` para actualizar el catálogo con GitHub Actions.
- Workflow `.github/workflows/pages.yml` para desplegar en GitHub Pages.
- `.nojekyll` para servir correctamente archivos y carpetas estáticas.

## Despliegue en GitHub Pages

El repositorio publica la raíz del proyecto como sitio estático cada vez que se hace push a `main`.

En GitHub Pages deja la configuración así:

- **Source:** GitHub Actions
- **Branch:** no hace falta elegir rama, lo gestiona el workflow

URL esperada:

```txt
https://jalonsomerchan.github.io/mercaprecios/
```

## Datos

El juego carga directamente:

```txt
data/products.json
data/categories.json
```

El formato soportado es:

```json
{
  "id": "10005",
  "name": "Chocolate líquido a la taza Hacendado",
  "top_category": "Cacao, café e infusiones",
  "category_path": "Cacao, café e infusiones > Cacao soluble y chocolate a la taza > Chocolate a la taza",
  "price": 2.45,
  "thumbnail": "https://prod-mercadona.imgix.net/images/....jpg?fit=crop&h=300&w=300",
  "url": "https://tienda.mercadona.es/product/10005/..."
}
```

También acepta variantes como `display_name`, `price_instructions.unit_price`, `image`, `image_url` o `share_url`, pero la fuente principal es `data/products.json`.

## Actualización automática del catálogo

El workflow `Update Mercadona catalog` se ejecuta cada día a las 05:17 UTC y también se puede lanzar manualmente desde la pestaña **Actions**.

El proceso hace lo siguiente:

1. Descarga `https://datania.github.io/mercadona-catalog/index.html`.
2. Busca arrays de productos y categorías dentro de los scripts inline o externos de la página.
3. Normaliza productos y categorías.
4. Valida que los datos sean coherentes.
5. Solo escribe `data/products.json` y `data/categories.json` si todo pasa la validación.
6. Solo hace commit si esos archivos cambian.

Validaciones principales:

- mínimo de productos y categorías;
- `id`, `name`, `top_category` y `price` válidos;
- precios positivos y dentro de rango razonable;
- ids de producto no duplicados;
- mayoría de productos con imagen y URL;
- categorías no duplicadas;
- conteos de categorías coincidentes con los productos.

Si cualquier comprobación falla, la action termina con error antes de escribir archivos, así que no se actualiza nada.

Ejecución local:

```bash
node scripts/update-catalog.mjs --dry-run
node scripts/update-catalog.mjs
```

Variables opcionales:

```bash
CATALOG_SOURCE_URL="https://datania.github.io/mercadona-catalog/index.html"
MIN_PRODUCTS=500
MIN_CATEGORIES=5
PRICE_MIN=0.01
PRICE_MAX=1000
```

## Desarrollo local

Abre el proyecto con un servidor local para que `fetch()` pueda leer los JSON:

```bash
python3 -m http.server 8080
```

Después visita:

```txt
http://localhost:8080/
```

## Diseño móvil compacto

La pantalla de partida está optimizada para móvil sin scroll: producto, apuesta, teclado numérico y botón de envío quedan dentro de `100dvh`. En móvil se oculta el mini-ranking durante la ronda para priorizar la jugabilidad.

## Flujo de juego

1. Cada jugador escribe su nombre.
2. El anfitrión crea sala y comparte código, enlace o QR.
3. El anfitrión configura número de artículos, tiempo por artículo, modo de puntuación y categorías.
4. Aparece un producto real del catálogo y cada jugador introduce el precio con teclado numérico.
5. Cuando todos responden, o termina el tiempo, se muestra el precio real, ganador de ronda, diferencias y puntos.
6. Al final se muestra clasificación y ganador.

## Modos

- **Precio justo:** gana quien más se acerque sin pasarse. Si todos se pasan, gana quien quede más cerca.
- **Más cercano:** gana quien tenga menor diferencia absoluta con el precio real.

## Puntuación

- Ganador de ronda: +3 puntos.
- Acierto exacto: +2 puntos extra.
- Diferencia de 0,10 € o menos: +1 punto extra.
