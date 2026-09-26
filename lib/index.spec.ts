import assert from "node:assert/strict";
import {
  describe,
  it,
  before,
  after,
  beforeEach,
  afterEach
} from "mocha";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdtemp,
  mkdir,
  writeFile,
  realpath,
  rm,
  chmod
} from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import express from "express";
import * as es6DebugServer from "es6-debug-server";
import type { TCodeAnalyzeFunc } from "es6-debug-server";
import {
  expressRouter,
  defaultResolveImportPath,
  defaultDetermineFileTypeByPath,
  defaultCodeAnalyzer
} from "./index.ts";
import type { TResolveImportPathFunc } from "./index.ts";

type TRouterOptions = Partial<Parameters<typeof expressRouter>[0]>;
type TMount = (args: { app: express.Express, router: express.Router }) => void;

interface IHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface IFinalResponse extends IHttpResponse {
  // path of the request that produced this response, after following all redirects
  path: string;
  redirects: string[];
}

interface IRunningServer {
  port: number;
  close: () => Promise<void>;
}

const MAX_REDIRECTS = 5;

const fixtureFiles: Record<string, string> = {
  "index.html": "<!doctype html><title>wurzel fixture</title>\n",
  "plain.js": "export const plain = \"plain\";\n",
  "plain.mjs": "export const plainModule = \"plain module\";\n",
  "typed.ts": "const typed: number = 42;\nexport { typed };\n",
  "typed.mts": "const typed: number = 42;\nexport { typed };\n",
  "typed.cts": "const typed: number = 42;\nexport { typed };\n",
  "custom.es": "const custom: string = \"custom\";\nexport { custom };\n",
  "main.js": "import { helper } from \"./lib/helper.ts\";\nimport { pkg } from \"fixture-pkg\";\nexport const main = [helper, pkg];\n",
  "lib/helper.ts": "import { shared } from \"../shared.js\";\nexport const helper = (value: string): string => `${shared}:${value}`;\n",
  "shared.js": "export const shared = \"shared\";\n",
  "deep/er/leaf.ts": "import { shared } from \"../../shared.js\";\nexport const leaf: string = shared;\n",
  "node_modules/fixture-pkg/package.json": JSON.stringify({
    name: "fixture-pkg",
    type: "module",
    exports: {
      ".": "./index.js",
      "./sub.js": "./sub.js"
    }
  }),
  "node_modules/fixture-pkg/index.js": "export const pkg = \"pkg\";\n",
  "node_modules/fixture-pkg/sub.js": "export const sub = \"sub\";\n",
  "same-a.js": "export const same = \"same\";\n",
  "same-b.js": "export const same = \"same\";\n",
  "broken.ts": "const = ;\n",
  "enum.ts": "enum Color { Red }\nexport { Color };\n",
  "imports-builtin.js": "import fs from \"node:fs\";\nexport { fs };\n",
  "imports-missing.js": "import missing from \"not-installed-anywhere\";\nexport { missing };\n",
  "imports-virtual.js": "import { virtual } from \"virtual:thing\";\nexport const usesVirtual = virtual;\n",
  "virtual/thing.js": "export const virtual = \"virtual\";\n",
  "sub dir/spaced.js": "export const spaced = \"spaced\";\n",
  "sub dir/100% #1.js": "export const special = \"special\";\n",
  "unreadable.js": "export const unreadable = \"unreadable\";\n"
};

const createFixture = async ({ namePrefix, files }: { namePrefix: string, files: Record<string, string> }) => {
  const root = await realpath(await mkdtemp(nodePath.join(os.tmpdir(), namePrefix)));

  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const filePath = nodePath.join(root, relativePath);
    await mkdir(nodePath.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }));

  return root;
};

const listen = async ({ listener }: { listener: http.RequestListener }): Promise<IRunningServer> => {
  const server = http.createServer(listener);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;

  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        return err === undefined ? resolve() : reject(err);
      });
    });
  };

  return { port, close };
};

const mountAtRoot: TMount = ({ app, router }) => {
  app.use("/", router);
};

const startWurzel = ({ baseFolder, options = {}, mount = mountAtRoot }: {
  baseFolder: string,
  options?: TRouterOptions,
  mount?: TMount
}) => {
  const app = express();
  mount({ app, router: expressRouter({ express, baseFolder, ...options }) });
  return listen({ listener: app });
};

