import { Browser, HTTPRequest, HTTPResponse, launch } from 'puppeteer';
import { minify } from 'html-minifier';
import postcss from 'postcss';
import postcssUrl from 'postcss-url';
import { URL } from 'url';
import { promises as fs } from 'fs';
import * as pathUtils from 'path';
import { getExtension, define as defineMime } from 'mime';
import escapeHTML from 'escape-html';
import fetch from 'node-fetch';
import zopfli from 'node-zopfli';
import { promisify } from 'util';
import { brotliCompress } from 'zlib';
import prettyBytes from 'pretty-bytes';

const zopfliGzip: (arg: Buffer) => Promise<Buffer> = promisify(zopfli.gzip);
const brotli = promisify(brotliCompress);

defineMime({ 'application/font-woff2': ['woff2'] }, true);

const DEBUG = false;

const mobileViewport = {
  width: 1080 / 3,
  height: 1920 / 3,
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
};

const ipadViewport = {
  width: 768,
  height: 1024,
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
};

const macbookProViewport = {
  width: 2560 / 2,
  height: 1600 / 2,
  deviceScaleFactor: 2,
  // Just to prevent reloading
  hasTouch: true,
  isMobile: true,
};

interface PageResources {
  request: HTTPRequest;
  response: HTTPResponse;
}

async function snapshotDomAfterLoad(
  browser: Browser,
  url: string,
): Promise<string> {
  const page = await browser.newPage();
  await page.setViewport(mobileViewport);
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.evaluate(async () => {
    for (const el of document.querySelectorAll(
      'iframe, script, link[rel=preload], img[src=""]',
    )) {
      el.remove();
    }

    const imgData = [
      ...(document.querySelectorAll('img') as NodeListOf<HTMLImageElement>),
    ].map(
      (el) =>
        [
          el,
          el.getBoundingClientRect(),
          // @ts-ignore
          el.computedStyleMap().get('height').value as string,
        ] as const,
    );
    for (const [el, rect, height] of imgData) {
      if (!el.hasAttribute('width') && height === 'auto') {
        el.width = el.naturalWidth;
        el.height = el.naturalHeight;
        el.decoding = 'async';
        el.style.height = 'auto';
      }

      if (
        rect.left > visualViewport.width ||
        rect.top > visualViewport.height
      ) {
        el.loading = 'lazy';
      }
    }

    // Remove any service workers
    for (const reg of await navigator.serviceWorker.getRegistrations()) {
      await reg.unregister();
    }
  });

  const content = await page.content();
  if (!DEBUG) page.close();
  return content;
}

async function removeHiddenElements(
  browser: Browser,
  source: string,
  url: string,
) {
  await fs.rm('out', { recursive: true });
  await fs.mkdir('out');
  const page = await browser.newPage();
  await page.setViewport(mobileViewport);

  // Intercept page request
  await page.setRequestInterception(true);
  page.on('request', (interceptedRequest: HTTPRequest) => {
    if (interceptedRequest.url() === url) {
      interceptedRequest.respond({
        status: 200,
        headers: {},
        contentType: 'text/html',
        body: source,
      });
      return;
    }
    interceptedRequest.continue();
  });

  await page.goto(url, { waitUntil: 'networkidle0' });

  page.evaluate(() => {
    const elementState = [...document.querySelectorAll('body *')].map((el) => {
      const styles = getComputedStyle(el);
      const box = el.getBoundingClientRect();

      return [
        el,
        {
          width: box.width,
          height: box.height,
          opacity: styles.opacity,
          visibility: styles.visibility,
          overflow: styles.overflow,
          display: styles.display,
        },
      ] as const;
    });

    for (const [
      el,
      { width, height, opacity, visibility, overflow, display },
    ] of elementState) {
      if (el.matches('style, source')) continue;
      const hidden =
        opacity === '0' ||
        display === 'none' ||
        visibility === 'hidden' ||
        (overflow === 'hidden' && (!width || !height));
      if (hidden) el.remove();
    }
  });

  const content = await page.content();
  if (!DEBUG) page.close();
  return content;
}

