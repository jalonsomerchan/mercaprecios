# MercaPrecios

Juego multijugador web para adivinar el precio de artículos de Mercadona, inspirado en la estructura de `jalonsomerchan/democrazy`.

## Qué incluye

- SPA en `index.html` con Tailwind por CDN.
- `js/GameAPI.js` usando `https://alon.one/juegos/api`.
- `js/mercaprecios.js` con salas, jugadores, estado compartido, IttySockets y fallback por polling.
- Carga del catálogo real desde `data/products.json` del propio repositorio `jalonsomerchan/mercaprecios`.
- Carga de categorías desde `data/categories.json`; si faltan, las genera a partir de `top_category`.

## Importante sobre los datos

Este ZIP no incluye `data/products.json` ni `data/categories.json` para no sobrescribir los ficheros reales que ya existen en el repositorio.

El juego carga directamente:

```txt
/data/products.json
/data/categories.json
```

El formato soportado es el que ya tiene el repo:

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

## Subida a GitHub

Copia estos archivos en la raíz del repositorio `jalonsomerchan/mercaprecios`, manteniendo la carpeta `/data` actual:

```txt
index.html
js/GameAPI.js
js/mercaprecios.js
README.md
```

No borres ni sustituyas `/data/products.json`.

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
