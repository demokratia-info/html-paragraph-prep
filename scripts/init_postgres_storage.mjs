#!/usr/bin/env node
"use strict";

import { checkStorage, closePool, initDatabase } from "../server/postgres-storage.mjs";

try {
  await initDatabase();
  const status = await checkStorage();
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
} finally {
  await closePool();
}