interface SizeReportResource {
  type: 'document' | 'stylesheet' | 'script';
  originalSize: number;
  zopfliSize: number;
  brotliSize: number;
}

interface SizeReport {
  resources: SizeReportResource[];
  combinedCSS: SizeReportResource;
  combinedJS: SizeReportResource;
}

async function sizeReport(browser: Browser, url: string): Promise<SizeReport> {
  const page = await browser.newPage();
  await page.setViewport(mobileViewport);
  const resources: PageResources[] = [];

  page.on('response', async (response: HTTPResponse) => {
    if (response.headers().location) return;
    const request = response.request();
    const originalRequest = request.redirectChain()[0] || request;
    const requestUrl = originalRequest.url();
    if (!new URL(requestUrl).protocol.startsWith('http')) return;
    resources.push({
      request: originalRequest,
      response,
    });
  });

  await page.goto(url, { waitUntil: 'load' });

  const types = ['document', 'stylesheet', 'script'] as const;
  const reportResources: SizeReportResource[] = [];
  let cssSizeReport: SizeReportResource;
  let jsSizeReport: SizeReportResource;

  await Promise.all([
    ...resources.map(async (entry) => {
      // @ts-ignore
      if (!types.includes(entry.request.resourceType())) return;

      const originalSize =
        Number(entry.response.headers()['content-length']) || Infinity;

      if (originalSize === Infinity) {
        console.log('No content length', entry.request.url());
      }

      const buffer = await entry.response.buffer();

      const [zopfliBuffer, brotliBuffer] = await Promise.all([
        zopfliGzip(buffer),
        brotli(buffer),
      ]);

      reportResources.push({
        type: entry.request.resourceType() as typeof types[number],
        brotliSize: brotliBuffer.byteLength,
        zopfliSize: zopfliBuffer.byteLength,
        originalSize,
      });
    }),
    ...(['script', 'stylesheet'] as const).map(async (type) => {
      const typedResources = resources.filter(
        (entry) => entry.request.resourceType() === type,
      );
      const buffers = await Promise.all(
        typedResources.map((r) => r.response.buffer()),
      );
      const sizes = typedResources.map(
        (entry) =>
          Number(entry.response.headers()['content-length']) || Infinity,
      );
      const originalSize = sizes.reduce((a, b) => a + b);
      const combined = Buffer.concat(buffers);
      const [zopfliBuffer, brotliBuffer] = await Promise.all([
        zopfliGzip(combined),
        brotli(combined),
      ]);

      const result: SizeReportResource = {
        type,
        brotliSize: brotliBuffer.byteLength,
        zopfliSize: zopfliBuffer.byteLength,
        originalSize,
      };

      if (type === 'stylesheet') {
        cssSizeReport = result;
      } else {
        jsSizeReport = result;
      }
    }),
  ]);

  return {
    combinedCSS: cssSizeReport!,
    combinedJS: jsSizeReport!,
    resources: reportResources,
  };
}

