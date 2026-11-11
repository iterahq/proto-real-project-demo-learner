#!/usr/bin/env node
// Deterministic checks for the Itera portfolio project. Node built-ins only.
//
// Usage:
//   node checks/run.mjs --step step-2
//   node checks/run.mjs --all --json
//   node checks/run.mjs --probe   (prints enabled=true when the Pages URL answers 200)
// Options: --dir <site dir> (default: cwd), --repo owner/repo (default: $GITHUB_REPOSITORY),
//          --url <pages url> (override), --retries <n>, --delay <ms>
//
// Parsing limits (static, regex based, on purpose):
// - HTML/CSS comments are stripped first; JS comments are stripped string-aware.
// - HTML attributes are read from the opening tag only; unusual markup (e.g. ">" inside
//   an attribute value) may confuse the parser.
// - The projects section is found by id="projects" and read up to the first closing
//   tag with the same name, so nested tags of the same name may cut it short.
// - The theme toggle is detected by `classList.toggle(` plus a reference to
//   documentElement / document.body / querySelector('html'|'body'); we do not execute JS.
// - Step 5 needs the network. 404 means Pages is not live yet and is reported "pending".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// check id -> what is missing (pt-BR, beginner level) and the lesson topic to review.
export const MESSAGES = {
  's1-doctype': { missing: 'A primeira linha do index.html ainda não avisa ao navegador que isto é uma página HTML moderna (o doctype).', topic: 'HTML: estrutura da página' },
  's1-lang': { missing: 'A tag <html> ainda não diz em que idioma a página está escrita.', topic: 'HTML: estrutura da página' },
  's1-title': { missing: 'A página ainda não tem um título para aparecer na aba do navegador (ou ele está vazio).', topic: 'HTML: estrutura da página' },
  's1-landmarks': { missing: 'Faltam partes da estrutura: a página precisa de um cabeçalho, uma área principal e um rodapé.', topic: 'HTML: estrutura da página' },
  's1-one-h1': { missing: 'A página precisa ter exatamente um título principal (h1) com texto dentro.', topic: 'HTML: títulos e textos' },
  's2-about': { missing: 'Falta uma seção que fale sobre você, marcada com o id "about".', topic: 'HTML: seções' },
  's2-projects': { missing: 'Falta a lista dos seus projetos, marcada com o id "projects", com pelo menos 2 links dentro.', topic: 'HTML: listas' },
  's2-img-alt': { missing: 'Falta uma imagem na página, ou alguma imagem está sem o texto alternativo preenchido.', topic: 'HTML: links e imagens' },
  's3-linked': { missing: 'O arquivo styles.css ainda não está ligado ao index.html, ou está vazio.', topic: 'CSS: ligando o arquivo' },
  's3-layout': { missing: 'O CSS ainda não organiza o layout com flexbox ou grid.', topic: 'CSS: flexbox' },
  's3-hover': { missing: 'O CSS ainda não tem nenhuma regra que reage ao mouse passando por cima (:hover).', topic: 'CSS: hover' },
  's3-media': { missing: 'O CSS ainda não tem nenhuma regra que muda o visual conforme o tamanho da tela (media query).', topic: 'CSS: media queries' },
  's4-linked': { missing: 'O script.js ainda não está ligado ao index.html, ou está ligado num lugar em que pode rodar antes da página carregar.', topic: 'JS: ligando o arquivo' },
  's4-button': { missing: 'Falta um botão na página para a pessoa clicar.', topic: 'JS: eventos' },
  's4-listener': { missing: 'O JavaScript ainda não fica "escutando" o clique do botão.', topic: 'JS: eventos' },
  's4-toggle': { missing: 'O JavaScript ainda não liga e desliga uma classe de tema no <html> ou no <body>.', topic: 'JS: classes no DOM' },
  's5-live': { missing: 'O seu site ainda não responde no endereço do GitHub Pages.', topic: 'Git: publicar no GitHub Pages' },
  's5-title': { missing: 'O site publicado não mostra o título que está no seu index.html. Talvez a versão publicada seja antiga.', topic: 'Git: enviar mudanças' },
};

// ---------- helpers ----------

function readFileSafe(dir, name) {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    return null;
  }
}

export function stripHtmlComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '');
}

export function stripCssComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

