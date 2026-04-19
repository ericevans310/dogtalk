#!/usr/bin/env node
// Pre-generate TTS MP3s for every quote in quotes.json.
//
// Usage (run from repo root):
//   node --env-file=.env scripts/generate-voices.js --dry-run   # show char totals, no API calls
//   node --env-file=.env scripts/generate-voices.js --samples   # 1 mp3 per main class for voice approval
//   node --env-file=.env scripts/generate-voices.js             # full generation (idempotent)
//
// Provider is chosen by TTS_PROVIDER env var (default: cartesia).
// Each provider implements { name, apiKey, quotaInfo, voices, voiceBuckets,
// defaultVoiceKey, tts(text, voiceId) → Buffer }.
//
// Output:
//   voices/<class-slug>/<hash>.mp3
//   voices/manifest.json   { "<class>": { "<original quote>": "voices/.../<hash>.mp3" } }
//
// Hash includes provider so a Cartesia run cannot collide with or overwrite
// existing ElevenLabs-generated files, and vice versa.
//
// Quotes containing {NAME} are skipped — they fall back to speechSynthesis at runtime.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT  = path.resolve(__dirname, '..');
const QUOTES     = path.join(REPO_ROOT, 'quotes.json');
const VOICES_DIR = path.join(REPO_ROOT, 'voices');

const REQUEST_DELAY_MS = 100;