async function optimiseAndOutput(
  browser: Browser,
  source: string,
  url: string,
) {
  await fs.rm('out', { recursive: true });
  await fs.mkdir('out');
  const page = await browser.newPage();
  await page.setViewport(mobileViewport);

  // Intercept page request
  await page.setRequestInterception(true);

  page.on('request', async (interceptedRequest: HTTPRequest) => {
    if (interceptedRequest.url() === url) {
      interceptedRequest.respond({
        status: 200,
        headers: {},
        contentType: 'text/html',
        body: source,
      });
      return;
    }
    const parsedUrl = new URL(interceptedRequest.url());

    // Some woff2 fonts are served without a content-type, and devtools protocol messes that up.
    // https://bugs.chromium.org/p/chromium/issues/detail?id=1179646

    for (const fontType of ['woff', 'woff2']) {
      if (parsedUrl.pathname.endsWith(`.${fontType}`)) {
        const response = await fetch(parsedUrl);
        const buffer = await response.buffer();
        interceptedRequest.respond({
          body: buffer,
          headers: Object.fromEntries(response.headers.entries()),
          contentType: `font/${fontType}`,
          status: response.status,
        });
        return;
      }
    }
    interceptedRequest.continue();
  });

  // Capture requests to external CSS
  const resources: PageResources[] = [];

  page.on('response', async (response: HTTPResponse) => {
    if (response.headers().location) return;
    const request = response.request();
    const originalRequest = request.redirectChain()[0] || request;
    const requestUrl = originalRequest.url();
    if (requestUrl === url) return;
    if (!new URL(requestUrl).protocol.startsWith('http')) return;
    resources.push({
      request: originalRequest,
      response,
    });
  });

  await page.goto(url, { waitUntil: 'networkidle0' });

  // Rewrite URLs in external CSS
  const externalCSSSources = await Promise.all(
    resources
      .filter((entry) => entry.request.resourceType() === 'stylesheet')
      .map(
        async (cssEntry): Promise<[string, string]> => {
          return [
            cssEntry.request.url(),
            (
              await postcss([])
                .use(
                  // @ts-ignore - types are wrong it seems
                  postcssUrl({
                    url(asset) {
                      return new URL(asset.url, cssEntry.response.url()).href;
                    },
                  }),
                )
                .process((await cssEntry.response.buffer()).toString('utf8'), {
                  from: undefined,
                })
            ).css,
          ];
        },
      ),
  );

  // Get all inline <style></style> content
  const inlineCSS = await page.evaluate(() => {
    return [...document.querySelectorAll('style')].map((el) => el.textContent!);
  });

  // Process all URLs in inline CSS
  const processedInlineCSS = await Promise.all(
    inlineCSS.map(
      async (css) =>
        (
          await postcss([])
            .use(
              // @ts-ignore - types are wrong it seems
              postcssUrl({
                url(asset) {
                  return new URL(asset.url, url).href;
                },
              }),
            )
            .process(css, {
              from: undefined,
            })
        ).css,
    ),
  );

  await page.evaluate(
    (inlineStyles, externalCSSEntries) => {
      // Replace inline CSS
      for (const [i, style] of [
        ...document.querySelectorAll('style'),
      ].entries()) {
        style.textContent = inlineStyles[i];
      }

      // Replace external CSS with inline <style>
      for (const link of document.querySelectorAll(
        'link[rel=stylesheet]',
      ) as NodeListOf<HTMLLinkElement>) {
        const source = externalCSSEntries[link.href];
        const style = document.createElement('style');
        style.textContent = source;
        link.after(style);
        link.remove();
      }

      // Absolute URLs to img
      {
        const integerRegex = /^-?\d+$/;

        function deepUnique<T>(array: T[]) {
          return array.sort().filter((element, index) => {
            return JSON.stringify(element) !== JSON.stringify(array[index - 1]);
          });
        }

        type Result = { url?: string; width?: number; density?: number };

        const parseSrcset = (string: string) => {
          return deepUnique(
            string.split(/,\s+/).map((part) => {
              const result: Result = {};

              part
                .trim()
                .split(/\s+/)
                .forEach((element, index) => {
                  if (index === 0) {
                    result.url = element;
                    return;
                  }

                  const value = element.slice(0, -1);
                  const postfix = element[element.length - 1];
                  const integerValue = Number.parseInt(value, 10);
                  const floatValue = Number.parseFloat(value);

                  if (postfix === 'w' && integerRegex.test(value)) {
                    if (integerValue <= 0) {
                      throw new Error(
                        'Width descriptor must be greater than zero',
                      );
                    }

                    result.width = integerValue;
                  } else if (postfix === 'x' && !Number.isNaN(floatValue)) {
                    if (floatValue <= 0) {
                      throw new Error(
                        'Pixel density descriptor must be greater than zero',
                      );
                    }

                    result.density = floatValue;
                  } else {
                    throw new Error(`Invalid srcset descriptor: ${element}`);
                  }

                  if (result.width && result.density) {
                    throw new Error(
                      'Image candidate string cannot have both width descriptor and pixel density descriptor',
                    );
                  }
                });

              return result;
            }),
          );
        };

        const stringifySrcset = (array: Result[]) => {
          return [
            ...new Set(
              array.map((element) => {
                if (!element.url) {
                  throw new Error('URL is required');
                }

                const result = [element.url];

                if (element.width) {
                  result.push(`${element.width}w`);
                }

                if (element.density) {
                  result.push(`${element.density}x`);
                }

                return result.join(' ');
              }),
            ),
          ].join(', ');
        };

        for (const img of document.querySelectorAll('img')) {
          img.src = img.src;
        }
        for (const el of document.querySelectorAll('[srcset]') as NodeListOf<
          HTMLImageElement | HTMLSourceElement
        >) {
          el.srcset = stringifySrcset(
            parseSrcset(el.srcset).map((result) => ({
              ...result,
              url: new window.URL(result.url!, location.href).href,
            })),
          );
        }
      }

      // Remove redundant attributes
      for (const el of document.querySelectorAll('*')) {
        for (const attribute of [...el.attributes]) {
          const name = attribute.name.toLowerCase();
          if (
            name.startsWith('data-') ||
            name === 'contenteditable' ||
            (name === 'placeholder' && el.tagName !== 'INPUT') ||
            name === 'spellcheck'
          ) {
            el.removeAttributeNode(attribute);
          }
        }
      }

      // Absolute URLs in style attrs
      for (const el of document.querySelectorAll('[style]')) {
        el.setAttribute(
          'style',
          el
            .getAttribute('style')!
            .replace(
              /url\((['"]?)(.*?)\1\)/g,
              (_1: string, _2: string, match: string) =>
                `url("${new window.URL(match, location.href).href}")`,
            ),
        );
      }

      // Remove unused styles
      const tackleCSSGroup = (group: CSSGroupingRule | CSSStyleSheet) => {
        const indexesToDelete = [];
        for (const [i, rule] of [...group.cssRules].entries()) {
          if (rule instanceof CSSStyleRule) {
            const selector = rule.selectorText.replace(
              /::?(before|after)/g,
              '',
            );
            try {
              if (selector === '.rdt') console.log('seen');
              if (!document.querySelector(selector)) {
                indexesToDelete.push(i);
              }
            } catch (err) {
              console.warn(err);
            }
          } else if (rule instanceof CSSGroupingRule) {
            tackleCSSGroup(rule);
            if (rule.cssRules.length === 0) {
              indexesToDelete.push(i);
            }
          } else if (rule instanceof CSSImportRule) {
            // These seem to just be font api counters
            indexesToDelete.push(i);
          }
        }

        for (const index of indexesToDelete.slice().reverse()) {
          group.deleteRule(index);
        }
      };
      for (const styleSheet of [...document.styleSheets]) {
        tackleCSSGroup(styleSheet);
        const node = styleSheet.ownerNode!;
        node.textContent = [...styleSheet.cssRules]
          .map((r) => r.cssText)
          .join('');

        if (node.childNodes.length === 0) node.remove();
      }
    },
    processedInlineCSS,
    Object.fromEntries(externalCSSSources),
  );

  let optimizedSource = await page.content();
  const urlMap = await Promise.all(
    resources
      .filter(
        (resource) =>
          optimizedSource.includes(resource.request.url()) ||
          optimizedSource.includes(escapeHTML(resource.request.url())),
      )
      .map(async (resource, i) => {
        const url = resource.request.url();
        const contentType = resource.response.headers()['content-type'];
        const ext =
          getExtension(contentType) ||
          (/\.([a-zA-Z]\w{3,5})$/.exec(new URL(url).pathname) || [])[1];

        if (!ext) {
          console.warn(`Can't find extension for ${contentType} ${url}`);
          return [url, ''] as const;
        }
        const fileName = `${i}.${ext}`;

        try {
          await fs.writeFile(
            pathUtils.join('out', fileName),
            await resource.response.buffer(),
          );
        } catch (err) {
          console.warn(`Failed to write response from ${contentType} ${url}`);
          return [url, ''] as const;
        }
        return [url, fileName] as const;
      }),
  );

  for (const [from, to] of urlMap) {
    if (!to) continue;
    optimizedSource = optimizedSource.replaceAll(from, to);
    optimizedSource = optimizedSource.replaceAll(escapeHTML(from), to);
  }

  if (!DEBUG) {
    optimizedSource = minify(optimizedSource, {
      collapseBooleanAttributes: true,
      collapseWhitespace: true,
      decodeEntities: true,
      minifyCSS: true,
      removeAttributeQuotes: true,
      removeComments: true,
      useShortDoctype: true,
    });
  }

  await fs.writeFile(pathUtils.join('out', 'index.html'), optimizedSource);

  if (!DEBUG) page.close();

  return sizeReport;
}

(async () => {
  const browser = await launch({
    headless: !DEBUG,
  });

  //const url = 'https://www.astonmartinf1.com/en-GB/';
  //const url = 'https://www.mclaren.com/racing/';
  //const url = 'https://www.ferrari.com/en-EN/formula1';
  //const url = 'https://www.mercedesamgf1.com/en/';
  const url = 'https://www.scuderiaalphatauri.com/en/';
  //const url = 'https://www.redbull.com/int-en/redbullracing';
  //const url = 'https://www.haasf1team.com/';
  //const url = 'https://www.sauber-group.com/motorsport/formula-1/';
  //const url = 'https://www.alpinecars.com/en/formula-1/news/';
  //const url = 'https://www.williamsf1.com/';

  const justSizeReport = true;

  if (justSizeReport) {
    const report = await sizeReport(browser, url);
    const docs = report.resources.filter(
      (resource) => resource.type === 'document',
    );
    for (const doc of docs) {
      console.log('== Doc ==');
      console.log(
        'Original size',
        doc.originalSize === Infinity
          ? Infinity
          : prettyBytes(doc.originalSize),
      );
      console.log('Zopfli size', prettyBytes(doc.zopfliSize));
      console.log('Brotli size', prettyBytes(doc.brotliSize));
    }

    for (const type of ['stylesheet', 'script'] as const) {
      const resources = report.resources.filter(
        (resource) => resource.type === type,
      );
      const originalSize = resources
        .map((r) => r.originalSize)
        .reduce((a, b) => (b === Infinity ? a : a + b), 0);
      const zopfliSize = resources
        .map((r) => r.zopfliSize)
        .reduce((a, b) => a + b);
      const brotliSize = resources
        .map((r) => r.brotliSize)
        .reduce((a, b) => a + b);
      const combo =
        type === 'stylesheet' ? report.combinedCSS : report.combinedJS;

      console.log(type === 'stylesheet' ? '== Styles ==' : '== Script ==');
      console.log(resources.length, 'resources');
      console.log('Separate');
      console.log(
        'Original size',
        originalSize === Infinity ? Infinity : prettyBytes(originalSize),
      );
      console.log('Zopfli size', prettyBytes(zopfliSize));
      console.log('Brotli size', prettyBytes(brotliSize));
      console.log('Combined');
      console.log('Zopfli size', prettyBytes(combo.zopfliSize));
      console.log('Brotli size', prettyBytes(combo.brotliSize));
    }
  } else {
    let source = await snapshotDomAfterLoad(browser, url);
    source = await removeHiddenElements(browser, source, url);
    await optimiseAndOutput(browser, source, url);
  }

  if (!DEBUG) browser.close();
})();