// String-aware JS comment stripper (handles ', ", ` and // and /* */).
export function stripJsComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') {
          out += src[i++];
        }
        if (i < src.length) out += src[i++];
      }
      if (i < src.length) out += src[i++];
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function parseAttrs(raw) {
  const attrs = {};
  const re = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

// All opening tags of a given name: [{ attrs, index, end }]
export function findTags(html, name) {
  const re = new RegExp(`<${name}(?=[\\s>/])([^>]*)>`, 'gi');
  const found = [];
  let m;
  while ((m = re.exec(html))) {
    found.push({ attrs: parseAttrs(m[1]), index: m.index, end: m.index + m[0].length });
  }
  return found;
}

function textOf(fragment) {
  return fragment.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

// Inner HTML of the first element whose id equals `id` (see parsing limits above).
export function innerById(html, id) {
  const re = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>`, 'i');
  const m = re.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const close = html.toLowerCase().indexOf(`</${m[1].toLowerCase()}>`, start);
  return html.slice(start, close === -1 ? html.length : close);
}

function localHref(attrs, file) {
  const v = (attrs.href ?? attrs.src ?? '').split(/[?#]/)[0].replace(/^\.\//, '');
  return v === file;
}

function loadSite(dir) {
  const html = readFileSafe(dir, 'index.html');
  const css = readFileSafe(dir, 'styles.css');
  const js = readFileSafe(dir, 'script.js');
  return {
    html: html === null ? '' : stripHtmlComments(html),
    css: css === null ? null : stripCssComments(css),
    js: js === null ? null : stripJsComments(js),
  };
}

function cssLinked(site) {
  return findTags(site.html, 'link').some(
    (t) => /\bstylesheet\b/i.test(t.attrs.rel ?? '') && localHref(t.attrs, 'styles.css'),
  );
}

// ---------- static checks: id -> (site) => boolean ----------

export const STATIC_CHECKS = {
  's1-doctype': ({ html }) => /^\s*<!doctype\s+html\s*>/i.test(html),
  's1-lang': ({ html }) => findTags(html, 'html').some((t) => (t.attrs.lang ?? '').trim() !== ''),
  's1-title': ({ html }) => /<title[^>]*>\s*\S[\s\S]*?<\/title>/i.test(html),
  's1-landmarks': ({ html }) => ['header', 'main', 'footer'].every((n) => findTags(html, n).length > 0),
  's1-one-h1': ({ html }) => {
    const h1s = html.match(/<h1(?=[\s>])[^>]*>[\s\S]*?<\/h1>/gi) ?? [];
    return h1s.length === 1 && textOf(h1s[0]) !== '';
  },
  's2-about': ({ html }) => {
    const inner = innerById(html, 'about');
    return inner !== null && textOf(inner) !== '';
  },
  's2-projects': ({ html }) => {
    const inner = innerById(html, 'projects');
    if (inner === null) return false;
    const links = findTags(inner, 'a').filter((t) => {
      const href = (t.attrs.href ?? '').trim();
      return href !== '' && href !== '#';
    });
    return links.length >= 2;
  },
  's2-img-alt': ({ html }) => {
    const imgs = findTags(html, 'img');
    return imgs.length > 0 && imgs.every((t) => (t.attrs.alt ?? '').trim() !== '');
  },
  's3-linked': (site) => cssLinked(site) && site.css !== null && site.css.trim() !== '',
  's3-layout': ({ css }) => css !== null && /display\s*:\s*(inline-)?(flex|grid)\b/i.test(css),
  's3-hover': ({ css }) => css !== null && /:hover\b[^{}]*\{/i.test(css),
  's3-media': ({ css }) => css !== null && /@media\b[^{]*\{/i.test(css),
  's4-linked': ({ html }) => {
    const tag = findTags(html, 'script').find((t) => localHref(t.attrs, 'script.js'));
    if (!tag) return false;
    if ('defer' in tag.attrs) return true;
    // Otherwise it must be the last thing before </body>.
    const bodyEnd = html.search(/<\/body\s*>/i);
    const rest = html.slice(tag.end, bodyEnd === -1 ? html.length : bodyEnd);
    return rest.replace(/<\/script\s*>/gi, '').replace(/<script\b[^>]*>\s*<\/script\s*>/gi, '').trim() === '';
  },
  's4-button': ({ html }) => findTags(html, 'button').length > 0,
  's4-listener': ({ js }) => js !== null && /\.addEventListener\s*\(/.test(js),
  's4-toggle': ({ js }) =>
    js !== null &&
    /\.classList\s*\.\s*toggle\s*\(/.test(js) &&
    /document\s*\.\s*(documentElement|body)\b|querySelector\s*\(\s*['"](html|body)['"]\s*\)/.test(js),
};

// ---------- step 5: network ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pagesUrl(opts) {
  if (opts.url) return opts.url;
  const repo = opts.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo || !repo.includes('/')) return null;
  const [owner, name] = repo.split('/');
  return `https://${owner.toLowerCase()}.github.io/${name}/`;
}

async function fetchWithRetries(url, retries, delay) {
  let last = { status: 0, body: '' };
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      last = { status: res.status, body: await res.text() };
      if (res.status === 200) return last;
    } catch {
      last = { status: 0, body: '' };
    }
    if (attempt < retries - 1) await sleep(delay);
  }
  return last;
}

