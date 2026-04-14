import {
  expressRouter as wurzelExpressRouter,
  defaultResolveImportPath,
  type TResolveImportPathFunc
} from "../../lib/index.ts";
import nodePath from "node:path";
import { resolve } from "esm-resource";
import express from "express";

const relativePath = ({ filepath }: { filepath: string }) => {
  return nodePath.resolve(resolve({ importMeta: import.meta, filepath }));
};

const baseFolder = relativePath({ filepath: "./frontend" });

const resolveImportPath: TResolveImportPathFunc = async ({ importer, specifier }) => {
  if (specifier === "vue") {
    return {
      error: undefined,
      // this is only an example, it is neither installed nor used in this sample
      filePath: relativePath({ filepath: "../node_modules/vue/dist/vue.esm-browser.js" })
    };
  }

  return defaultResolveImportPath({ importer, specifier });
};

const app = express();

app.use("/", wurzelExpressRouter({
  express,
  baseFolder,
  fileEndings: [".ts", ".js", ".mjs"],
  resolveImportPath
}));

const port = 8080;

app.listen(port, () => {
  console.log(`listening on :${port}`);
});
