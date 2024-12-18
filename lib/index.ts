import {
  createReadError,
  create as createServer,
  ETryReadErrorCode,
  defaultCodeAnalyzer
} from "es6-debug-server";
import type {
  ICodeAnalyzeResult,
  TResolveImportPathFunc,
} from "es6-debug-server";
import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { resolve as resolveImport } from "import-meta-resolve";
// @ts-expect-error missing types
import { transpileCode } from "commentscript";
import { LRUCache } from "lru-cache";
import type Express from "express";

const md5 = ({ content }: { content: string }) => {
  return createHash("md5").update(content).digest("hex");
};

interface ITranspileErrorResult {
  error: Error;
  transpiled?: undefined;
};

interface ITranspileSuccessResult {
  error: undefined;
  transpiled: string;
};

type TTranspileResult = ITranspileErrorResult | ITranspileSuccessResult;

const defaultResolveImportPath: TResolveImportPathFunc = async ({ importer, specifier }) => {
  const parentUrl = pathToFileURL(importer);
  let resolvedUrl: string | undefined = undefined;

  try {
    resolvedUrl = resolveImport(specifier, parentUrl.toString());
  } catch (error) {
    return {
      error: error as Error
    };
  }

  if (resolvedUrl.startsWith("node:")) {
    return {
      error: Error(`node imports are not supported, got "${resolvedUrl}"`)
    };
  }

  if (!resolvedUrl.startsWith("file:")) {
    return {
      error: Error(`only file imports are supported, got "${resolvedUrl}"`)
    };
  }

  const resolvedPath = fileURLToPath(resolvedUrl);
  return {
    error: undefined,
    filePath: resolvedPath
  };
};

const expressRouter = ({
  express,
  baseFolder,
  fileEndings = [".js", ".ts"],

  maxAnalyzeCacheSize = 1 * 1024 * 1024,
  maxTranspileCacheSize = 64 * 1024 * 1024,

  resolveImportPath = defaultResolveImportPath
}: {
  express: typeof Express,
  baseFolder: string,
  fileEndings?: string[],

  maxAnalyzeCacheSize?: number,
  maxTranspileCacheSize?: number,

  resolveImportPath?: TResolveImportPathFunc
}) => {

  const router = express.Router();

  const transpileCache = new LRUCache<string, string>({
    maxSize: maxTranspileCacheSize,
    sizeCalculation: (value, key) => {
      return key.length + value.length;
    }
  });

  const analyzeCache = new LRUCache<string, ICodeAnalyzeResult>({
    maxSize: maxAnalyzeCacheSize,
    sizeCalculation: (value, key) => {
      return key.length + JSON.stringify(value).length;
    }
  });

  // eslint-disable-next-line complexity
  const maybeTranspile = async ({ filePath, code }: { filePath: string, code: string }): Promise<TTranspileResult> => {
    if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) {
      return {
        error: undefined,
        transpiled: code
      };
    }

    const hash = md5({ content: code });

    const cached = transpileCache.get(hash);
    if (cached !== undefined) {
      return {
        error: undefined,
        transpiled: cached
      };
    }

    let transpiled: string | undefined = undefined;

    try {
      const result = await transpileCode({ code });
      transpiled = result.transpiledCode;
    } catch (ex) {
      return {
        error: ex as Error,
      };
    }

    if (transpiled === undefined) {
      throw Error("BUG: transpiled code is undefined");
    }

    transpileCache.set(hash, transpiled);

    return {
      error: undefined,
      transpiled
    };
  };

  const server = createServer({

    scriptRootFolder: baseFolder,

    tryReadScriptAsString: async ({ filePath }) => {

      const { error: readError, content } = await readFile(filePath, "utf8").then((fileContent) => {
        return { error: undefined, content: fileContent };
      }, (err: NodeJS.ErrnoException) => {
        return { error: err, content: undefined };
      });

      if (readError !== undefined) {
        if (readError.code === "ENOENT") {

          return {
            error: createReadError({
              code: ETryReadErrorCode.FILE_NOT_FOUND,
              message: readError.message,
              cause: readError
            })
          };
        }

        return {
          error: createReadError({
            code: ETryReadErrorCode.IO_ERROR,
            message: readError.message,
            cause: readError
          })
        };
      }

      const { error: transpileError, transpiled } = await maybeTranspile({
        filePath,
        code: content
      });

      if (transpileError !== undefined) {
        return {
          error: createReadError({
            code: ETryReadErrorCode.IO_ERROR,
            message: `failed to transpile code of "${filePath}"`,
            cause: transpileError
          })
        };
      }

      return {
        error: undefined,
        content: transpiled
      };
    },

    // cache code analysis
    analyzeCode: ({ code }) => {
      const hash = md5({ content: code });

      const cached = analyzeCache.get(hash);
      if (cached !== undefined) {
        return {
          error: undefined,
          result: cached
        };
      }

      const analyzeResult = defaultCodeAnalyzer({ code });
      if (analyzeResult.error !== undefined) {
        return {
          error: analyzeResult.error
        };
      }

      analyzeCache.set(hash, analyzeResult.result);
      return analyzeResult;
    },

    resolveImportPath
  });

  router.use((req, res, next) => {

    if (req.method === "HEAD") {
      throw Error("HEAD not supported yet");
    }

    const isScript = fileEndings.some((ending) => req.url.endsWith(ending));
    if (isScript) {

      server.handleRequest({
        uri: req.url,

        handleRedirect: ({ uri }) => {
          const redirectLocation = `${req.baseUrl}${uri}`;
          res.redirect(redirectLocation);
        },

        handleContent: ({ contentType, content }) => {
          res.writeHead(200, {
            "Content-Type": contentType
          });
          res.end(content);
        },

        handleFileNotFound: () => {
          res.status(404).end("not found");
        },

        handleInternalError: ({ error }) => {
          console.error(error);
          res.status(500).end("internal server error");
        }
      });

      return;
    }

    next();
  });

  router.use(express.static(baseFolder));

  return router;
};

export {
  expressRouter,

  defaultResolveImportPath
};

export type {
  TResolveImportPathFunc
};
