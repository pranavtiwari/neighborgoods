const fs = require('fs');
const path = require('path');

const collectionsDir = path.join(__dirname, 'postman/collections');
const skipFile = 'sign-in.request.yaml';

function findRequestFiles(dir) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findRequestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.request.yaml')) {
      results.push(fullPath);
    }
  }
  return results;
}

const files = findRequestFiles(collectionsDir);
let skipped = [], alreadyHas = [], updated = [];

for (const filePath of files) {
  if (path.basename(filePath) === skipFile) {
    skipped.push(filePath);
    continue;
  }

  let content = fs.readFileSync(filePath, 'utf8');

  if (content.includes('Authorization')) {
    alreadyHas.push(filePath);
    continue;
  }

  const lines = content.split('\n');
  let newLines;

  const headersIdx = lines.findIndex(l => /^headers:/.test(l));
  if (headersIdx !== -1) {
    newLines = [
      ...lines.slice(0, headersIdx + 1),
      "  - key: Authorization",
      "    value: 'Bearer {{firebaseIdToken}}'",
      ...lines.slice(headersIdx + 1)
    ];
  } else {
    let insertAfter = lines.findIndex(l => /^url:/.test(l));
    if (insertAfter === -1) insertAfter = lines.findIndex(l => /^method:/.test(l));
    if (insertAfter === -1) insertAfter = lines.length - 1;

    newLines = [
      ...lines.slice(0, insertAfter + 1),
      'headers:',
      "  - key: Authorization",
      "    value: 'Bearer {{firebaseIdToken}}'",
      ...lines.slice(insertAfter + 1)
    ];
  }

  fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
  updated.push(filePath);
}

console.log('=== RESULTS ===');
console.log('Updated (' + updated.length + '):');
updated.forEach(f => console.log('  + ' + f));
console.log('Already had Authorization (' + alreadyHas.length + '):');
alreadyHas.forEach(f => console.log('  = ' + f));
console.log('Skipped (' + skipped.length + '):');
skipped.forEach(f => console.log('  - ' + f));
