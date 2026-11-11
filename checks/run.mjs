#!/usr/bin/env node
// Deterministic checks for the Itera portfolio project. Node built-ins only.
//
// Usage:
//   node checks/run.mjs --step step-2
//   node checks/run.mjs --all --json   (the machine-readable result the Itera page reads)
//   node checks/run.mjs --all --markdown   (a short summary for the Actions page)
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
// - Step 4 "reacts" is detected by a text swap (textContent / innerText / innerHTML) or a
//   classList toggle / add / remove call; we do not execute JS.
// - Every check only requires what a linked Itera lesson teaches. The check -> lesson map lives
//   in ../project.json, the single source of truth (the Itera page keeps a copy and tests it).
// - Step 5 needs the network. 404 means Pages is not live yet and is reported "pending".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

const CSS_NAMES = ['style.css', 'styles.css'];

function linkedCssName(html) {
  for (const t of findTags(html, 'link')) {
    if (!/\bstylesheet\b/i.test(t.attrs.rel ?? '')) continue;
    const name = CSS_NAMES.find((n) => localHref(t.attrs, n));
    if (name) return name;
  }
  return null;
}

function loadSite(dir) {
  const rawHtml = readFileSafe(dir, 'index.html');
  const html = rawHtml === null ? '' : stripHtmlComments(rawHtml);
  const linked = linkedCssName(html);
  // The lessons call the file style.css; styles.css is accepted too. Read the linked one first.
  const cssName = linked ?? CSS_NAMES.find((n) => readFileSafe(dir, n) !== null) ?? null;
  const rawCss = cssName ? readFileSafe(dir, cssName) : null;
  const js = readFileSafe(dir, 'script.js');
  return {
    html,
    css: rawCss === null ? null : stripCssComments(rawCss),
    cssLinked: linked !== null,
    js: js === null ? null : stripJsComments(js),
  };
}

// ---------- static checks: id -> (site) => boolean ----------

const hasDecl = (css, re) => css !== null && re.test(css);

export const STATIC_CHECKS = {
  's1-doctype': ({ html }) => /^\s*<!doctype\s+html\s*>/i.test(html),
  's1-lang': ({ html }) => findTags(html, 'html').some((t) => (t.attrs.lang ?? '').trim() !== ''),
  's1-title': ({ html }) => /<title[^>]*>\s*\S[\s\S]*?<\/title>/i.test(html),
  's1-landmarks': ({ html }) => ['header', 'main', 'footer'].every((n) => findTags(html, n).length > 0),
  's1-one-h1': ({ html }) => {
    const h1s = html.match(/<h1(?=[\s>])[^>]*>[\s\S]*?<\/h1>/gi) ?? [];
    return h1s.length === 1 && textOf(h1s[0]) !== '';
  },
  's2-section': ({ html }) => /<section(?=[\s>])[^>]*>[\s\S]*?<h2(?=[\s>])[^>]*>[\s\S]*?<\/h2>/i.test(html),
  's2-list': ({ html }) =>
    (html.match(/<(ul|ol)(?=[\s>])[^>]*>[\s\S]*?<\/\1>/gi) ?? []).some((list) => findTags(list, 'li').length >= 2),
  's2-link': ({ html }) =>
    findTags(html, 'a').some((t) => {
      const href = (t.attrs.href ?? '').trim();
      return href !== '' && href !== '#';
    }),
  // alt="" is correct for a decorative image (the lessons teach it); only a missing alt fails.
  's2-img': ({ html }) => {
    const imgs = findTags(html, 'img');
    return imgs.length > 0 && imgs.every((t) => (t.attrs.src ?? '').trim() !== '' && 'alt' in t.attrs);
  },
  's3-linked': (site) => site.cssLinked && site.css !== null && site.css.trim() !== '',
  's3-color': ({ css }) => hasDecl(css, /(^|[;{\s])(background-color|color)\s*:\s*[^;}\s]/i),
  's3-spacing': ({ css }) => hasDecl(css, /(^|[;{\s])(padding|margin)(-[a-z]+)?\s*:\s*[^;}\s]/i),
  's3-flex': ({ css }) => hasDecl(css, /display\s*:\s*(inline-)?flex\b/i),
  's3-media': ({ css }) => hasDecl(css, /@media\b[^{]*\{/i),
  's4-linked': ({ html }) => {
    const tag = findTags(html, 'script').find((t) => localHref(t.attrs, 'script.js'));
    if (!tag) return false;
    // A module script is deferred by the browser, so it is safe in the head too.
    if ('defer' in tag.attrs || (tag.attrs.type ?? '').toLowerCase() === 'module') return true;
    // Otherwise it must be the last thing before </body>.
    const bodyEnd = html.search(/<\/body\s*>/i);
    const rest = html.slice(tag.end, bodyEnd === -1 ? html.length : bodyEnd);
    return rest.replace(/<\/script\s*>/gi, '').replace(/<script\b[^>]*>\s*<\/script\s*>/gi, '').trim() === '';
  },
  's4-button': ({ html }) => findTags(html, 'button').length > 0,
  's4-listener': ({ js }) => js !== null && /\.addEventListener\s*\(/.test(js),
  's4-reacts': ({ js }) =>
    js !== null &&
    (/\.(textContent|innerText|innerHTML)\s*(\+)?=(?!=)/.test(js) || /\.classList\s*\.\s*(toggle|add|remove)\s*\(/.test(js)),
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
  const failed = (id) => formatFail(project, id);
  if (!url) return pendingAll();
  const { status, body } = await fetchWithRetries(url, opts.retries ?? 3, opts.delay ?? 5000);
  if (status === 404) return pendingAll();
  const localTitle = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(site.html)?.[1] ?? '').trim();
  const liveOk = status === 200;
  const titleOk = liveOk && localTitle !== '' && body.includes(localTitle);
  return [
    { id: 's5-live', passed: liveOk },
    { id: 's5-title', passed: titleOk },
  ].map((r) => ({ id: r.id, status: r.passed ? 'pass' : 'fail', message: r.passed ? 'ok' : failed(r.id) }));
}

// ---------- runner ----------

export function findCheck(project, id) {
  for (const step of project.steps) {
    const check = step.checks.find((c) => c.id === id);
    if (check) return check;
  }
  throw new Error(`Unknown check: ${id}`);
}

export function lessonUrl(project, lesson) {
  return `${project.lessonUrlBase}${lesson.id}`;
}

// Plain message stored in the result file. The page adds the lesson link from project.json.
export function formatFail(project, id) {
  return findCheck(project, id).missing;
}

// Console line: what is missing plus the real lesson title and link.
export function describeFail(project, id) {
  const check = findCheck(project, id);
  return `${check.missing}\n      Revise a lição "${check.lesson.title}": ${lessonUrl(project, check.lesson)}`;
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
      return { id: c.id, status: passed ? 'pass' : 'fail', message: passed ? 'ok' : formatFail(project, c.id) };
    });
  }
  const withLesson = checks.map((c) => ({ ...c, lessonId: findCheck(project, c.id).lesson.id }));
  return { id: stepId, status: summarize(withLesson), checks: withLesson };
}