// ─────────────────────────── Provider: ElevenLabs ───────────────────────────
const ElevenLabsProvider = {
  name: 'elevenlabs',
  apiKey: () => process.env.ELEVENLABS_API_KEY,
  quotaInfo: 'ElevenLabs free tier: 10,000 chars/month.',
  voices: {
    dog:    { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni'   },
    cat:    { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily'     },
    person: { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam'     },
    charlie:  { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie'  },
    brian:    { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian'    },
    matilda:  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda'  },
    daniel:   { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel'   },
    arnold:   { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold'   },
  },
  voiceBuckets: {
    charlie: ['bird','horse','cow','sheep','elephant','bear','zebra','giraffe'],
    brian:   ['car','motorcycle','bicycle','bus','truck','airplane','train','boat'],
    matilda: ['pizza','hot dog','apple','banana','sandwich','cake','donut','broccoli','carrot','orange',
              'bottle','wine glass','bowl','fork','knife','spoon','toothbrush'],
    daniel:  ['toilet','sink','refrigerator','toaster','microwave','oven','tv','cell phone','laptop','keyboard','clock','hair drier'],
    arnold:  ['bed','couch','chair','dining table','teddy bear','sports ball','frisbee','surfboard','baseball bat','tennis racket','skateboard',
              'fire hydrant','stop sign','bench','potted plant','book','vase','scissors','backpack','suitcase','umbrella','tie','handbag'],
  },
  defaultVoiceKey: 'person',
  async tts(text, voiceId) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(`ElevenLabs ${res.status} ${res.statusText}: ${msg.slice(0, 300)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  },
};

// ──────────────────────────── Provider: Cartesia ────────────────────────────
// Voice IDs from https://api.cartesia.ai/voices?language=en (live library).
const CartesiaProvider = {
  name: 'cartesia',
  apiKey: () => process.env.CARTESIA_API_KEY,
  quotaInfo: 'Cartesia free tier: 10,000 credits/month (1 credit per character).',
  voices: {
    dog:       { id: 'e00d0e4c-a5c8-443f-a8a3-473eb9a62355', name: 'Zeke'  },  // high-pitched, friendly, character-y
    dog_small: { id: 'cccc21e8-5bcf-4ff0-bc7f-be4e40afc544', name: 'Avery' },  // high-pitched energetic young female — small-dog variant
    cat:       { id: '999df508-4de5-40a7-8bd3-8c12f678c284', name: 'Layla' },  // chill, smooth, dry
    person:    { id: 'a0e99841-438c-4a64-b679-ae501e7d6091', name: 'Greg'  },  // neutral, deep, warm
  },
  voiceBuckets: {},  // no bucketing yet for Cartesia — everything else uses defaultVoiceKey
  defaultVoiceKey: 'person',
  async tts(text, voiceId) {
    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.CARTESIA_API_KEY,
        'Cartesia-Version': '2026-03-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: 'sonic-3',
        transcript: text,
        voice: { mode: 'id', id: voiceId },
        output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
        language: 'en',
      }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(`Cartesia ${res.status} ${res.statusText}: ${msg.slice(0, 300)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  },
};

const PROVIDERS = { elevenlabs: ElevenLabsProvider, cartesia: CartesiaProvider };
const PROVIDER_KEY = process.env.TTS_PROVIDER || 'cartesia';
const provider = PROVIDERS[PROVIDER_KEY];

// Virtual classes: reuse an existing quote pool under a different class key so
// a variant voice (e.g. Avery for small dogs) can be generated alongside the
// original. Only emitted when the active provider defines the virtual voice.
const VIRTUAL_CLASSES = {
  dog_small: 'dog',
};
if (!provider) {
  console.error(`Unknown TTS_PROVIDER "${PROVIDER_KEY}". Set TTS_PROVIDER to one of: ${Object.keys(PROVIDERS).join(', ')}.`);
  process.exit(1);
}

// Per-provider voice resolution
const VOICES = provider.voices;
const CLASS_TO_VOICE = {};
for (const [voiceKey, classes] of Object.entries(provider.voiceBuckets)) {
  for (const cls of classes) CLASS_TO_VOICE[cls] = VOICES[voiceKey];
}
const DEFAULT_VOICE = VOICES[provider.defaultVoiceKey];

function stripEmoji(s) {
  return s
    .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{FE00}-\u{FEFF}]|[\u{1F300}-\u{1FAD6}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugClass(cls) {
  return cls.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

// Provider name is part of the hash so different providers' files for the
// same quote never collide on disk.
function hashKey(cls, text, voiceId) {
  return crypto.createHash('sha1')
    .update(`${cls}|${text}|${provider.name}|${voiceId}`)
    .digest('hex').slice(0, 10);
}

function voiceFor(cls) {
  return VOICES[cls] || CLASS_TO_VOICE[cls] || DEFAULT_VOICE;
}

async function tts(text, voiceId) {
  return provider.tts(text, voiceId);
}

function loadQuotes() {
  return JSON.parse(fs.readFileSync(QUOTES, 'utf8'));
}

function* allItems(data) {
  for (const [cls, pool] of Object.entries(data.quotes)) {
    for (const quote of pool) yield { cls, quote };
  }
  for (const quote of data.defaults) yield { cls: '_default', quote };
  for (const [virtualCls, sourceCls] of Object.entries(VIRTUAL_CLASSES)) {
    if (!provider.voices[virtualCls]) continue;
    const pool = data.quotes[sourceCls] || [];
    for (const quote of pool) yield { cls: virtualCls, quote };
  }
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
  console.log(`Provider:         ${provider.name}`);
  console.log(`Voiceable quotes: ${voiceable}`);
  console.log(`Skipped (contain {NAME}): ${namedSkipped}`);
  console.log(`Total characters: ${total}`);
  console.log(`Per voice:`);
  for (const [v, n] of Object.entries(perVoice)) console.log(`  ${v}: ${n} chars`);
  console.log(`\n${provider.quotaInfo} Re-runs of this script skip files that already exist.`);
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
    console.log(`[${s.cls}] provider=${provider.name} voice=${v.name} text="${text}"`);
    try {
      const mp3 = await tts(text, v.id);
      const file = path.join(outDir, `${provider.name}-${s.cls}.mp3`);
      fs.writeFileSync(file, mp3);
      console.log(`  → ${path.relative(REPO_ROOT, file)}  (${mp3.length} bytes)`);
    } catch (e) {
      console.error(`  ! ${v.name} failed: ${e.message}`);
      failures.push({ cls: s.cls, voice: v.name });
    }
    await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
  }
  if (failures.length) {
    console.log(`\n${failures.length} voice(s) need swapping in ${provider.name} provider config:`);
    failures.forEach(f => console.log(`  - ${f.cls} → ${f.voice}`));
  }
  console.log(`\nDone. Listen to:`);
  const paths = samples.map(s => `voices/samples/${provider.name}-${s.cls}.mp3`).join(' ');
  console.log(`  open ${paths}`);
}

async function runFull(onlyClasses, additive) {
  const data = loadQuotes();

  const manifestPath = path.join(VOICES_DIR, 'manifest.json');
  let manifest = {};
  let existingManifest = {};
  try { existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}

  if (additive) {
    // Start from the existing manifest; we'll only touch quotes that don't
    // already resolve to a working MP3.
    manifest = JSON.parse(JSON.stringify(existingManifest));
  } else if (onlyClasses) {
    // Preserve other classes; wipe the ones we're about to regenerate.
    manifest = JSON.parse(JSON.stringify(existingManifest));
    for (const c of onlyClasses) delete manifest[c];
  }

  let generated = 0, cached = 0, namedSkipped = 0, errors = 0, fellBack = 0, preserved = 0;
  let quotaHit = false;

  // Returns the relPath for a default-voice version of this quote that already
  // exists on disk (under either provider's hash), or null otherwise.
  // Lets us keep iPhone TTS working when the active provider hits quota.
  function fallback(cls, clean) {
    const slug = slugClass(cls);
    // Try active-provider default voice first.
    const activeFallback = `voices/${slug}/${hashKey(cls, clean, DEFAULT_VOICE.id)}.mp3`;
    if (fs.existsSync(path.join(REPO_ROOT, activeFallback))) return activeFallback;
    // Then any other provider's default voice for the same class+quote.
    for (const otherKey of Object.keys(PROVIDERS)) {
      if (otherKey === provider.name) continue;
      const other = PROVIDERS[otherKey];
      const otherDefault = other.voices[other.defaultVoiceKey];
      const otherHash = crypto.createHash('sha1')
        .update(`${cls}|${clean}|${other.name}|${otherDefault.id}`)
        .digest('hex').slice(0, 10);
      const otherPath = `voices/${slug}/${otherHash}.mp3`;
      if (fs.existsSync(path.join(REPO_ROOT, otherPath))) return otherPath;
    }
    return null;
  }

  function recordManifest(cls, quote, relPath) {
    manifest[cls] = manifest[cls] || {};
    manifest[cls][quote] = relPath;
  }

  for (const { cls, quote } of allItems(data)) {
    if (onlyClasses && !onlyClasses.has(cls)) continue;
    if (quote.includes('{NAME}')) { namedSkipped++; continue; }
    const clean = stripEmoji(quote);
    if (!clean) continue;

    // In additive mode, preserve any existing manifest entry (e.g. Antoni
    // dog clip from the ElevenLabs run) as long as its MP3 still exists.
    if (additive) {
      const prev = existingManifest[cls] && existingManifest[cls][quote];
      if (prev && fs.existsSync(path.join(REPO_ROOT, prev))) {
        recordManifest(cls, quote, prev);
        preserved++;
        continue;
      }
    }

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

    if (quotaHit) {
      const fb = fallback(cls, clean);
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
      if (/401|402|403|429/.test(e.message)) {
        console.error('Quota/auth error — finishing in fallback-only mode (no more API calls).');
        quotaHit = true;
      }
      const fb = fallback(cls, clean);
      if (fb) { recordManifest(cls, quote, fb); fellBack++; }
    }
  }

  fs.writeFileSync(
    path.join(VOICES_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  console.log(`\nProvider:     ${provider.name}`);
  console.log(`Generated:    ${generated}`);
  console.log(`Already had:  ${cached}`);
  if (additive) console.log(`Preserved:    ${preserved}`);
  console.log(`Fallback:     ${fellBack}`);
  console.log(`Skipped name: ${namedSkipped}`);
  console.log(`Errors:       ${errors}`);
  console.log(`Manifest:     ${path.relative(REPO_ROOT, path.join(VOICES_DIR, 'manifest.json'))}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--dry-run')) return runDryRun();

  if (!provider.apiKey()) {
    const envName = provider.name === 'cartesia' ? 'CARTESIA_API_KEY' : 'ELEVENLABS_API_KEY';
    console.error(`Missing ${envName}.`);
    console.error(`Run with:  node --env-file=.env scripts/generate-voices.js [--samples|--dry-run|--only <cls>]`);
    process.exit(1);
  }

  fs.mkdirSync(VOICES_DIR, { recursive: true });

  if (argv.includes('--samples')) return runSamples();

  let onlyClasses = null;
  const onlyIdx = argv.indexOf('--only');
  if (onlyIdx !== -1) {
    const val = argv[onlyIdx + 1];
    if (!val) { console.error('--only requires a comma-separated class list'); process.exit(1); }
    onlyClasses = new Set(val.split(',').map(s => s.trim()).filter(Boolean));
  }
  const additive = argv.includes('--additive');
  return runFull(onlyClasses, additive);
}

main().catch(e => { console.error(e); process.exit(1); });