async function runStep5(project, site, opts) {
  const step = project.steps.find((s) => s.id === 'step-5');
  const url = pagesUrl(opts);
  const pendingAll = () => step.checks.map((c) => ({ id: c.id, status: 'pending', message: 'Aguardando: o GitHub Pages ainda não está ativo para este repositório.' }));
  if (!url) return pendingAll();
  const { status, body } = await fetchWithRetries(url, opts.retries ?? 3, opts.delay ?? 5000);
  if (status === 404) return pendingAll();
  const localTitle = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(site.html)?.[1] ?? '').trim();
  const liveOk = status === 200;
  const titleOk = liveOk && localTitle !== '' && body.includes(localTitle);
  return [
    { id: 's5-live', passed: liveOk },
    { id: 's5-title', passed: titleOk },
  ].map((r) => ({ id: r.id, status: r.passed ? 'pass' : 'fail', message: r.passed ? 'ok' : formatFail(r.id) }));
}

// ---------- runner ----------

export function formatFail(id) {
  const m = MESSAGES[id];
  return `${m.missing} Revise a lição: "${m.topic}".`;
}

function summarize(checks) {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.length > 0 && checks.every((c) => c.status === 'pending')) return 'pending';
  return 'pass';
}

export async function runStep(project, stepId, dir, opts = {}) {
  const step = project.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`Unknown step: ${stepId}`);
  const site = loadSite(dir);
  let checks;
  if (stepId === 'step-5') {
    checks = await runStep5(project, site, opts);
  } else {
    checks = step.checks.map((c) => {
      const passed = STATIC_CHECKS[c.id](site);
      return { id: c.id, status: passed ? 'pass' : 'fail', message: passed ? 'ok' : formatFail(c.id) };
    });
  }
  return { id: stepId, status: summarize(checks), checks };
}

export async function runAll(project, dir, opts = {}) {
  const steps = [];
  for (const s of project.steps) steps.push(await runStep(project, s.id, dir, opts));
  return { steps };
}

export function loadProject() {
  return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'project.json'), 'utf8'));
}

function parseArgs(argv) {
  const o = { json: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--all') o.all = true;
    else if (a === '--probe') o.probe = true;
    else if (a === '--step') o.step = argv[++i];
    else if (a === '--dir') o.dir = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--url') o.url = argv[++i];
    else if (a === '--retries') o.retries = Number(argv[++i]);
    else if (a === '--delay') o.delay = Number(argv[++i]);
  }
  return o;
}

function printHuman(step, title) {
  const icon = { pass: 'OK', fail: 'FALHOU', pending: 'AGUARDANDO' };
  console.log(`${icon[step.status]}  ${step.id} - ${title}`);
  for (const c of step.checks) {
    if (c.status === 'pass') console.log(`   ok: ${c.id}`);
    else console.log(`   ${c.status === 'fail' ? 'x' : '...'} ${c.id}: ${c.message}`);
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.probe) {
    const url = pagesUrl(o);
    const res = url ? await fetchWithRetries(url, o.retries ?? 3, o.delay ?? 5000) : { status: 0 };
    console.log(`enabled=${res.status === 200}`);
    return;
  }
  if (!o.all && !o.step) {
    console.error('Usage: node checks/run.mjs --step step-N | --all [--json]');
    process.exit(2);
  }
  const project = loadProject();
  const dir = path.resolve(o.dir ?? process.cwd());
  const result = o.all
    ? await runAll(project, dir, o)
    : { steps: [await runStep(project, o.step, dir, o)] };
  if (o.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const s of result.steps) printHuman(s, project.steps.find((p) => p.id === s.id).title);
  }
  process.exit(result.steps.some((s) => s.status === 'fail') ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
