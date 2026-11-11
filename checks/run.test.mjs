import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runStep, runAll, loadProject, MESSAGES, stripJsComments } from './run.mjs';

const project = loadProject();

const HTML_1 = `<!DOCTYPE html>
<html lang="pt-BR"><head><title>Duda Demo</title></head>
<body><header><h1>Duda Demo</h1></header><main>MAIN2</main><footer>f</footer>SCRIPT</body></html>`;

const MAIN_2 = `<section id="about"><p>Oi, eu sou a Duda.</p></section>
<section id="projects"><ul><li><a href="https://example.com/a">A</a></li><li><a href="https://example.com/b">B</a></li></ul></section>
<img src="me.png" alt="Foto da Duda">`;

const CSS_3 = `main { display: flex; } a:hover { color: red; } @media (max-width: 600px) { main { display: block; } }`;
const JS_4 = `document.querySelector('button').addEventListener('click', () => document.body.classList.toggle('dark'));`;

function site(over = {}) {
  const f = {
    'index.html': HTML_1.replace('MAIN2', MAIN_2).replace('SCRIPT', '<button>Tema</button><script src="script.js"></script>')
      .replace('</head>', '<link rel="stylesheet" href="styles.css"></head>'),
    'styles.css': CSS_3,
    'script.js': JS_4,
    ...over,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itera-'));
  for (const [k, v] of Object.entries(f)) if (v !== null) fs.writeFileSync(path.join(dir, k), v);
  return dir;
}

const html = (dir) => fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const run = (id, dir, opts) => runStep(project, id, dir, opts);

test('step-1 passes on a valid skeleton', async () => {
  assert.equal((await run('step-1', site())).status, 'pass');
});
test('step-1 fails on the starter skeleton', async () => {
  const dir = site({ 'index.html': '<html><body></body></html>' });
  const r = await run('step-1', dir);
  assert.equal(r.status, 'fail');
  assert.equal(r.checks.filter((c) => c.status === 'fail').length, 5);
});
test('step-1 fails with two h1 elements', async () => {
  const dir = site({ 'index.html': html(site()).replace('<main>', '<main><h1>Outro</h1>') });
  const r = await run('step-1', dir);
  assert.equal(r.checks.find((c) => c.id === 's1-one-h1').status, 'fail');
});

test('step-2 passes with about, 2 project links and alt text', async () => {
  assert.equal((await run('step-2', site())).status, 'pass');
});
test('step-2 fails with empty alt and a single link', async () => {
  const bad = html(site()).replace('alt="Foto da Duda"', 'alt=""').replace('<li><a href="https://example.com/b">B</a></li>', '');
  const r = await run('step-2', site({ 'index.html': bad }));
  assert.equal(r.status, 'fail');
  assert.deepEqual(r.checks.filter((c) => c.status === 'fail').map((c) => c.id), ['s2-projects', 's2-img-alt']);
});
test('step-2 ignores markup inside HTML comments', async () => {
  const bad = html(site()).replace(MAIN_2, `<!-- ${MAIN_2} -->`);
  assert.equal((await run('step-2', site({ 'index.html': bad }))).status, 'fail');
});

test('step-3 passes with linked css, flex, hover and media', async () => {
  assert.equal((await run('step-3', site())).status, 'pass');
});
test('step-3 fails when the css is not linked or has only comments', async () => {
  const unlinked = html(site()).replace('<link rel="stylesheet" href="styles.css">', '');
  const r1 = await run('step-3', site({ 'index.html': unlinked }));
  assert.equal(r1.checks.find((c) => c.id === 's3-linked').status, 'fail');
  const r2 = await run('step-3', site({ 'styles.css': '/* display: flex; a:hover {} @media (x) {} */' }));
  assert.equal(r2.status, 'fail');
  assert.equal(r2.checks.filter((c) => c.status === 'fail').length, 4);
});

test('step-4 passes with deferred or end-of-body script', async () => {
  assert.equal((await run('step-4', site())).status, 'pass');
  const deferred = html(site()).replace('<script src="script.js"></script>', '').replace('</head>', '<script src="script.js" defer></script></head>');
  assert.equal((await run('step-4', site({ 'index.html': deferred }))).status, 'pass');
});
test('step-4 fails when script is in head without defer and js has no toggle', async () => {
  const early = html(site()).replace('<script src="script.js"></script>', '').replace('</head>', '<script src="script.js"></script></head>');
  const r = await run('step-4', site({ 'index.html': early, 'script.js': '// document.body.classList.toggle("x"); addEventListener(' }));
  assert.equal(r.status, 'fail');
  assert.equal(r.checks.filter((c) => c.status === 'fail').length, 3);
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

test('every check id has a message whose topic belongs to its step', () => {
  for (const s of project.steps) {
    for (const c of s.checks) {
      assert.ok(MESSAGES[c.id], c.id);
      assert.ok(s.lessonTopics.includes(MESSAGES[c.id].topic), `${c.id} -> ${MESSAGES[c.id].topic}`);
    }
  }
});
test('failure messages never contain code', async () => {
  const r = await runAll(project, site({ 'index.html': '', 'styles.css': '', 'script.js': '' }), { ...fast, url: 'http://127.0.0.1:1/' });
  for (const c of r.steps.flatMap((s) => s.checks).filter((c) => c.status === 'fail')) {
    assert.match(c.message, /Revise a lição: "/);
  }
});