// forwards everything below `prefix` to the target with the prefix stripped, like a reverse proxy
// would, without rewriting any response headers
const startPrefixStrippingProxy = ({ prefix, targetPort }: { prefix: string, targetPort: number }) => {
  // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
  const listener: http.RequestListener = (req, res) => {
    const url = req.url ?? "";

    if (!url.startsWith(`${prefix}/`)) {
      res.writeHead(404).end("not proxied");
      return;
    }

    const upstream = http.request({
      host: "127.0.0.1",
      port: targetPort,
      path: url.substring(prefix.length),
      method: req.method,
      headers: req.headers,
      agent: false
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    upstream.on("error", () => {
      res.writeHead(502).end("bad gateway");
    });

    req.pipe(upstream);
  };

  return listen({ listener });
};

// uses the path verbatim, so that requests can contain things a URL parser would normalize away
const sendRequest = ({ port, path, method = "GET" }: { port: number, path: string, method?: string }) => {
  return new Promise<IHttpResponse>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });

    req.on("error", reject);
    req.end();
  });
};

// resolves a reference (redirect location or import specifier) the way a browser would
const resolveReference = ({ reference, base }: { reference: string, base: string }) => {
  const origin = "http://wurzel.test";
  const url = new URL(reference, `${origin}${base}`);
  assert.strictEqual(url.origin, origin, `"${reference}" resolved from "${base}" leaves the server`);
  return `${url.pathname}${url.search}`;
};

const isRedirect = ({ status }: { status: number }) => {
  return status >= 300 && status < 400;
};

const requestFollowingRedirects = async ({ port, path, redirects = [] }: {
  port: number,
  path: string,
  redirects?: string[]
}): Promise<IFinalResponse> => {
  const response = await sendRequest({ port, path });
  const { location } = response.headers;

  if (!isRedirect(response)) {
    return { ...response, path, redirects };
  }

  assert.ok(location !== undefined, `redirect for "${path}" has no location`);
  assert.ok(redirects.length < MAX_REDIRECTS, `too many redirects for "${path}"`);

  return requestFollowingRedirects({
    port,
    path: resolveReference({ reference: location, base: path }),
    redirects: [...redirects, location]
  });
};

const assertServesJavaScript = ({ response }: { response: IFinalResponse }) => {
  assert.strictEqual(response.status, 200, `"${response.path}" answered with ${response.status}: ${response.body}`);
  assert.match(response.headers["content-type"] ?? "", /^text\/javascript\b/u);
};

const importSpecifiersOf = ({ code }: { code: string }) => {
  return [...code.matchAll(/\bfrom\s*"([^"]+)"/gu)].map((match) => {
    return match[1];
  });
};

const exportedNamesOf = ({ modules }: { modules: Map<string, string> }) => {
  return [...modules.values()].flatMap((code) => {
    return [...code.matchAll(/\bexport const (\w+)/gu)].map((match) => {
      return match[1];
    });
  }).toSorted();
};

