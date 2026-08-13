import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyDocsPolicy } from "./docs-policy.mjs";

async function fixture(indexLink) {
  const root = await mkdtemp(join(tmpdir(), "ope-term-docs-"));
  await mkdir(join(root, "site/guide"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "site/index.html"), `<a href="${indexLink}">Guide</a>`),
    writeFile(join(root, "site/guide/index.html"), '<h1 id="start">Start</h1><a href="../">Home</a>'),
    writeFile(join(root, "README.md"), '[Guide](https://example.test/project/guide/#start)'),
  ]);
  return root;
}

test("accepts generated pages, relative links, README URLs, and anchors", async (t) => {
  const root = await fixture("guide/#start");
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await verifyDocsPolicy({ root, siteUrl: "https://example.test/project/" });
  assert.equal(result.pages, 2);
  assert.equal(result.internalLinks, 3);
});

test("rejects missing generated targets", async (t) => {
  const root = await fixture("missing/");
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => verifyDocsPolicy({ root, siteUrl: "https://example.test/project/" }),
    /missing missing\//,
  );
});
