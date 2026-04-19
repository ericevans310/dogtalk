#!/usr/bin/env node
// Pre-generate ElevenLabs MP3s for every quote in quotes.json.
//
// Usage (run from repo root):
//   node --env-file=.env scripts/generate-voices.js --dry-run   # show char totals, no API calls
//   node --env-file=.env scripts/generate-voices.js --samples   # 1 mp3 per main class for voice approval
//   node --env-file=.env scripts/generate-voices.js             # full generation (idempotent)
//
// Output:
//   voices/<class-slug>/<hash>.mp3
//   voices/manifest.json   { "<class>": { "<original quote>": "voices/.../<hash>.mp3" } }
//
// Quotes containing {NAME} are skipped — they fall back to speechSynthesis at runtime.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT  = path.resolve(__dirname, '..');
const QUOTES     = path.join(REPO_ROOT, 'quotes.json');
const VOICES_DIR = path.join(REPO_ROOT, 'voices');

// ── Voice picks (edit here to change which ElevenLabs voice each class uses) ──
// IDs are from ElevenLabs' default voice library. If any 404, swap in IDs from
// your account at https://elevenlabs.io/app/voice-lab.
const VOICES = {
  dog:    { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni'   },  // energetic, warm
  cat:    { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily'     },  // British female
  person: { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam'     },  // neutral, deep
  // Bucket voices for variety
  charlie:  { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie'  },  // animals
  brian:    { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian'    },  // vehicles
  matilda:  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda'  },  // food + tableware
  daniel:   { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel'   },  // tech + appliances
  arnold:   { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold'   },  // furniture/toys/outdoor
};

// Bucket assignments — anything not listed here uses DEFAULT_VOICE.
const VOICE_BUCKETS = {
  charlie: ['bird','horse','cow','sheep','elephant','bear','zebra','giraffe'],
  brian:   ['car','motorcycle','bicycle','bus','truck','airplane','train','boat'],
  matilda: ['pizza','hot dog','apple','banana','sandwich','cake','donut','broccoli','carrot','orange',
            'bottle','wine glass','bowl','fork','knife','spoon','toothbrush'],
  daniel:  ['toilet','sink','refrigerator','toaster','microwave','oven','tv','cell phone','laptop','keyboard','clock','hair drier'],
  arnold:  ['bed','couch','chair','dining table','teddy bear','sports ball','frisbee','surfboard','baseball bat','tennis racket','skateboard',
            'fire hydrant','stop sign','bench','potted plant','book','vase','scissors','backpack','suitcase','umbrella','tie','handbag'],
};
const CLASS_TO_VOICE = {};
for (const [voiceKey, classes] of Object.entries(VOICE_BUCKETS)) {
  for (const cls of classes) CLASS_TO_VOICE[cls] = VOICES[voiceKey];
}

const DEFAULT_VOICE = VOICES.person; // person + DEFAULT_QUOTES + anything unbucketed

const MODEL_ID = 'eleven_multilingual_v2';
const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const REQUEST_DELAY_MS = 100;

function stripEmoji(s) {
  return s
    .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FEFF}]|[\u{1F300}-\u{1FAD6}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugClass(cls) {
  return cls.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

function hashKey(cls, text, voiceId) {
  return crypto.createHash('sha1').update(`${cls}|${text}|${voiceId}`).digest('hex').slice(0, 10);
}

function voiceFor(cls) {
  return VOICES[cls] || CLASS_TO_VOICE[cls] || DEFAULT_VOICE;
}

async function tts(text, voiceId) {
  const res = await fetch(`${API_BASE}/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`ElevenLabs ${res.status} ${res.statusText}: ${msg.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function loadQuotes() {
  return JSON.parse(fs.readFileSync(QUOTES, 'utf8'));
}

function* allItems(data) {
  for (const [cls, pool] of Object.entries(data.quotes)) {
    for (const quote of pool) yield { cls, quote };
  }
  for (const quote of data.defaults) yield { cls: '_default', quote };
}

async function runDryRun() {
  const data = loadQuotes();
  let total = 0, namedSkipped = 0, voiceable = 0;
  const perVoice = {};
  for (const { cls, quote } of allItems(data)) {
    if (quote.includes('{NAME}')) { namedSkipped++; continue; }
    const clean = stripEmoji(quote);
    if (!clean) continue;
    voiceable++;
    total += clean.length;
    const v = voiceFor(cls).name;
    perVoice[v] = (perVoice[v] || 0) + clean.length;
  }
  console.log(`Voiceable quotes: ${voiceable}`);
  console.log(`Skipped (contain {NAME}): ${namedSkipped}`);
  console.log(`Total characters: ${total}`);
  console.log(`Per voice:`);
  for (const [v, n] of Object.entries(perVoice)) console.log(`  ${v}: ${n} chars`);
  console.log(`\nElevenLabs free tier is 10,000 chars/month. Re-runs of this script skip files that already exist.`);
}

async function runSamples() {
  const data = loadQuotes();
  const samples = [
    { cls: 'dog',    quote: data.quotes.dog[0]    },
    { cls: 'cat',    quote: data.quotes.cat[0]    },
    { cls: 'person', quote: data.quotes.person[0] },
  ];
  const outDir = path.join(VOICES_DIR, 'samples');
  fs.mkdirSync(outDir, { recursive: true });
  const failures = [];
  for (const s of samples) {
    const v = voiceFor(s.cls);
    const text = stripEmoji(s.quote);
    console.log(`[${s.cls}] voice=${v.name} text="${text}"`);
    try {
      const mp3 = await tts(text, v.id);
      const file = path.join(outDir, `${s.cls}.mp3`);
      fs.writeFileSync(file, mp3);
      console.log(`  → ${path.relative(REPO_ROOT, file)}  (${mp3.length} bytes)`);
    } catch (e) {
      console.error(`  ! ${v.name} failed: ${e.message}`);
      failures.push({ cls: s.cls, voice: v.name });
    }
    await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
  }
  if (failures.length) {
    console.log(`\n${failures.length} voice(s) need swapping in scripts/generate-voices.js:`);
    failures.forEach(f => console.log(`  - ${f.cls} → ${f.voice}`));
  }
  console.log(`\nDone. Listen to:`);
  console.log(`  open voices/samples/dog.mp3 voices/samples/cat.mp3 voices/samples/person.mp3`);
}

async function runFull() {
  const data = loadQuotes();
  const manifest = {};
  let generated = 0, cached = 0, namedSkipped = 0, errors = 0, fellBack = 0;
  let quotaHit = false;

  // Returns the relPath for the Adam-voiced version of this quote if that
  // file already exists on disk, or null otherwise.
  function adamFallback(cls, clean) {
    const slug = slugClass(cls);
    const adamHash = hashKey(cls, clean, DEFAULT_VOICE.id);
    const rel = `voices/${slug}/${adamHash}.mp3`;
    return fs.existsSync(path.join(REPO_ROOT, rel)) ? rel : null;
  }

  function recordManifest(cls, quote, relPath) {
    manifest[cls] = manifest[cls] || {};
    manifest[cls][quote] = relPath;
  }

  for (const { cls, quote } of allItems(data)) {
    if (quote.includes('{NAME}')) { namedSkipped++; continue; }
    const clean = stripEmoji(quote);
    if (!clean) continue;

    const v       = voiceFor(cls);
    const slug    = slugClass(cls);
    const hash    = hashKey(cls, clean, v.id);
    const relPath = `voices/${slug}/${hash}.mp3`;
    const absPath = path.join(REPO_ROOT, relPath);

    if (fs.existsSync(absPath)) {
      recordManifest(cls, quote, relPath);
      cached++;
      continue;
    }

    // If quota's already exhausted, don't bother calling — fall straight back.
    if (quotaHit) {
      const fb = adamFallback(cls, clean);
      if (fb) { recordManifest(cls, quote, fb); fellBack++; }
      continue;
    }

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    try {
      const mp3 = await tts(clean, v.id);
      fs.writeFileSync(absPath, mp3);
      recordManifest(cls, quote, relPath);
      generated++;
      console.log(`  + [${cls}] ${hash} "${clean}"`);
      await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
    } catch (e) {
      errors++;
      console.error(`  ! [${cls}] FAILED "${clean}" → ${e.message}`);
      // On auth/quota errors, switch to fallback-only mode for the remainder
      // so we still produce a complete manifest pointing to whatever exists.
      if (/401|402|403|429/.test(e.message)) {
        console.error('Quota/auth error — finishing in fallback-only mode (no more API calls).');
        quotaHit = true;
      }
      const fb = adamFallback(cls, clean);
      if (fb) { recordManifest(cls, quote, fb); fellBack++; }
    }
  }

  fs.writeFileSync(
    path.join(VOICES_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  console.log(`\nGenerated:    ${generated}`);
  console.log(`Already had:  ${cached}`);
  console.log(`Adam fallback:${fellBack}`);
  console.log(`Skipped name: ${namedSkipped}`);
  console.log(`Errors:       ${errors}`);
  console.log(`Manifest:     ${path.relative(REPO_ROOT, path.join(VOICES_DIR, 'manifest.json'))}`);
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--dry-run') return runDryRun();

  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('Missing ELEVENLABS_API_KEY.');
    console.error('Run with:  node --env-file=.env scripts/generate-voices.js [--samples|--dry-run]');
    process.exit(1);
  }

  fs.mkdirSync(VOICES_DIR, { recursive: true });

  if (mode === '--samples') return runSamples();
  return runFull();
}

main().catch(e => { console.error(e); process.exit(1); });
