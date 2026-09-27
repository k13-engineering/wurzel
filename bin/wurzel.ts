#!/usr/bin/env node

import express from "express";
import { wurzelExpressRouter } from "../lib/index.ts";
import path from "node:path";

const app = express();

const rootFolder = path.resolve(".");

app.use("/", wurzelExpressRouter({ express, baseFolder: rootFolder }));

const port = 8080;

// @ts-expect-error wrong type definition for listen callback
app.listen(port, (err: Error) => {
  if (err) {
    console.error("Error starting server:", err);
    return;
  }

  console.log(`listening on :${port}`);
});
