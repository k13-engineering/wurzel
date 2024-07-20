#!/usr/bin/env node

import express from "express";
import { expressRouter as wurzel } from "../lib/index.ts";
import path from "node:path";

const app = express();

const rootFolder = path.resolve(".");

app.use("/", wurzel({ express, baseFolder: rootFolder }));

const port = 8080;

app.listen(port, () => {
  console.log(`listening on :${port}`);
});
