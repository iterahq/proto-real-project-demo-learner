import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runStep, runAll, loadProject, stripJsComments, STATIC_CHECKS, describeFail, toMarkdown, buildResult } from './run.mjs';

const project = loadProject();

const HTML_1 = `<!DOCTYPE html>
<html lang="pt-BR"><head><title>Duda Demo</title><link rel="stylesheet" href="style.css"></head>
<body><header><h1>Duda Demo</h1></header><main>MAIN2</main><footer>f</footer>SCRIPT</body></html>`;

const MAIN_2 = `<section id="about"><h2>Sobre mim</h2><p>Oi, eu sou a Duda.</p>
<ul><li>Aprender HTML</li><li><a href="https://example.com/a">Meu projeto</a></li></ul>
<img src="me.png" alt="Foto da Duda"></section>`;

const CSS_3 = `body { color: #222; } main { display: flex; padding: 8px; } @media (max-width: 600px) { main { display: block; } }`;
const JS_4 = `document.querySelector('button').addEventListener('click', () => document.body.classList.toggle('dark'));`;

function site(over = {}) {
  const f = {
    'index.html': HTML_1.replace('MAIN2', MAIN_2).replace('SCRIPT', '<button>Tema</button><script src="script.js"></script>'),
    'style.css': CSS_3,
    'script.js': JS_4,
    ...over,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itera-'));
  for (const [k, v] of Object.entries(f)) if (v !== null) fs.writeFileSync(path.join(dir, k), v);
  return dir;
}

const html = (dir) => fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const run = (id, dir, opts) => runStep(project, id, dir, opts);
const failedIds = (r) => r.checks.filter((c) => c.status === 'fail').map((c) => c.id);

test('step-1 passes on a valid skeleton', async () => {
  assert.equal((await run('step-1', site())).status, 'pass');
});
test('step-1 fails on the starter skeleton', async () => {
  const dir = site({ 'index.html': '<html><body></body></html>' });
  const r = await run('step-1', dir);
  assert.equal(r.status, 'fail');
  assert.equal(failedIds(r).length, 5);
});
test('step-1 fails with two h1 elements', async () => {
  const dir = site({ 'index.html': html(site()).replace('<main>', '<main><h1>Outro</h1>') });
  assert.deepEqual(failedIds(await run('step-1', dir)), ['s1-one-h1']);
});

test('step-2 passes with section, list, link and image', async () => {
  assert.equal((await run('step-2', site())).status, 'pass');
});
test('step-2 accepts alt="" on a decorative image', async () => {
  const dir = site({ 'index.html': html(site()).replace('alt="Foto da Duda"', 'alt=""') });
  assert.equal((await run('step-2', dir)).status, 'pass');
});
test('step-2 rejects an image with no alt, a one-item list and a link to nowhere', async () => {
  const bad = html(site())
    .replace(' alt="Foto da Duda"', '')
    .replace('<li><a href="https://example.com/a">Meu projeto</a></li>', '')
    .replace('<h2>Sobre mim</h2>', '');
  const r = await run('step-2', site({ 'index.html': bad }));
  assert.deepEqual(failedIds(r), ['s2-section', 's2-list', 's2-link', 's2-img']);
});
test('step-2 does not require specific ids', async () => {
  const dir = site({ 'index.html': html(site()).replace(' id="about"', '') });
  assert.equal((await run('step-2', dir)).status, 'pass');
});
test('step-2 ignores markup inside HTML comments', async () => {
  const bad = html(site()).replace(MAIN_2, `<!-- ${MAIN_2} -->`);
  assert.equal((await run('step-2', site({ 'index.html': bad }))).status, 'fail');
});

test('step-3 passes with linked css, color, spacing, flex and media', async () => {
  assert.equal((await run('step-3', site())).status, 'pass');
});
test('step-3 does not require :hover or grid', async () => {
  assert.equal((await run('step-3', site({ 'style.css': CSS_3 }))).status, 'pass');
  assert.ok(!JSON.stringify(project).includes('hover'));
});
test('step-3 accepts styles.css too', async () => {
  const dir = site({ 'style.css': null, 'styles.css': CSS_3, 'index.html': html(site()).replace('style.css', 'styles.css') });
  assert.equal((await run('step-3', dir)).status, 'pass');
});
test('step-3 fails when the css is not linked or has only comments', async () => {
  const unlinked = html(site()).replace('<link rel="stylesheet" href="style.css">', '');
  const r1 = await run('step-3', site({ 'index.html': unlinked }));
  assert.deepEqual(failedIds(r1), ['s3-linked']);
  const r2 = await run('step-3', site({ 'style.css': '/* color: red; padding: 1px; display: flex; @media (x) {} */' }));
  assert.equal(r2.status, 'fail');
  assert.equal(failedIds(r2).length, 5);
});

test('step-4 passes with deferred, module or end-of-body script', async () => {
  assert.equal((await run('step-4', site())).status, 'pass');
  const deferred = html(site()).replace('<script src="script.js"></script>', '').replace('</head>', '<script src="script.js" defer></script></head>');
  assert.equal((await run('step-4', site({ 'index.html': deferred }))).status, 'pass');
  const module = html(site()).replace('<script src="script.js"></script>', '').replace('</head>', '<script type="module" src="script.js"></script></head>');
  assert.equal((await run('step-4', site({ 'index.html': module }))).status, 'pass');
});
test('step-4 accepts a text swap, which the lessons teach', async () => {
  const js = `const b = document.querySelector('button'); b.addEventListener('click', () => { document.querySelector('h1').textContent = 'Oi!'; });`;
  assert.equal((await run('step-4', site({ 'script.js': js }))).status, 'pass');
});
test('step-4 fails when script is in head without defer and js does nothing', async () => {
  const early = html(site()).replace('<script src="script.js"></script>', '').replace('</head>', '<script src="script.js"></script></head>');
  const r = await run('step-4', site({ 'index.html': early, 'script.js': '// document.body.classList.toggle("x"); addEventListener(' }));
  assert.equal(r.status, 'fail');
  assert.deepEqual(failedIds(r), ['s4-linked', 's4-listener', 's4-reacts']);
});
test('step-4 does not count a comparison as a text swap', async () => {
  const js = `document.querySelector('button').addEventListener('click', () => { if (a.textContent === 'x') {} });`;
  assert.deepEqual(failedIds(await run('step-4', site({ 'script.js': js }))), ['s4-reacts']);
});

test('js comment stripper keeps strings that look like comments', () => {
  assert.equal(stripJsComments('a("//x"); // gone\nb();'), 'a("//x"); \nb();');
});

function serve(status, body) {
  return new Promise((resolve) => {
    const srv = http.createServer((_, res) => { res.statusCode = status; res.end(body); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` }));
  });
}
const fast = { retries: 2, delay: 10 };

test('step-5 passes when the live page has the title', async () => {
  const { srv, url } = await serve(200, '<title>Duda Demo</title>');
  const r = await run('step-5', site(), { ...fast, url });
  srv.close();
  assert.equal(r.status, 'pass');
});
test('step-5 fails when the live page lacks the title', async () => {
  const { srv, url } = await serve(200, '<title>Velho</title>');
  const r = await run('step-5', site(), { ...fast, url });
  srv.close();
  assert.equal(r.status, 'fail');
  assert.equal(r.checks.find((c) => c.id === 's5-title').status, 'fail');
});
test('step-5 is pending on 404 and when the repo is unknown', async () => {
  const { srv, url } = await serve(404, 'nope');
  assert.equal((await run('step-5', site(), { ...fast, url })).status, 'pending');
  srv.close();
  delete process.env.GITHUB_REPOSITORY;
  assert.equal((await run('step-5', site(), fast)).status, 'pending');
});

test('project.json is complete and every check has a real lesson', () => {
  const ids = new Set();
  assert.deepEqual(project.steps.map((s) => s.id), ['step-1', 'step-2', 'step-3', 'step-4', 'step-5']);
  for (const s of project.steps) {
    for (const c of s.checks) {
      assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
      ids.add(c.id);
      assert.ok(c.id.startsWith(`s${s.id.slice(-1)}-`), c.id);
      assert.ok(s.id === 'step-5' || STATIC_CHECKS[c.id], `no check function for ${c.id}`);
      assert.ok(c.missing && c.description, c.id);
      assert.match(c.lesson.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.ok(c.lesson.title, c.id);
    }
  }
  for (const id of Object.keys(STATIC_CHECKS)) assert.ok(ids.has(id), `${id} is not in project.json`);
});
test('a failed check names its real lesson with a link', async () => {
  const r = await run('step-3', site({ 'style.css': 'p {}' }));
  const flex = r.checks.find((c) => c.id === 's3-flex');
  assert.equal(flex.lessonId, 'a8f83a33-2b53-4ca9-a89c-2cf8cfbdc9bb');
  const text = describeFail(project, 's3-flex');
  assert.match(text, /Revise a lição "Menu em fila com flex": https:\/\/app\.iterahq\.dev\/lesson\/a8f83a33-2b53-4ca9-a89c-2cf8cfbdc9bb/);
  assert.ok(!/classes no DOM/.test(JSON.stringify(project)));
});
test('markdown summary lists each failed check with its lesson link, and the result file is plain data', async () => {
  const result = buildResult(project, (await runAll(project, site({ 'style.css': 'p {}' }), { retries: 1, delay: 1, url: 'http://127.0.0.1:1/' })).steps, { GITHUB_RUN_ID: '42', GITHUB_SHA: 'abc' });
  assert.equal(result.runId, 42);
  assert.equal(result.version, 1);
  const md = toMarkdown(project, result);
  assert.match(md, /\[Regras só pro celular\]\(https:\/\/app\.iterahq\.dev\/lesson\/2da4ad47/);
  assert.ok(!md.includes('{'));
});
test('failure messages never contain code blocks', async () => {
  const r = await runAll(project, site({ 'index.html': '', 'style.css': '', 'script.js': '' }), { ...fast, url: 'http://127.0.0.1:1/' });
  for (const c of r.steps.flatMap((s) => s.checks).filter((c) => c.status === 'fail')) {
    assert.ok(c.message.length > 10 && !c.message.includes('```'));
  }
});
