const fs = require('fs');
const path = require('path');

const ldbDir = path.join(process.env.APPDATA, 'sc-player', 'Local Storage', 'leveldb');
const rawMatches = [];

for (const file of fs.readdirSync(ldbDir)) {
  if (file === 'LOCK') continue;
  try {
    const buf = fs.readFileSync(path.join(ldbDir, file));
    const s8 = buf.toString('utf8');
    const s16 = buf.toString('utf16le');
    const sClean = buf.toString('binary').replace(/\0/g, '');

    for (const content of [sClean, s8, s16]) {
      let p = 0;
      while ((p = content.indexOf('"id":', p)) !== -1) {
        const start = content.lastIndexOf('{', p);
        if (start !== -1) {
          let depth = 0;
          let inStr = false;
          let esc = false;
          let end = -1;
          for (let i = start; i < Math.min(start + 50000, content.length); i++) {
            const c = content[i];
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (!inStr) {
              if (c === '{') depth++;
              else if (c === '}') {
                depth--;
                if (depth === 0) { end = i; break; }
              }
            }
          }

          if (end !== -1) {
            try {
              const objStr = content.slice(start, end + 1);
              const parsed = JSON.parse(objStr);
              if (parsed.id && parsed.title && parsed.artist) {
                rawMatches.push(parsed);
              }
            } catch (e) {}
          }
        }
        p += 5;
      }
    }
  } catch (e) {}
}

const map = new Map();
for (const t of rawMatches) {
  map.set(String(t.id), t);
}
const unique = Array.from(map.values());

const dest = path.join(__dirname, 'favorites_backup.json');
fs.writeFileSync(dest, JSON.stringify(unique, null, 2), 'utf8');

console.log(`[BACKUP SUCCESS] Extracted and backed up ${unique.length} unique tracks to favorites_backup.json`);
unique.forEach((t, i) => console.log(`${i + 1}. ${t.artist} - ${t.title}`));
