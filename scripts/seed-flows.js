#!/usr/bin/env node
/**
 * Seeds all flows in flows/*.yaml into the SQLite DB.
 *
 * Usage:
 *   PROJECT_ID=hub-v2 node scripts/seed-flows.js
 *
 * If PROJECT_ID is not set, picks the first project found.
 * Re-running is safe (INSERT OR REPLACE).
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const db = require('../src/db');

const flowsDir = path.join(__dirname, '..', 'flows');
const projectId = process.env.PROJECT_ID
  || db.prepare('SELECT id FROM projects LIMIT 1').get()?.id;

if (!projectId) {
  console.error('No project found. Set PROJECT_ID=<slug> or create a project first.');
  process.exit(1);
}

if (!fs.existsSync(flowsDir)) {
  console.warn(`flows/ directory not found at ${flowsDir}`);
  process.exit(0);
}

const files = fs.readdirSync(flowsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
if (files.length === 0) {
  console.warn(`No YAML flows found in ${flowsDir}`);
  process.exit(0);
}

let seeded = 0;
for (const file of files) {
  const filePath = path.join(flowsDir, file);
  let flow;
  try {
    flow = yaml.load(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`failed to parse ${file}: ${err.message}`);
    continue;
  }
  if (!flow || typeof flow !== 'object') {
    console.warn(`skipping invalid flow file: ${file}`);
    continue;
  }
  const id = flow.id || path.basename(file, path.extname(file));
  // flows.name is NOT NULL — derive from description or fall back to id
  const name = flow.name || flow.description || id;
  const description = flow.description || null;

  db.prepare(`
    INSERT OR REPLACE INTO flows (id, project_id, name, description, json, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(id, projectId, name, description, JSON.stringify(flow));
  console.log(`seeded: ${id} (project=${projectId})`);
  seeded++;
}
console.log(`done — ${seeded} flow(s) seeded`);
