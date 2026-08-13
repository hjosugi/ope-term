import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyDocsPolicy } from "./docs-policy.mjs";

async function fixture(indexLink) {
  const root = await mkdtemp(join(tmpdir(), "ope-term-docs-"));
  await Promise.all([
    mkdir(join(root, "site/guide"), { recursive: true }),
    mkdir(join(root, "site/assets"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "site/index.html"), `<a href="${indexLink}">Guide</a><img src="assets/logo.svg">`),
    writeFile(join(root, "site/guide/index.html"), '<h1 id="start">Start</h1><a href="../">Home</a>'),
    writeFile(join(root, "site/assets/logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    writeFile(
      join(root, "README.md"),
      '[Home](https://example.test/project/) [Guide](https://example.test/project/guide/#start)',
    ),
  ]);
  return root;
}

test("accepts generated pages, relative links, README URLs, and anchors", async (t) => {
  const root = await fixture("guide/#start");
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await verifyDocsPolicy({ root, siteUrl: "https://example.test/project/" });
  assert.equal(result.pages, 2);
  assert.equal(result.internalLinks, 5);
});

test("rejects missing generated assets and malformed internal URLs", async (t) => {
  const root = await fixture("guide/#start");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "site/index.html"),
    '<img src="missing.svg"><a href="%zz">Malformed</a>',
  );
  await assert.rejects(
    () => verifyDocsPolicy({ root, siteUrl: "https://example.test/project/" }),
    /missing missing\.svg[\s\S]*invalid %zz/u,
  );
});

test("rejects missing generated targets", async (t) => {
  const root = await fixture("missing/");
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => verifyDocsPolicy({ root, siteUrl: "https://example.test/project/" }),
    /missing missing\//,
  );
});

test("rejects generated pages omitted from the README index", async (t) => {
  const root = await fixture("guide/#start");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "README.md"), '[Home](https://example.test/project/)');
  await assert.rejects(
    () => verifyDocsPolicy({ root, siteUrl: "https://example.test/project/" }),
    /README\.md: missing public page link https:\/\/example\.test\/project\/guide\//u,
  );
});