export async function runAll(project, dir, opts = {}) {
  const steps = [];
  for (const s of project.steps) steps.push(await runStep(project, s.id, dir, opts));
  return { steps };
}

export function loadProject() {
  return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'project.json'), 'utf8'));
}

// The file the Itera page reads (no token needed). Plain data only: no secrets, no repo contents.
export function buildResult(project, steps, env = process.env, now = new Date()) {
  return {
    version: 1,
    project: project.id,
    runId: env.GITHUB_RUN_ID ? Number(env.GITHUB_RUN_ID) : null,
    sha: env.GITHUB_SHA ?? null,
    finishedAt: now.toISOString(),
    steps,
  };
}

export function toMarkdown(project, result) {
  const lines = ['## Itera checks', ''];
  const icon = { pass: 'OK', fail: 'FALHOU', pending: 'AGUARDANDO' };
  for (const s of result.steps) {
    lines.push(`- **${icon[s.status]}** ${s.id} - ${project.steps.find((p) => p.id === s.id).title}`);
    for (const c of s.checks.filter((x) => x.status === 'fail')) {
      const lesson = findCheck(project, c.id).lesson;
      lines.push(`  - ${c.message} Revise a lição [${lesson.title}](${lessonUrl(project, lesson)}).`);
    }
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const o = { json: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--all') o.all = true;
    else if (a === '--markdown') o.markdown = true;
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

function printHuman(project, step, title) {
  const icon = { pass: 'OK', fail: 'FALHOU', pending: 'AGUARDANDO' };
  console.log(`${icon[step.status]}  ${step.id} - ${title}`);
  for (const c of step.checks) {
    if (c.status === 'pass') console.log(`   ok: ${c.id}`);
    else console.log(`   ${c.status === 'fail' ? 'x' : '...'} ${c.id}: ${c.status === 'fail' ? describeFail(project, c.id) : c.message}`);
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
    console.error('Usage: node checks/run.mjs --step step-N | --all [--json|--markdown]');
    process.exit(2);
  }
  const project = loadProject();
  const dir = path.resolve(o.dir ?? process.cwd());
  const steps = o.all ? (await runAll(project, dir, o)).steps : [await runStep(project, o.step, dir, o)];
  const result = buildResult(project, steps);
  if (o.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (o.markdown) {
    console.log(toMarkdown(project, result));
  } else {
    for (const s of result.steps) printHuman(project, s, project.steps.find((p) => p.id === s.id).title);
  }
  process.exit(result.steps.some((s) => s.status === 'fail') ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