// loads a module and everything it imports like a browser would, keyed by the path each module was served from
const loadModuleGraph = async ({ port, entryPath }: { port: number, entryPath: string }) => {
  const modules = new Map<string, string>();

  const load = async ({ path }: { path: string }): Promise<void> => {
    const response = await requestFollowingRedirects({ port, path });
    assertServesJavaScript({ response });

    if (modules.has(response.path)) {
      return;
    }

    modules.set(response.path, response.body);

    await Promise.all(importSpecifiersOf({ code: response.body }).map((specifier) => {
      assert.match(specifier, /^\.{0,2}\//u, `browsers cannot load the bare specifier "${specifier}" in "${response.path}"`);
      return load({ path: resolveReference({ reference: specifier, base: response.path }) });
    }));
  };

  await load({ path: entryPath });

  return modules;
};

const importServedModule = ({ code }: { code: string }) => {
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
};

const countingAnalyzer = () => {
  let calls = 0;

  const analyzeCode: TCodeAnalyzeFunc = (args) => {
    calls += 1;
    return defaultCodeAnalyzer(args);
  };

  return {
    analyzeCode,
    callCount: () => {
      return calls;
    }
  };
};

// errors of failing requests are logged by the router, keep them out of the test output
const silenceConsoleError = () => {
  let originalConsoleError = console.error;

  beforeEach(() => {
    originalConsoleError = console.error;
    // eslint-disable-next-line immutable/no-mutation
    console.error = () => {
      return undefined;
    };
  });

  afterEach(() => {
    // eslint-disable-next-line immutable/no-mutation
    console.error = originalConsoleError;
  });
};

let fixtureRoot = "";

before(async () => {
  fixtureRoot = await createFixture({ namePrefix: "wurzel-spec-", files: fixtureFiles });
  await chmod(nodePath.join(fixtureRoot, "unreadable.js"), 0o000);
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("defaultDetermineFileTypeByPath", () => {
  [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].forEach((ending) => {
    it(`classifies "${ending}" files as script`, () => {
      assert.strictEqual(defaultDetermineFileTypeByPath({ filePath: `/some/folder/file${ending}` }), "script");
    });
  });

  [
    "/index.html",
    "/style.css",
    "/data.json",
    "/file.js.map",
    "/README",
    "/folder.js/readme.md"
  ].forEach((filePath) => {
    it(`classifies "${filePath}" as other`, () => {
      assert.strictEqual(defaultDetermineFileTypeByPath({ filePath }), "other");
    });
  });
});

describe("defaultCodeAnalyzer", () => {
  it("is the default code analyzer of es6-debug-server", () => {
    assert.strictEqual(defaultCodeAnalyzer, es6DebugServer.defaultCodeAnalyzer);
  });
});

describe("defaultResolveImportPath", () => {
  const resolvesTo = async ({ importer, specifier, expected }: { importer: string, specifier: string, expected: string }) => {
    const result = await defaultResolveImportPath({
      importer: nodePath.join(fixtureRoot, importer),
      specifier
    });

    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.filePath, nodePath.join(fixtureRoot, expected));
  };

  const failsToResolve = async ({ specifier }: { specifier: string }) => {
    const result = await defaultResolveImportPath({
      importer: nodePath.join(fixtureRoot, "main.js"),
      specifier
    });

    assert.ok(result.error instanceof Error);
    assert.strictEqual(result.filePath, undefined);
  };

  it("resolves a relative specifier next to the importer", async () => {
    await resolvesTo({ importer: "main.js", specifier: "./lib/helper.ts", expected: "lib/helper.ts" });
  });

  it("resolves a relative specifier in a parent folder of the importer", async () => {
    await resolvesTo({ importer: "deep/er/leaf.ts", specifier: "../../shared.js", expected: "shared.js" });
  });

  it("resolves a bare package specifier to the entry point of the package", async () => {
    await resolvesTo({ importer: "deep/er/leaf.ts", specifier: "fixture-pkg", expected: "node_modules/fixture-pkg/index.js" });
  });

  it("resolves a package subpath export", async () => {
    await resolvesTo({ importer: "main.js", specifier: "fixture-pkg/sub.js", expected: "node_modules/fixture-pkg/sub.js" });
  });

  it("fails for node: builtins", async () => {
    await failsToResolve({ specifier: "node:fs" });
  });

  it("fails for builtins without node: prefix", async () => {
    await failsToResolve({ specifier: "fs" });
  });

  it("fails for non-file URLs", async () => {
    await failsToResolve({ specifier: "https://example.com/module.js" });
  });

  it("fails for packages that are not installed", async () => {
    await failsToResolve({ specifier: "not-installed-anywhere" });
  });
});

describe("expressRouter", () => {
  let server: IRunningServer | undefined = undefined;

  const start = async (args: { baseFolder?: string, options?: TRouterOptions, mount?: TMount } = {}) => {
    server = await startWurzel({ baseFolder: fixtureRoot, ...args });
    return server;
  };

  const get = async ({ path }: { path: string }) => {
    const { port } = server ?? await start();
    return requestFollowingRedirects({ port, path });
  };

  silenceConsoleError();

  afterEach(async () => {
    const running = server;
    server = undefined;
    await running?.close();
  });

  describe("serving scripts", () => {
    it("redirects script requests to a location that serves the script", async () => {
      const response = await get({ path: "/plain.js" });

      assert.strictEqual(response.redirects.length, 1);
      assertServesJavaScript({ response });
    });

    it("serves JavaScript unchanged", async () => {
      const response = await get({ path: "/plain.js" });

      assertServesJavaScript({ response });
      assert.strictEqual(response.body, fixtureFiles["plain.js"]);
    });

    it("serves JavaScript modules unchanged", async () => {
      const response = await get({ path: "/plain.mjs" });

      assertServesJavaScript({ response });
      assert.strictEqual(response.body, fixtureFiles["plain.mjs"]);
    });

    ["typed.ts", "typed.mts", "typed.cts"].forEach((fileName) => {
      it(`serves "${fileName}" as executable JavaScript`, async () => {
        const response = await get({ path: `/${fileName}` });

        assertServesJavaScript({ response });
        const served = await importServedModule({ code: response.body });
        assert.strictEqual(served.typed, 42);
      });
    });

    it("serves TypeScript consistently when it is requested repeatedly", async () => {
      const first = await get({ path: "/typed.ts" });
      const second = await get({ path: "/typed.ts" });

      assertServesJavaScript({ response: second });
      assert.strictEqual(second.body, first.body);
    });

    it("rewrites imports so that they load the imported files", async () => {
      const modules = await loadModuleGraph({ port: (await start()).port, entryPath: "/main.js" });

      assert.deepStrictEqual(exportedNamesOf({ modules }), ["helper", "main", "pkg", "shared"]);
    });

    it("serves a script requested with a query string", async () => {
      const response = await get({ path: "/typed.ts?cache-bust=1" });

      assertServesJavaScript({ response });
      const served = await importServedModule({ code: response.body });
      assert.strictEqual(served.typed, 42);
    });

    it("serves a script whose path needs URL encoding", async () => {
      const response = await get({ path: "/sub%20dir/spaced.js" });

      assertServesJavaScript({ response });
      assert.strictEqual(response.body, fixtureFiles["sub dir/spaced.js"]);
    });

    it("serves a script whose name contains characters with a meaning in URLs", async () => {
      const response = await get({ path: "/sub%20dir/100%25%20%231.js" });

      assertServesJavaScript({ response });
      assert.strictEqual(response.body, fixtureFiles["sub dir/100% #1.js"]);
    });

    it("serves scripts from a base folder whose path needs URL encoding", async () => {
      const baseFolder = await createFixture({ namePrefix: "wurzel spec ", files: { "plain.js": fixtureFiles["plain.js"] } });

      try {
        const { port } = await start({ baseFolder });
        const response = await requestFollowingRedirects({ port, path: "/plain.js" });

        assertServesJavaScript({ response });
        assert.strictEqual(response.body, fixtureFiles["plain.js"]);
      } finally {
        await rm(baseFolder, { recursive: true, force: true });
      }
    });
  });

  describe("failing script requests", () => {
    it("responds with 404 for a script that does not exist", async () => {
      const response = await get({ path: "/does-not-exist.js" });

      assert.strictEqual(response.status, 404);
    });

    it("responds with 404 for a script below a path that is a file", async () => {
      const response = await get({ path: "/plain.js/child.js" });

      assert.strictEqual(response.status, 404);
    });

    // root can read the file regardless of its permissions
    const itUnlessRoot = process.getuid?.() === 0 ? it.skip : it;

    itUnlessRoot("responds with 500 for a script that cannot be read", async () => {
      const response = await get({ path: "/unreadable.js" });

      assert.strictEqual(response.status, 500);
    });

    it("responds with 500 for TypeScript that cannot be transpiled", async () => {
      const response = await get({ path: "/broken.ts" });

      assert.strictEqual(response.status, 500);
    });

    it("responds with 500 for TypeScript with syntax that cannot be blanked out", async () => {
      const response = await get({ path: "/enum.ts" });

      assert.strictEqual(response.status, 500);
    });

    it("responds with 500 for a script importing a node builtin", async () => {
      const response = await get({ path: "/imports-builtin.js" });

      assert.strictEqual(response.status, 500);
    });

    it("responds with 500 for a script importing a package that is not installed", async () => {
      const response = await get({ path: "/imports-missing.js" });

      assert.strictEqual(response.status, 500);
    });

    ["/folder/../plain.js", "//plain.js", "/folder/%2e%2e/plain.js", "/malformed%.js", "/null%00.js"].forEach((path) => {
      it(`rejects the malformed path "${path}" with a client error`, async () => {
        const { port } = await start();
        const response = await sendRequest({ port, path });

        assert.ok(response.status >= 400 && response.status < 500, `expected a client error, got ${response.status}`);
      });
    });

    it("responds with a server error to HEAD requests for scripts, as they are not supported yet", async () => {
      const { port } = await start();
      const response = await sendRequest({ port, path: "/plain.js", method: "HEAD" });

      assert.ok(response.status >= 500, `expected a server error, got ${response.status}`);
    });
  });

  describe("serving other files", () => {
    it("serves other files from the base folder as they are", async () => {
      const response = await get({ path: "/index.html" });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.redirects.length, 0);
      assert.match(response.headers["content-type"] ?? "", /^text\/html\b/u);
      assert.strictEqual(response.body, fixtureFiles["index.html"]);
    });

    it("responds with 404 for other files that do not exist", async () => {
      const response = await get({ path: "/does-not-exist.html" });

      assert.strictEqual(response.status, 404);
    });
  });

  describe("options", () => {
    it("analyzes identical code only once", async () => {
      const analyzer = countingAnalyzer();
      await start({ options: { analyzeCode: analyzer.analyzeCode } });

      assertServesJavaScript({ response: await get({ path: "/same-a.js" }) });
      assertServesJavaScript({ response: await get({ path: "/same-b.js" }) });
      assertServesJavaScript({ response: await get({ path: "/same-a.js" }) });

      assert.strictEqual(analyzer.callCount(), 1);
    });

    it("does not remember failed code analyses", async () => {
      let calls = 0;
      const analyzeCode: TCodeAnalyzeFunc = () => {
        calls += 1;
        return { error: Error("analysis failed") };
      };
      await start({ options: { analyzeCode } });

      assert.strictEqual((await get({ path: "/plain.js" })).status, 500);
      assert.strictEqual((await get({ path: "/plain.js" })).status, 500);

      assert.strictEqual(calls, 2);
    });

    it("does not remember analyses larger than maxAnalyzeCacheSize", async () => {
      const analyzer = countingAnalyzer();
      await start({ options: { analyzeCode: analyzer.analyzeCode, maxAnalyzeCacheSize: 1 } });

      assertServesJavaScript({ response: await get({ path: "/plain.js" }) });
      assertServesJavaScript({ response: await get({ path: "/plain.js" }) });

      assert.strictEqual(analyzer.callCount(), 2);
    });

    it("serves TypeScript correctly with a transpile cache too small to hold it", async () => {
      await start({ options: { maxTranspileCacheSize: 1 } });

      const first = await get({ path: "/typed.ts" });
      const second = await get({ path: "/typed.ts" });

      assertServesJavaScript({ response: second });
      assert.strictEqual(second.body, first.body);
      assert.strictEqual((await importServedModule({ code: second.body })).typed, 42);
    });

    it("resolves imports with a custom resolveImportPath", async () => {
      let calls: Parameters<TResolveImportPathFunc>[0][] = [];
      const resolveImportPath: TResolveImportPathFunc = async (args) => {
        calls = [...calls, args];
        return { error: undefined, filePath: nodePath.join(fixtureRoot, "virtual/thing.js") };
      };
      const { port } = await start({ options: { resolveImportPath } });

      const modules = await loadModuleGraph({ port, entryPath: "/imports-virtual.js" });

      assert.deepStrictEqual(exportedNamesOf({ modules }), ["usesVirtual", "virtual"]);
      assert.deepStrictEqual(calls, [{ importer: nodePath.join(fixtureRoot, "imports-virtual.js"), specifier: "virtual:thing" }]);
    });

    it("serves files classified as other by a custom determineFileTypeByPath as they are", async () => {
      await start({
        options: {
          determineFileTypeByPath: () => {
            return "other";
          }
        }
      });

      const response = await get({ path: "/typed.ts" });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.redirects.length, 0);
      assert.strictEqual(response.body, fixtureFiles["typed.ts"]);
    });

    it("serves files classified as script by a custom determineFileTypeByPath as scripts", async () => {
      await start({
        options: {
          determineFileTypeByPath: () => {
            return "script";
          }
        }
      });

      const response = await get({ path: "/custom.es" });

      assertServesJavaScript({ response });
      assert.strictEqual((await importServedModule({ code: response.body })).custom, "custom");
    });

    it("responds with a server error for script resources, as they are not supported yet", async () => {
      await start({
        options: {
          determineFileTypeByPath: () => {
            return "script-resource";
          }
        }
      });

      const response = await get({ path: "/plain.js" });

      assert.ok(response.status >= 500, `expected a server error, got ${response.status}`);
    });
  });

  describe("mounting", () => {
    const mountAt = ({ path }: { path: string }): TMount => {
      return ({ app, router }) => {
        app.use(path, router);
      };
    };

    const mountInNestedRouters: TMount = ({ app, router }) => {
      const outer = express.Router();
      outer.use("/inner", router);
      app.use("/outer", outer);
    };

    // `prefix` is the path the router is expected to be reachable at
    const mountVariants: { name: string, prefix: string, mount: TMount }[] = [
      { name: "at the root", prefix: "", mount: mountAtRoot },
      { name: "at /app", prefix: "/app", mount: mountAt({ path: "/app" }) },
      { name: "at /app/nested", prefix: "/app/nested", mount: mountAt({ path: "/app/nested" }) },
      { name: "at /a/b/c/d", prefix: "/a/b/c/d", mount: mountAt({ path: "/a/b/c/d" }) },
      { name: "at /app/ with trailing slash", prefix: "/app", mount: mountAt({ path: "/app/" }) },
      { name: "in nested routers at /outer/inner", prefix: "/outer/inner", mount: mountInNestedRouters },
      { name: "at the parameterized path /:tenant", prefix: "/acme", mount: mountAt({ path: "/:tenant" }) }
    ];

    const assertAllBelow = ({ paths, prefix }: { paths: string[], prefix: string }) => {
      paths.forEach((path) => {
        assert.ok(path.startsWith(`${prefix}/`), `"${path}" is not below "${prefix}/"`);
      });
    };

    mountVariants.forEach(({ name, prefix, mount }) => {
      describe(name, () => {
        it("redirects script requests to a location below the mount path", async () => {
          await start({ mount });

          const response = await get({ path: `${prefix}/lib/helper.ts` });

          assertServesJavaScript({ response });
          assert.strictEqual(response.redirects.length, 1);
          assertAllBelow({ paths: [response.path], prefix });
        });

        it("serves a module graph with imports into subfolders and node_modules", async () => {
          const { port } = await start({ mount });

          const modules = await loadModuleGraph({ port, entryPath: `${prefix}/main.js` });

          assert.deepStrictEqual(exportedNamesOf({ modules }), ["helper", "main", "pkg", "shared"]);
          assertAllBelow({ paths: [...modules.keys()], prefix });
        });

        it("serves a module graph starting in a subfolder with imports into parent folders", async () => {
          const { port } = await start({ mount });

          const modules = await loadModuleGraph({ port, entryPath: `${prefix}/deep/er/leaf.ts` });

          assert.deepStrictEqual(exportedNamesOf({ modules }), ["leaf", "shared"]);
          assertAllBelow({ paths: [...modules.keys()], prefix });
        });

        it("responds with 404 for a script that does not exist", async () => {
          await start({ mount });

          const response = await get({ path: `${prefix}/deep/does-not-exist.js` });

          assert.strictEqual(response.status, 404);
        });

        it("serves other files as they are", async () => {
          await start({ mount });

          const response = await get({ path: `${prefix}/index.html` });

          assert.strictEqual(response.status, 200);
          assert.strictEqual(response.body, fixtureFiles["index.html"]);
        });
      });
    });

    describe("behind a reverse proxy serving it below a path prefix", () => {
      let proxy: IRunningServer | undefined = undefined;

      afterEach(async () => {
        const running = proxy;
        proxy = undefined;
        await running?.close();
      });

      [
        { name: "mounted at the root", mountPath: "/", proxyPrefix: "/production", prefix: "/production" },
        { name: "mounted at /app", mountPath: "/app", proxyPrefix: "/production", prefix: "/production/app" }
      ].forEach(({ name, mountPath, proxyPrefix, prefix }) => {
        it(`serves a module graph below the proxy prefix when ${name}`, async () => {
          const { port } = await start({ mount: mountAt({ path: mountPath }) });
          proxy = await startPrefixStrippingProxy({ prefix: proxyPrefix, targetPort: port });

          const modules = await loadModuleGraph({ port: proxy.port, entryPath: `${prefix}/main.js` });

          assert.deepStrictEqual(exportedNamesOf({ modules }), ["helper", "main", "pkg", "shared"]);
          assertAllBelow({ paths: [...modules.keys()], prefix });
        });
      });
    });
  });
});
