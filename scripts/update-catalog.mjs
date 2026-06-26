#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const SOURCE_URL = process.env.CATALOG_SOURCE_URL || 'https://datania.github.io/mercadona-catalog/index.html';
const PRODUCTS_PATH = process.env.PRODUCTS_PATH || 'data/products.json';
const CATEGORIES_PATH = process.env.CATEGORIES_PATH || 'data/categories.json';
const MIN_PRODUCTS = Number(process.env.MIN_PRODUCTS || 500);
const MIN_CATEGORIES = Number(process.env.MIN_CATEGORIES || 5);
const PRICE_MIN = Number(process.env.PRICE_MIN || 0.01);
const PRICE_MAX = Number(process.env.PRICE_MAX || 1000);
const DRY_RUN = process.argv.includes('--dry-run');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'mercaprecios-catalog-updater/1.0 (+https://github.com/jalonsomerchan/mercaprecios)',
          'Accept': 'text/html,application/javascript,text/javascript,*/*;q=0.8'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} al descargar ${url}`);
      }

      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

function extractScriptTags(html) {
  const scripts = [];
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    const attrs = match[1] || '';
    const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    scripts.push({ src: srcMatch?.[1] || null, body: match[2] || '' });
  }
  return scripts;
}

async function loadScriptSources(sourceUrl) {
  const html = await fetchText(sourceUrl);
  const tags = extractScriptTags(html);
  const sources = [];

  for (const [index, tag] of tags.entries()) {
    if (tag.src) {
      const scriptUrl = new URL(tag.src, sourceUrl).href;
      try {
        sources.push({ label: `script externo ${index + 1}: ${scriptUrl}`, code: await fetchText(scriptUrl) });
      } catch (error) {
        console.warn(`Aviso: no se pudo descargar ${scriptUrl}: ${error.message}`);
      }
    } else if (tag.body.trim()) {
      sources.push({ label: `script inline ${index + 1}`, code: tag.body });
    }
  }

  if (!sources.length) {
    throw new Error('No se encontraron scripts con datos en la página fuente.');
  }

  return sources;
}

function readBalancedLiteral(source, startIndex) {
  const open = source[startIndex];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return null;

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = startIndex; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === open) depth += 1;
    if (char === close) depth -= 1;

    if (depth === 0) {
      return source.slice(startIndex, i + 1);
    }
  }

  return null;
}

function tryParseLiteral(literal) {
  try {
    return JSON.parse(literal);
  } catch {}

  try {
    return vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1500 });
  } catch {
    return null;
  }
}

function collectLiteralCandidates(code, label) {
  const candidates = [];
  const assignmentRegex = /(?:\b(?:const|let|var)\s+|\b(?:window|globalThis)\.)([A-Za-z_$][\w$]*)\s*=\s*/g;
  let match;

  while ((match = assignmentRegex.exec(code)) !== null) {
    let start = assignmentRegex.lastIndex;
    while (/\s/.test(code[start])) start += 1;
    if (code[start] !== '[' && code[start] !== '{') continue;
    const literal = readBalancedLiteral(code, start);
    if (!literal) continue;
    const value = tryParseLiteral(literal);
    if (value !== null) {
      candidates.push({ name: match[1], value, label });
    }
  }

  return candidates;
}

function valueAt(item, paths) {
  for (const currentPath of paths) {
    const value = currentPath.split('.').reduce((acc, key) => acc?.[key], item);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function getPrice(item) {
  return Number(valueAt(item, [
    'price',
    'unit_price',
    'bulk_price',
    'price_instructions.unit_price',
    'price_instructions.bulk_price',
    'priceInstructions.unitPrice',
    'priceInstructions.bulkPrice'
  ]));
}

function productScore(list) {
  if (!Array.isArray(list) || list.length < MIN_PRODUCTS) return 0;
  const sample = list.slice(0, Math.min(list.length, 120));
  const good = sample.filter(item => {
    const name = valueAt(item, ['name', 'display_name', 'title']);
    const price = getPrice(item);
    const id = valueAt(item, ['id', 'product_id', 'slug']);
    return item && typeof item === 'object' && name && id && Number.isFinite(price) && price > 0;
  }).length;
  return good / sample.length;
}

function categoryScore(list) {
  if (!Array.isArray(list) || list.length < MIN_CATEGORIES) return 0;
  const sample = list.slice(0, Math.min(list.length, 60));
  const good = sample.filter(item => {
    const name = valueAt(item, ['name', 'title', 'id']);
    const hasCategoryShape = 'count' in item || 'color' in item || !('price' in item);
    return item && typeof item === 'object' && name && hasCategoryShape;
  }).length;
  return good / sample.length;
}

function findBestDataSets(candidates) {
  const arrays = candidates.filter(candidate => Array.isArray(candidate.value));
  const productCandidates = arrays
    .map(candidate => ({ ...candidate, score: productScore(candidate.value) }))
    .filter(candidate => candidate.score >= 0.75)
    .sort((a, b) => b.value.length - a.value.length || b.score - a.score);

  if (!productCandidates.length) {
    throw new Error('No se encontró un array válido de productos en los scripts de la página fuente.');
  }

  const products = productCandidates[0];
  const categoryCandidates = arrays
    .filter(candidate => candidate !== products)
    .map(candidate => ({ ...candidate, score: categoryScore(candidate.value) }))
    .filter(candidate => candidate.score >= 0.75)
    .sort((a, b) => b.value.length - a.value.length || b.score - a.score);

  if (!categoryCandidates.length) {
    throw new Error('No se encontró un array válido de categorías en los scripts de la página fuente.');
  }

  return { products, categories: categoryCandidates[0] };
}

function roundPrice(value) {
  return Number(Number(value).toFixed(2));
}

function asCleanString(value) {
  return String(value ?? '').trim();
}

function normalizeProduct(item) {
  const id = asCleanString(valueAt(item, ['id', 'product_id', 'productId', 'slug']));
  const name = asCleanString(valueAt(item, ['name', 'display_name', 'title']));
  const price = roundPrice(getPrice(item));
  const topCategory = asCleanString(valueAt(item, ['top_category', 'topCategory', 'category', 'categories.0.name'])) || 'Mercadona';
  const categoryPath = asCleanString(valueAt(item, ['category_path', 'categoryPath'])) || topCategory;
  const thumbnail = asCleanString(valueAt(item, ['thumbnail', 'image', 'image_url', 'imageUrl', 'photos.0.regular']));
  const url = asCleanString(valueAt(item, ['url', 'share_url', 'shareUrl']));

  const normalized = {
    id,
    name,
    top_category: topCategory,
    category_path: categoryPath,
    price,
    thumbnail,
    url
  };

  const x = Number(item.x);
  const y = Number(item.y);
  if (Number.isFinite(x)) normalized.x = x;
  if (Number.isFinite(y)) normalized.y = y;
  if (Array.isArray(item.color)) normalized.color = item.color.map(Number).filter(Number.isFinite);

  for (const key of Object.keys(item)) {
    if (!(key in normalized)) normalized[key] = item[key];
  }

  return normalized;
}

function normalizeCategory(item) {
  const name = asCleanString(valueAt(item, ['name', 'title', 'id']));
  const count = Number(item.count ?? 0);
  const normalized = { name, count: Number.isFinite(count) ? count : 0 };
  if (Array.isArray(item.color)) normalized.color = item.color.map(Number).filter(Number.isFinite);

  for (const key of Object.keys(item)) {
    if (!(key in normalized)) normalized[key] = item[key];
  }

  return normalized;
}

function validateProducts(products) {
  const errors = [];
  if (!Array.isArray(products) || products.length < MIN_PRODUCTS) {
    errors.push(`Se esperaban al menos ${MIN_PRODUCTS} productos y se han encontrado ${products.length}.`);
  }

  const ids = new Set();
  const categoryCounts = new Map();
  let productsWithThumbnail = 0;
  let productsWithUrl = 0;

  for (const [index, product] of products.entries()) {
    if (!product.id) errors.push(`Producto ${index}: id vacío.`);
    if (!product.name) errors.push(`Producto ${index}: name vacío.`);
    if (!product.top_category) errors.push(`Producto ${index}: top_category vacío.`);
    if (!Number.isFinite(product.price) || product.price < PRICE_MIN || product.price > PRICE_MAX) {
      errors.push(`Producto ${product.id || index}: precio inválido (${product.price}).`);
    }
    if (product.id) {
      if (ids.has(product.id)) errors.push(`Producto duplicado: id ${product.id}.`);
      ids.add(product.id);
    }
    if (product.thumbnail) productsWithThumbnail += 1;
    if (product.url) productsWithUrl += 1;
    categoryCounts.set(product.top_category, (categoryCounts.get(product.top_category) || 0) + 1);
    if (errors.length > 40) break;
  }

  if (productsWithThumbnail / Math.max(products.length, 1) < 0.75) {
    errors.push('Menos del 75% de productos tienen thumbnail.');
  }

  if (productsWithUrl / Math.max(products.length, 1) < 0.75) {
    errors.push('Menos del 75% de productos tienen URL de Mercadona.');
  }

  if (categoryCounts.size < MIN_CATEGORIES) {
    errors.push(`Se esperaban al menos ${MIN_CATEGORIES} categorías con productos y hay ${categoryCounts.size}.`);
  }

  if (errors.length) throw new Error(`Validación de productos fallida:\n- ${errors.join('\n- ')}`);
  return categoryCounts;
}

function validateCategories(categories, categoryCounts) {
  const errors = [];
  if (!Array.isArray(categories) || categories.length < MIN_CATEGORIES) {
    errors.push(`Se esperaban al menos ${MIN_CATEGORIES} categorías y se han encontrado ${categories.length}.`);
  }

  const names = new Set();
  for (const [index, category] of categories.entries()) {
    if (!category.name) errors.push(`Categoría ${index}: name vacío.`);
    if (category.name) {
      if (names.has(category.name)) errors.push(`Categoría duplicada: ${category.name}.`);
      names.add(category.name);
    }
    if (!Number.isFinite(Number(category.count)) || Number(category.count) < 0) {
      errors.push(`Categoría ${category.name || index}: count inválido (${category.count}).`);
    }
  }

  const missingInCategories = [...categoryCounts.keys()].filter(name => !names.has(name));
  if (missingInCategories.length) {
    errors.push(`Faltan categorías presentes en productos: ${missingInCategories.slice(0, 10).join(', ')}${missingInCategories.length > 10 ? '…' : ''}`);
  }

  const mismatches = categories
    .filter(category => categoryCounts.has(category.name) && Number(category.count) !== categoryCounts.get(category.name))
    .map(category => `${category.name}: count=${category.count}, real=${categoryCounts.get(category.name)}`);

  if (mismatches.length) {
    errors.push(`Categorías con conteo diferente al catálogo: ${mismatches.slice(0, 10).join('; ')}${mismatches.length > 10 ? '…' : ''}`);
  }

  if (errors.length) throw new Error(`Validación de categorías fallida:\n- ${errors.join('\n- ')}`);
}

async function main() {
  console.log(`Descargando catálogo desde ${SOURCE_URL}`);
  const scriptSources = await loadScriptSources(SOURCE_URL);
  const candidates = scriptSources.flatMap(source => collectLiteralCandidates(source.code, source.label));
  const { products: productsCandidate, categories: categoriesCandidate } = findBestDataSets(candidates);

  console.log(`Productos detectados en ${productsCandidate.label} (${productsCandidate.name}): ${productsCandidate.value.length}`);
  console.log(`Categorías detectadas en ${categoriesCandidate.label} (${categoriesCandidate.name}): ${categoriesCandidate.value.length}`);

  const products = productsCandidate.value.map(normalizeProduct);
  const categories = categoriesCandidate.value.map(normalizeCategory);
  const categoryCounts = validateProducts(products);
  validateCategories(categories, categoryCounts);

  const productsJson = `${JSON.stringify(products)}\n`;
  const categoriesJson = `${JSON.stringify(categories)}\n`;

  if (DRY_RUN) {
    console.log('Validación correcta. Dry-run activo: no se escriben archivos.');
    return;
  }

  await fs.mkdir(path.dirname(PRODUCTS_PATH), { recursive: true });
  await fs.mkdir(path.dirname(CATEGORIES_PATH), { recursive: true });
  await fs.writeFile(PRODUCTS_PATH, productsJson, 'utf8');
  await fs.writeFile(CATEGORIES_PATH, categoriesJson, 'utf8');

  console.log(`Catálogo actualizado: ${products.length} productos y ${categories.length} categorías.`);
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
