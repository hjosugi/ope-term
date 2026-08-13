#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SITE_URL = "https://hjosugi.github.io/ope-term/";

async function collectHtml(directory) {
  const pages = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) pages.push(...(await collectHtml(path)));
    else if (entry.name.endsWith(".html")) pages.push(path);
  }
  return pages;
}

function pageUrl(siteUrl, siteRoot, page) {
  const path = relative(siteRoot, page).split(sep).join("/").replace(/index\.html$/u, "");
  return new URL(path, siteUrl);
}

function htmlIds(html) {
  return new Set([...html.matchAll(/\sid=["']([^"']+)["']/gu)].map((match) => match[1]));
}

function htmlLinks(html) {
  return [...html.matchAll(/\shref=["']([^"']+)["']/gu)].map((match) => match[1]);
}

function markdownLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)].map((match) => match[1]);
}

async function resolveTarget(siteRoot, siteUrl, href, baseUrl) {
  if (/^(?:mailto|tel|javascript|data):/iu.test(href)) return undefined;
  const targetUrl = new URL(href, baseUrl);
  const rootUrl = new URL(siteUrl);
  if (targetUrl.origin !== rootUrl.origin || !targetUrl.pathname.startsWith(rootUrl.pathname)) {
    return undefined;
  }

  const relativeUrl = decodeURIComponent(targetUrl.pathname.slice(rootUrl.pathname.length));
  let path = resolve(siteRoot, relativeUrl);
  if ((await stat(path).catch(() => undefined))?.isDirectory()) path = join(path, "index.html");
  return { path, fragment: decodeURIComponent(targetUrl.hash.slice(1)) };
}

export async function verifyDocsPolicy({
  root = process.cwd(),
  siteUrl = DEFAULT_SITE_URL,
} = {}) {
  const siteRoot = resolve(root, "site");
  const pages = await collectHtml(siteRoot);
  const failures = [];
  let internalLinks = 0;

  async function verify(href, baseUrl, source) {
    const target = await resolveTarget(siteRoot, siteUrl, href, baseUrl).catch(() => undefined);
    if (!target) return;
    internalLinks += 1;
    try {
      await access(target.path);
    } catch {
      failures.push(`${source}: missing ${href}`);
      return;
    }
    if (!target.fragment || !target.path.endsWith(".html")) return;
    const targetHtml = await readFile(target.path, "utf8");
    if (!htmlIds(targetHtml).has(target.fragment)) {
      failures.push(`${source}: missing anchor ${href}`);
    }
  }

  for (const page of pages) {
    const html = await readFile(page, "utf8");
    const source = relative(root, page);
    for (const href of htmlLinks(html)) await verify(href, pageUrl(siteUrl, siteRoot, page), source);
  }

  const readme = await readFile(resolve(root, "README.md"), "utf8");
  for (const href of markdownLinks(readme)) {
    if (href.startsWith(siteUrl)) await verify(href, new URL(siteUrl), "README.md");
  }

  if (failures.length > 0) throw new Error(`documentation link policy failed:\n- ${failures.join("\n- ")}`);
  return { pages: pages.length, internalLinks };
}

async function main() {
  const result = await verifyDocsPolicy();
  console.log(`docs policy passed (${result.pages} pages; ${result.internalLinks} internal links)`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
