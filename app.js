// Compte-rendu v2 — enregistrement, transcription hybride (wifi = cloud / sinon = téléphone),
// reconnaissance des intervenants, résumé + actions, export Outlook et agenda
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const VERSION = '1.5.1'; // à augmenter à chaque mise à jour (aussi dans sw.js)
const CHUNK_MS = 15000; // l'audio est sauvegardé toutes les 15 s (rien n'est perdu en cas de coupure)

// ---------------- Réglages ----------------
const DEFAULTS = {
  policy: 'auto',
  summaryMobile: true,
  unknownWifi: false,
  diarize: true,
  autoDiarize: true,
  anthropicKey: '',
  claudeModel: 'claude-sonnet-5-5',
  context: "Bureau d'études en environnement (sites et sols pollués, diagnostics, hydrogéologie). Les réunions portent sur des chantiers, des clients, des offres et du suivi d'études.",
  stt: 'mistral',
  mistralKey: '',
  openaiKey: '',
  localModel: 'onnx-community/whisper-base',
  outlook: 'office',
  agenda: 'outlook',
  mailTo: '',
  ttsRate: '1',
  ttsEngine: 'auto',
};
const S = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('settings') || '{}'));
const saveSettings = () => localStorage.setItem('settings', JSON.stringify(S));
const modelReady = (m) => localStorage.getItem('modelReady:' + m) === '1';
const cloudKey = () => (S.stt === 'openai' ? S.openaiKey : S.mistralKey);

// ---------------- Base locale (IndexedDB) ----------------
const STORE = 'recs', CHUNKS = 'chunks';
let _db;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open('compte-rendu', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(CHUNKS)) d.createObjectStore(CHUNKS); // clé : [idEnregistrement, n°]
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}
const putRec = (r) => tx(STORE, 'readwrite', (s) => s.put(r));
const getRec = (id) => tx(STORE, 'readonly', (s) => s.get(id));
const allRecs = () => tx(STORE, 'readonly', (s) => s.getAll());
const delRec = (id) => tx(STORE, 'readwrite', (s) => s.delete(id));
const chunkRange = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);
const putChunk = (id, n, blob) => tx(CHUNKS, 'readwrite', (s) => s.put(blob, [id, n]));
const getChunks = (id) => tx(CHUNKS, 'readonly', (s) => s.getAll(chunkRange(id)));
const delChunks = (id) => tx(CHUNKS, 'readwrite', (s) => s.delete(chunkRange(id)));
async function patch(id, obj) { const r = await getRec(id); if (!r) return; Object.assign(r, obj); await putRec(r); refresh(id); return r; }
const lastPct = {};
function progress(id, p) {
  if (lastPct[id] != null && Math.abs(p - lastPct[id]) < 0.02 && p < 1) return;
  lastPct[id] = p;
  if (view === 'detail' && curId === id) { const bar = document.querySelector('#vDetail .prog i'); if (bar) bar.style.width = Math.round(p * 100) + '%'; }
}

// ---------------- Réseau ----------------
function netMode() {
  if (!navigator.onLine) return 'offline';
  const t = navigator.connection && navigator.connection.type;
  if (t === 'wifi' || t === 'ethernet') return 'wifi';
  if (t === 'cellular' || t === 'wimax' || t === 'bluetooth') return 'mobile';
  if (t === 'none') return 'offline';
  return S.unknownWifi ? 'wifi' : 'mobile';
}
const NET_LABEL = { wifi: '📶 Wifi', mobile: '📱 Données mobiles', offline: '✈ Hors ligne' };
function transcribeRoute(n = netMode()) {
  const canLocal = modelReady(S.localModel) || n === 'wifi'; // jamais de téléchargement du modèle en 4G
  if (S.policy === 'cloud') return n !== 'offline' && cloudKey() ? 'cloud' : (canLocal ? 'local' : 'wait');
  if (S.policy === 'local') return canLocal ? 'local' : 'wait';
  if (n === 'wifi' && cloudKey()) return 'cloud';
  return canLocal ? 'local' : 'wait';
}
function canSummarize(n = netMode()) {
  return !!S.anthropicKey && (n === 'wifi' || (n === 'mobile' && S.summaryMobile));
}
function updateNet() {
  const n = netMode();
  $('#netChip').textContent = { wifi: '📶 Wifi', mobile: '📱 4G', offline: '✈ Hors ligne' }[n];
  const tr = transcribeRoute(n);
  const txt = {
    cloud: 'Transcription dans le cloud' + (S.diarize ? ' avec reconnaissance des intervenants.' : '.'),
    local: 'Transcription sur le téléphone (aucun envoi audio, sans distinction des intervenants' + (S.autoDiarize ? ' — ajoutée au retour du wifi' : '') + ').',
    wait: n === 'offline' ? 'Transcription mise en attente du réseau.' : 'Transcription en attente du wifi (modèle local pas encore téléchargé).',
  }[tr];
  const sum = n === 'wifi' ? 'Résumé envoyé immédiatement.'
    : n === 'mobile' ? (S.summaryMobile ? 'Résumé envoyé (texte seul, quelques Ko).' : 'Résumé en attente du wifi.')
    : 'Résumé en attente du réseau.';
  $('#netExplain').innerHTML = `<b>${NET_LABEL[n]}</b> — ${txt} ${sum}`;
}
window.addEventListener('online', () => { updateNet(); resumeQueue(); });
window.addEventListener('offline', updateNet);
navigator.connection && navigator.connection.addEventListener('change', () => { updateNet(); resumeQueue(); });

// ---------------- Enregistrement (un seul fichier continu, sauvegardé par morceaux) ----------------
const R = { stream: null, mr: null, id: null, start: 0, tick: null, wake: null, ac: null, raf: null, mime: '', n: 0, writes: Promise.resolve() };
function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}
const fmt = (ms) => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); };

async function startRecording() {
  try {
    R.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) { toast('Micro refusé : autorisez le micro pour cette application.'); return; }
  R.mime = pickMime(); R.id = 'r' + Date.now(); R.n = 0; R.start = Date.now(); R.writes = Promise.resolve();
  const d = new Date(), id = R.id;
  await putRec({ id, created: d.toISOString(), title: 'Réunion du ' + d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), segments: [], duration: 0, status: 'recording', mime: R.mime });
  const mr = new MediaRecorder(R.stream, R.mime ? { mimeType: R.mime, audioBitsPerSecond: 24000 } : undefined);
  mr.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const n = R.n++;
    R.writes = R.writes.then(() => putChunk(id, n, e.data)).then(() => patch(id, { duration: Date.now() - R.start }));
  };
  mr.start(CHUNK_MS);
  R.mr = mr;
  R.tick = setInterval(() => { $('#timer').textContent = fmt(Date.now() - R.start); }, 500);
  try { R.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  meter();
  $('#recBtn').classList.add('on'); $('#recBtn').textContent = '■ Arrêter';
  $('#recPanel').classList.remove('hidden'); $('#homeTools').classList.add('hidden');
  renderList();
}
async function assemble(id, mime) {
  const parts = await getChunks(id);
  if (!parts.length) return null;
  const blob = new Blob(parts, { type: mime || parts[0].type || 'audio/webm' });
  const r = await getRec(id);
  r.segments = [blob]; await putRec(r);
  await delChunks(id);
  return blob;
}
async function stopRecording() {
  clearInterval(R.tick); cancelAnimationFrame(R.raf);
  const stopped = new Promise((res) => (R.mr.onstop = res));
  R.mr.stop();
  await stopped;
  await R.writes;
  R.stream.getTracks().forEach((t) => t.stop());
  if (R.ac) R.ac.close();
  if (R.wake) { R.wake.release().catch(() => {}); R.wake = null; }
  const id = R.id; R.id = null;
  await assemble(id, R.mime);
  await patch(id, { status: 'recorded', duration: Date.now() - R.start });
  $('#recBtn').classList.remove('on'); $('#recBtn').textContent = '● Enregistrer';
  $('#recPanel').classList.add('hidden'); $('#homeTools').classList.remove('hidden'); $('#timer').textContent = '00:00';
  openDetail(id);
  processRec(id);
}
function meter() {
  try {
    R.ac = new AudioContext();
    const src = R.ac.createMediaStreamSource(R.stream), an = R.ac.createAnalyser();
    an.fftSize = 512; src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const loop = () => { an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); $('#lvl').style.width = Math.min(100, m * 1.6) + '%'; R.raf = requestAnimationFrame(loop); };
    loop();
  } catch (e) {}
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && R.id && !R.wake) { try { R.wake = await navigator.wakeLock.request('screen'); } catch (e) {} }
});
$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const id = 'r' + Date.now(), d = new Date();
  let duration = 0;
  try { duration = await new Promise((res) => { const a = new Audio(URL.createObjectURL(f)); a.onloadedmetadata = () => res((a.duration || 0) * 1000); a.onerror = () => res(0); }); } catch (_) {}
  await putRec({ id, created: d.toISOString(), title: f.name.replace(/\.[^.]+$/, ''), segments: [f], duration: isFinite(duration) ? duration : 0, status: 'recorded', mime: f.type });
  e.target.value = '';
  openDetail(id); processRec(id);
});

// ---------------- Transcription cloud (avec intervenants) ----------------
async function cloudTranscribe(blob) {
  const ext = blob.type.includes('ogg') ? 'ogg' : /mp4|m4a/.test(blob.type) ? 'm4a' : blob.type.includes('mpeg') ? 'mp3' : blob.type.includes('wav') ? 'wav' : 'webm';
  const fd = new FormData();
  fd.append('file', blob, 'audio.' + ext);
  fd.append('language', 'fr');
  let url, key;
  if (S.stt === 'openai') {
    url = 'https://api.openai.com/v1/audio/transcriptions'; key = S.openaiKey;
    if (S.diarize) { fd.append('model', 'gpt-4o-transcribe-diarize'); fd.append('response_format', 'diarized_json'); fd.append('chunking_strategy', 'auto'); }
    else fd.append('model', 'gpt-4o-mini-transcribe');
  } else {
    url = 'https://api.mistral.ai/v1/audio/transcriptions'; key = S.mistralKey;
    fd.append('model', 'voxtral-mini-latest');
    if (S.diarize) { fd.append('diarize', 'true'); fd.append('timestamp_granularities', 'segment'); }
  }
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd });
  if (!r.ok) throw new Error('Transcription cloud : ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const segs = (j.segments || []).map((s) => ({ raw: s.speaker_id ?? s.speaker ?? null, start: s.start || 0, text: (s.text || '').trim() })).filter((s) => s.text);
  return { text: (j.text || segs.map((s) => s.text).join(' ')).trim(), segs };
}
// Regroupe les segments en tours de parole « Intervenant 1, 2… » (ordre d'apparition)
function toUtterances(segs) {
  const map = {}; let k = 0; const out = [];
  for (const s of segs) {
    let spk = null;
    if (s.raw != null && s.raw !== '') { if (!(s.raw in map)) map[s.raw] = 'Intervenant ' + (++k); spk = map[s.raw]; }
    const last = out[out.length - 1];
    if (last && last.spk === spk) last.text += ' ' + s.text;
    else out.push({ spk, start: s.start, text: s.text });
  }
  return out;
}
const hasSpeakers = (r) => !!(r.utterances && r.utterances.some((u) => u.spk));

// ---------------- Transcription locale (worker Whisper) ----------------
let worker, wseq = 0;
const wcb = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker('whisper-worker.js', { type: 'module' });
  worker.onmessage = (e) => { const cb = wcb.get(e.data.id); cb && cb(e.data); };
  worker.onerror = (e) => { for (const cb of wcb.values()) cb({ type: 'error', error: e.message || 'Erreur du moteur local' }); };
  return worker;
}
function wcall(msg, onProgress, transfer) {
  return new Promise((res, rej) => {
    const id = ++wseq;
    wcb.set(id, (d) => {
      if (d.type === 'progress') onProgress && onProgress(d);
      else if (d.type === 'device') console.log('Whisper sur', d.device);
      else { wcb.delete(id); d.type === 'error' ? rej(new Error(d.error)) : res(d); }
    });
    getWorker().postMessage({ id, ...msg }, transfer || []);
  });
}
async function ensureModel(onProgress) {
  const files = {};
  await wcall({ type: 'load', model: S.localModel }, (d) => {
    files[d.file] = d;
    const tot = Object.values(files).reduce((a, f) => a + f.total, 0), ld = Object.values(files).reduce((a, f) => a + f.loaded, 0);
    onProgress && onProgress(ld / tot);
  });
  localStorage.setItem('modelReady:' + S.localModel, '1');
}
async function toPCM(blob) {
  const ac = new AudioContext({ sampleRate: 16000 });
  try {
    const buf = await ac.decodeAudioData(await blob.arrayBuffer());
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    const a = buf.getChannelData(0), b = buf.getChannelData(1), out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
    return out;
  } finally { ac.close(); }
}
async function localTranscribe(blob, onStep) {
  const pcm = await toPCM(blob);
  const CH = 16000 * 300;
  const parts = [];
  for (let i = 0; i < pcm.length; i += CH) {
    onStep && onStep(i / pcm.length);
    const slice = pcm.slice(i, i + CH);
    const r = await wcall({ type: 'transcribe', model: S.localModel, audio: slice, language: 'french' }, null, [slice.buffer]);
    parts.push(r.text);
  }
  return parts.join(' ').trim();
}

// ---------------- Résumé + actions + intervenants (Claude) ----------------
async function summarize(rec, extra) {
  const d = new Date(rec.created);
  const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const system = `Tu rédiges des comptes-rendus de réunion pour un professionnel. Contexte métier : ${S.context}
La transcription provient d'une reconnaissance vocale automatique : elle peut contenir des erreurs et des mots mal reconnus. Corrige mentalement les erreurs évidentes, mais n'invente rien.
${hasSpeakers(rec) ? `Les tours de parole sont étiquetés [Intervenant 1], [Intervenant 2]… Déduis si possible le nom réel de chacun à partir du contenu (ex. « merci Pierre », présentation, rôle). Pour le champ "responsable" d'une action, utilise le nom réel s'il est connu, sinon l'étiquette exacte « Intervenant N ».` : `La transcription ne distingue pas les intervenants.`}
Si une information (responsable, échéance) n'est pas dite, mets null. Convertis les échéances relatives (« vendredi », « fin du mois », « sous 15 jours ») en date AAAA-MM-JJ par rapport à la date de la réunion.
Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, au format :
{"titre": "titre court et parlant",
 "resume": "résumé en 5 à 10 phrases",
 "intervenants": [{"label": "Intervenant 1", "nom_probable": "nom ou null", "role_probable": "rôle ou null"}],
 "points_cles": ["…"],
 "decisions": ["…"],
 "actions": [{"action": "verbe à l'infinitif + objet précis", "responsable": "nom, Intervenant N, ou null", "echeance": "échéance telle que dite, ou null", "echeance_date": "AAAA-MM-JJ ou null", "priorite": "haute|normale|basse"}],
 "questions_ouvertes": ["…"],
 "prochaine_reunion": {"date": "AAAA-MM-JJ", "heure": "HH:MM ou null", "objet": "…"} ou null}`;
  const user = `Date de la réunion : ${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} (${iso})\nTitre provisoire : ${rec.title}\n${extra ? 'Consigne complémentaire : ' + extra + '\n' : ''}\nTranscription :\n"""\n${rec.transcript}\n"""`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': S.anthropicKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: S.claudeModel, max_tokens: 5000, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!r.ok) throw new Error('Résumé : ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  const txt = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const out = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  out.actions = (out.actions || []).map((x) => ({ ...x, echeance_date: /^\d{4}-\d{2}-\d{2}$/.test(x.echeance_date || '') ? x.echeance_date : '', fait: false }));
  if (out.prochaine_reunion && !/^\d{4}-\d{2}-\d{2}$/.test(out.prochaine_reunion.date || '')) out.prochaine_reunion = null;
  return out;
}

// ---------------- Chaîne de traitement + file d'attente ----------------
const busy = new Set();
const anyDone = (r) => !!(r.summary && r.summary.actions.some((a) => a.fait));
// Ajout automatique des intervenants au retour du wifi (si transcrit sur le téléphone)
const needsDiarize = (r) => S.diarize && S.autoDiarize && r.transcript && r.transcriptMode === 'local' && !r.diarizeTried && !anyDone(r) && netMode() === 'wifi' && cloudKey();

async function processRec(id, opts = {}) {
  if (busy.has(id)) return;
  busy.add(id);
  try {
    let r = await getRec(id);
    if (!r || r.status === 'recording') return;
    const n = netMode();
    const redo = opts.rediarize || needsDiarize(r);
    if (!r.transcript || redo) {
      const route = redo || opts.forceCloud ? 'cloud' : opts.forceLocal ? 'local' : transcribeRoute(n);
      if (route === 'wait') { await patch(id, { status: 'wait', info: n === 'offline' ? 'En attente de réseau pour transcrire' : 'En attente du wifi pour transcrire' }); return; }
      if (redo) r = await patch(id, { diarizeTried: true });
      const segs = r.segments.filter(Boolean);
      if (route === 'local' && !modelReady(S.localModel)) {
        await patch(id, { status: 'run', info: 'Téléchargement du modèle local…', pct: 0 });
        await ensureModel((p) => progress(id, p));
      }
      const texts = [], all = [];
      for (let i = 0; i < segs.length; i++) {
        const lab = route === 'cloud' ? (S.diarize ? 'Transcription et identification des intervenants' : 'Transcription cloud') : 'Transcription sur le téléphone';
        await patch(id, { status: 'run', info: `${lab}… ${segs.length > 1 ? 'partie ' + (i + 1) + '/' + segs.length : ''}`, pct: i / segs.length });
        if (route === 'cloud') { const c = await cloudTranscribe(segs[i]); texts.push(c.text); all.push(...c.segs); }
        else texts.push(await localTranscribe(segs[i], (p) => progress(id, (i + p) / segs.length)));
      }
      const utterances = all.length ? toUtterances(all) : null;
      const transcript = utterances && utterances.some((u) => u.spk) ? utterances.map((u) => `[${u.spk}] ${u.text}`).join('\n') : texts.join('\n\n');
      r = await patch(id, { transcript, utterances, transcriptMode: route, pct: null, names: redo ? {} : (r.names || {}), guessed: {} });
      if (redo && r.summary) opts.resummarize = true;
    }
    if (!r.summary || opts.resummarize) {
      if (!S.anthropicKey) { await patch(id, { status: 'wait', info: 'Ajoutez la clé API Anthropic dans les réglages pour le résumé' }); return; }
      if (!opts.forceSummary && !canSummarize(netMode())) { await patch(id, { status: 'wait', info: netMode() === 'offline' ? 'Résumé en attente de réseau' : 'Résumé en attente du wifi' }); return; }
      await patch(id, { status: 'run', info: 'Rédaction du résumé et des actions…', pct: null });
      const sum = await summarize(r, opts.extra);
      // noms suggérés par Claude (modifiables)
      const names = { ...(r.names || {}) }, guessed = { ...(r.guessed || {}) };
      for (const it of sum.intervenants || []) if (it.label && it.nom_probable && !names[it.label]) { names[it.label] = it.nom_probable; guessed[it.label] = true; }
      await patch(id, { summary: sum, names, guessed, title: r.titleEdited ? r.title : (sum.titre || r.title) });
    }
    await patch(id, { status: 'done', info: '' });
  } catch (e) {
    console.error(e);
    await patch(id, { status: 'error', info: e.message, pct: null });
  } finally { busy.delete(id); }
}
async function resumeQueue() {
  for (const r of await allRecs()) if (['wait', 'recorded'].includes(r.status) || (r.status === 'done' && needsDiarize(r))) processRec(r.id);
}

// ---------------- Noms des intervenants ----------------
function namer(r) {
  const names = r.names || {};
  const labels = Object.keys(names).filter((l) => names[l]).sort((a, b) => b.length - a.length);
  return (s) => { let t = String(s ?? ''); for (const l of labels) t = t.replace(new RegExp(l + '(?!\\d)', 'g'), names[l]); return t; };
}
function speakerStats(r) {
  const st = {};
  const us = r.utterances || [];
  us.forEach((u, i) => {
    if (!u.spk) return;
    const end = us[i + 1] ? us[i + 1].start : u.start + u.text.length / 15;
    const s = st[u.spk] || (st[u.spk] = { t: 0, first: u.text, start: u.start });
    s.t += Math.max(0, end - u.start);
  });
  const tot = Object.values(st).reduce((a, s) => a + s.t, 0) || 1;
  return Object.entries(st).map(([label, s]) => ({ label, pct: Math.round((s.t / tot) * 100), first: s.first, start: s.start }));
}

// ---------------- Exports : texte, Outlook, agenda ----------------
const fmtD = (iso) => (iso ? new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '');
function exportText(r, md) {
  const s = r.summary || {}, nm = namer(r);
  const H = (t) => (md ? `\n## ${t}\n` : `\n${t.toUpperCase()}\n`);
  const L = (t, arr) => (arr && arr.length ? H(t) + arr.map((x) => '- ' + nm(x)).join('\n') + '\n' : '');
  const parts = speakerStats(r).map((x) => nm(x.label));
  const acts = (s.actions || []).map((a) => `${md ? '- [' + (a.fait ? 'x' : ' ') + ']' : a.fait ? '☑' : '☐'} ${nm(a.action)}${a.responsable ? ' — ' + nm(a.responsable) : ''}${a.echeance_date ? ' — pour le ' + fmtD(a.echeance_date) : a.echeance ? ' — ' + a.echeance : ''}${a.priorite === 'haute' ? ' (PRIORITAIRE)' : ''}`).join('\n');
  const pr = s.prochaine_reunion;
  return `${md ? '# ' : 'COMPTE-RENDU — '}${r.title}\n${new Date(r.created).toLocaleString('fr-FR')} · durée ${fmt(r.duration || 0)}\n${parts.length ? 'Participants : ' + parts.join(', ') + '\n' : ''}${H('Résumé')}${nm(s.resume || '')}\n${L('Points clés', s.points_cles)}${L('Décisions', s.decisions)}${acts ? H('Actions à réaliser') + acts + '\n' : ''}${L('Questions ouvertes', s.questions_ouvertes)}${pr ? H('Prochaine réunion') + fmtD(pr.date) + (pr.heure ? ' à ' + pr.heure : '') + ' — ' + nm(pr.objet || '') + '\n' : ''}`;
}
async function sendOutlook(r) {
  const body = exportText(r, false);
  try { await navigator.clipboard.writeText(body); } catch (_) {}
  const base = S.outlook === 'live' ? 'https://outlook.live.com/mail/0/deeplink/compose' : 'https://outlook.office.com/mail/deeplink/compose';
  const MAX = 5000;
  const b = body.length > MAX ? body.slice(0, MAX) + '\n\n[… suite tronquée : le compte-rendu complet est dans le presse-papiers, collez-le ici]' : body;
  const q = new URLSearchParams({ subject: 'Compte-rendu – ' + r.title, body: b });
  if (S.mailTo) q.set('to', S.mailTo);
  window.open(base + '?' + q.toString().replace(/\+/g, '%20'), '_blank');
  toast('Ouverture d\'Outlook — texte aussi copié');
}
// Événements d'agenda
function actionEvent(r, a) {
  const nm = namer(r);
  return { title: '☐ ' + nm(a.action) + (a.responsable ? ' (' + nm(a.responsable) + ')' : ''), date: a.echeance_date, time: null,
    body: `Action issue de la réunion « ${r.title} » du ${new Date(r.created).toLocaleDateString('fr-FR')}.\nResponsable : ${nm(a.responsable) || 'non précisé'}\nPriorité : ${a.priorite || 'normale'}` };
}
function meetingEvent(r) {
  const p = r.summary.prochaine_reunion, nm = namer(r);
  return { title: 'Réunion : ' + nm(p.objet || r.title), date: p.date, time: /^\d{1,2}:\d{2}$/.test(p.heure || '') ? p.heure.padStart(5, '0') : null, body: `Suite de la réunion « ${r.title} » du ${new Date(r.created).toLocaleDateString('fr-FR')}.` };
}
const nextDay = (iso) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };
const addHour = (iso, t) => { const d = new Date(iso + 'T' + t + ':00'); d.setHours(d.getHours() + 1); return d; };
const loc = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':00';
function calendarUrl(ev) {
  if (S.agenda === 'google') {
    const dates = ev.time ? `${ev.date.replace(/-/g, '')}T${ev.time.replace(':', '')}00/${loc(addHour(ev.date, ev.time)).replace(/[-:]/g, '')}` : `${ev.date.replace(/-/g, '')}/${nextDay(ev.date).replace(/-/g, '')}`;
    return 'https://calendar.google.com/calendar/render?' + new URLSearchParams({ action: 'TEMPLATE', text: ev.title, details: ev.body, dates, ctz: 'Europe/Paris' });
  }
  const base = S.outlook === 'live' ? 'https://outlook.live.com/calendar/0/deeplink/compose' : 'https://outlook.office.com/calendar/deeplink/compose';
  const q = { path: '/calendar/action/compose', rru: 'addevent', subject: ev.title, body: ev.body };
  if (ev.time) Object.assign(q, { startdt: ev.date + 'T' + ev.time + ':00', enddt: loc(addHour(ev.date, ev.time)), allday: 'false' });
  else Object.assign(q, { startdt: ev.date, enddt: nextDay(ev.date), allday: 'true' });
  return base + '?' + new URLSearchParams(q).toString().replace(/\+/g, '%20');
}
function ics(events) {
  const e = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const fold = (line) => { const out = []; let cur = ''; for (const ch of line) { if (new TextEncoder().encode(cur + ch).length > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch; } out.push(cur); return out.join('\r\n'); };
  const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//G ENVIRONNEMENT//Compte-rendu//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  events.forEach((ev, i) => {
    L.push('BEGIN:VEVENT', 'UID:' + Date.now() + '-' + i + '@compte-rendu', 'DTSTAMP:' + utc(new Date()));
    if (ev.time) { const s = new Date(ev.date + 'T' + ev.time + ':00'); L.push('DTSTART:' + utc(s), 'DTEND:' + utc(addHour(ev.date, ev.time))); }
    else L.push('DTSTART;VALUE=DATE:' + ev.date.replace(/-/g, ''), 'DTEND;VALUE=DATE:' + nextDay(ev.date).replace(/-/g, ''), 'TRANSP:TRANSPARENT');
    L.push('SUMMARY:' + e(ev.title), 'DESCRIPTION:' + e(ev.body), 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + e(ev.title), ev.time ? 'TRIGGER:-PT30M' : 'TRIGGER:-PT15H', 'END:VALARM', 'END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
async function shareIcs(events, name) {
  const file = new File([ics(events)], name.replace(/[^\w\- àâäéèêëïîôöùûüç]/gi, '_') + '.ics', { type: 'text/calendar' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
}
function addToCalendar(ev, r) {
  if (S.agenda === 'ics') shareIcs([ev], ev.title);
  else window.open(calendarUrl(ev), '_blank');
}

// ---------------- Interface ----------------
let view = 'home', curId = null;
function show(v) {
  view = v;
  $('#vHome').classList.toggle('hidden', v !== 'home');
  $('#vDetail').classList.toggle('hidden', v !== 'detail');
  $('#vSettings').classList.toggle('hidden', v !== 'settings');
  $('#backBtn').classList.toggle('hidden', v === 'home');
  $('#setBtn').classList.toggle('hidden', v === 'settings');
  $('#title').textContent = v === 'settings' ? 'Réglages' : 'Compte-rendu';
  window.scrollTo(0, 0);
}
function badge(r) {
  const m = { recording: ['run', 'Enregistrement'], recorded: ['wait', 'À traiter'], wait: ['wait', 'En attente'], run: ['run', 'En cours'], done: ['ok', 'Prêt'], error: ['err', 'Erreur'] }[r.status] || ['', r.status];
  return `<span class="badge ${m[0]}">${m[1]}</span>`;
}
// Suppression par glissé vers la droite, avec possibilité d'annuler pendant 5 s
const pendingDel = new Map();
function swipeDelete(id) {
  if (pendingDel.has(id)) return;
  const timer = setTimeout(async () => { pendingDel.delete(id); await delRec(id); await delChunks(id); renderList(); }, 5000);
  pendingDel.set(id, timer);
  renderList();
  toast('Enregistrement supprimé', 'Annuler', () => { clearTimeout(pendingDel.get(id)); pendingDel.delete(id); renderList(); }, 5000);
}
function attachSwipe(row) {
  const inner = row.querySelector('.inner');
  let x0 = 0, y0 = 0, dx = 0, mode = null, id = null;
  row.addEventListener('pointerdown', (e) => { if (R.id && row.dataset.id === R.id) return; x0 = e.clientX; y0 = e.clientY; dx = 0; mode = 'maybe'; id = e.pointerId; inner.style.transition = 'none'; });
  row.addEventListener('pointermove', (e) => {
    if (!mode || e.pointerId !== id) return;
    const ddx = e.clientX - x0, ddy = e.clientY - y0;
    if (mode === 'maybe') {
      if (Math.abs(ddy) > 10 && Math.abs(ddy) > Math.abs(ddx)) { mode = null; return; } // défilement vertical
      if (ddx > 12 && Math.abs(ddx) > Math.abs(ddy)) { mode = 'swipe'; row.setPointerCapture(id); row.classList.add('swiping'); }
    }
    if (mode === 'swipe') { dx = Math.max(0, ddx); inner.style.transform = `translateX(${dx}px)`; row.classList.toggle('armed', dx > row.offsetWidth * 0.4); }
  });
  const end = () => {
    if (mode === 'swipe') {
      row.dataset.swiped = '1'; setTimeout(() => delete row.dataset.swiped, 50);
      inner.style.transition = 'transform .2s';
      if (dx > row.offsetWidth * 0.4) { inner.style.transform = 'translateX(110%)'; setTimeout(() => swipeDelete(row.dataset.id), 180); }
      else { inner.style.transform = ''; row.classList.remove('swiping', 'armed'); }
    }
    mode = null;
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', end);
}
async function renderList() {
  const recs = (await allRecs()).filter((r) => !pendingDel.has(r.id)).sort((a, b) => b.created.localeCompare(a.created));
  $('#recList').innerHTML = recs.length ? recs.map((r) => {
    const open = r.summary ? r.summary.actions.filter((a) => !a.fait).length : 0;
    return `<div class="item" data-id="${r.id}"><div class="del">🗑 Supprimer</div><div class="inner"><b>${esc(r.title)}</b><span class="muted">${new Date(r.created).toLocaleDateString('fr-FR')} · ${fmt(r.duration || 0)}</span> ${badge(r)}${r.summary ? `<span class="badge">${open} action(s) ouverte(s)</span>` : ''}${hasSpeakers(r) ? `<span class="badge">👥 ${speakerStats(r).length}</span>` : ''}</div></div>`;
  }).join('') + '<div class="muted" style="text-align:center;font-size:12px;padding-top:8px">Glissez un enregistrement vers la droite pour le supprimer</div>'
    : '<div class="muted" style="text-align:center;padding:10px">Aucun enregistrement pour l\'instant.</div>';
  $('#recList').querySelectorAll('.item').forEach((el) => {
    el.onclick = () => { if (!el.dataset.swiped) openDetail(el.dataset.id); };
    attachSwipe(el);
  });
}
// ---------------- Lecture à haute voix (synthèse vocale du téléphone, sans connexion) ----------------
const TTS = { on: null, wake: null, queue: [], started: false, watch: null, text: '', loading: false, audio: null, cache: new Map() };
const hasTTS = 'speechSynthesis' in window;
const canCloudTTS = () => !!S.mistralKey && navigator.onLine;
function frVoice() {
  const vs = hasTTS ? speechSynthesis.getVoices() : [];
  return vs.find((v) => /^fr[-_]FR/i.test(v.lang) && /google/i.test(v.name)) || vs.find((v) => /^fr[-_]FR/i.test(v.lang)) || vs.find((v) => /^fr/i.test(v.lang)) || null;
}
function stopSpeak() {
  TTS.queue = [];
  if (hasTTS && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
  if (TTS.audio) { try { TTS.audio.pause(); } catch (e) {} }
  TTS.on = null; TTS.loading = false;
  clearTimeout(TTS.watch);
  if (TTS.wake) { TTS.wake.release().catch(() => {}); TTS.wake = null; }
  updSpeakBtns();
}
// Le moteur vocal du téléphone ne marche pas : on passe à la voix en ligne (Mistral) si possible
function phoneFailed(kind, msg) {
  if (S.ttsEngine !== 'phone' && canCloudTTS()) { localStorage.setItem('ttsPhoneBroken', '1'); const t = TTS.text; stopSpeak(); speakCloud(kind, t); return; }
  toast(msg, null, null, 7000); stopSpeak();
}
// Lecture phrase par phrase (plus fiable sur Chrome Android que de tout empiler d'un coup)
function speakNext(kind) {
  if (TTS.on !== kind) return;
  const c = TTS.queue.shift();
  if (!c) return stopSpeak();
  // niveaux de repli : 0 = voix française choisie, 1 = voix par défaut en français, 2 = voix par défaut du téléphone
  const lvl = +(localStorage.getItem('ttsLevel') || 0);
  const u = new SpeechSynthesisUtterance(c);
  u.rate = lvl ? 1 : (+S.ttsRate || 1); u.volume = 1;
  if (lvl < 2) u.lang = 'fr-FR';
  if (lvl === 0) { const v = frVoice(); if (v) { try { u.voice = v; } catch (e) {} } }
  u.onstart = () => { TTS.started = true; clearTimeout(TTS.watch); };
  u.onend = () => speakNext(kind);
  u.onerror = (e) => {
    if (TTS.on !== kind) return;
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    if (e.error === 'synthesis-failed' && lvl < 2 && !TTS.started) { localStorage.setItem('ttsLevel', lvl + 1); TTS.queue.unshift(c); setTimeout(() => speakNext(kind), 200); return; }
    phoneFailed(kind, e.error === 'synthesis-failed' ? 'Le moteur vocal du téléphone a échoué : voir ⚙ Réglages › Lecture à haute voix' : 'Lecture impossible : ' + e.error);
  };
  speechSynthesis.resume();
  speechSynthesis.speak(u);
}
function speak(kind, text) {
  if (TTS.on === kind) return stopSpeak();
  if (TTS.on) stopSpeak();
  TTS.text = text;
  const useCloud = S.ttsEngine === 'cloud' || !hasTTS || (S.ttsEngine !== 'phone' && localStorage.getItem('ttsPhoneBroken') === '1' && canCloudTTS());
  if (useCloud) return speakCloud(kind, text);
  const wasBusy = speechSynthesis.speaking || speechSynthesis.pending;
  if (wasBusy) speechSynthesis.cancel();
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?;]+[.!?;]*/g) || [text];
  const chunks = []; let cur = '';
  for (const p of parts) { if ((cur + p).length > 200 && cur) { chunks.push(cur.trim()); cur = p; } else cur += p; }
  if (cur.trim()) chunks.push(cur.trim());
  TTS.queue = chunks; TTS.on = kind; TTS.started = false; updSpeakBtns();
  try { navigator.wakeLock.request('screen').then((w) => { if (TTS.on) TTS.wake = w; else w.release(); }).catch(() => {}); } catch (e) {}
  // si rien ne démarre en 4 s : voix en ligne, ou conseil (volume média, moteur vocal)
  clearTimeout(TTS.watch);
  TTS.watch = setTimeout(() => { if (TTS.on === kind && !TTS.started) phoneFailed(kind, 'Aucun son ? Montez le volume MÉDIA pendant la lecture, et vérifiez le moteur de synthèse vocale (⚙ Réglages)'); }, 4000);
  if (wasBusy) setTimeout(() => speakNext(kind), 250); // Chrome Android ignore un speak() juste après cancel()
  else speakNext(kind);
}
// Voix en ligne Mistral (Voxtral TTS) : ne dépend pas du moteur vocal du téléphone. Quelques centimes par lecture.
async function cloudVoice() {
  // voix française prédéfinie de Mistral (Marie, ton neutre)
  return localStorage.getItem('ttsCloudVoice') || 'fr_marie_neutral';
}
async function speakCloud(kind, text) {
  if (!S.mistralKey) { toast('Voix en ligne : clé Mistral manquante (⚙ Réglages)'); return stopSpeak(); }
  if (!navigator.onLine) { toast('Voix en ligne : pas de réseau'); return stopSpeak(); }
  clearTimeout(TTS.watch);
  TTS.on = kind; TTS.loading = true; TTS.text = text; updSpeakBtns();
  try { navigator.wakeLock.request('screen').then((w) => { if (TTS.on) TTS.wake = w; else w.release(); }).catch(() => {}); } catch (e) {}
  try {
    let url = TTS.cache.get(text);
    if (!url) {
      const voice = await cloudVoice();
      const call = (model) => fetch('https://api.mistral.ai/v1/audio/speech', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.mistralKey },
        body: JSON.stringify(Object.assign({ model, input: text, response_format: 'mp3' }, voice ? { voice_id: voice } : {})),
      });
      let r = await call('voxtral-mini-tts-3-0');
      if (r.status === 400 || r.status === 404 || r.status === 422) { const r2 = await call('voxtral-mini-tts-2603'); if (r2.ok) r = r2; }
      if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 160));
      const j = await r.json();
      const bin = Uint8Array.from(atob(j.audio_data), (ch) => ch.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bin], { type: 'audio/mpeg' }));
      TTS.cache.set(text, url); // relire le même texte ne coûte rien
    }
    if (TTS.on !== kind) return;
    TTS.loading = false; updSpeakBtns();
    const a = TTS.audio || (TTS.audio = new Audio());
    a.src = url; a.playbackRate = +S.ttsRate || 1;
    a.onended = () => { if (TTS.on === kind) stopSpeak(); };
    await a.play();
  } catch (e) {
    if (TTS.on === kind) { toast('Voix en ligne : ' + e.message, null, null, 7000); stopSpeak(); }
  }
}
function updSpeakBtns() {
  document.querySelectorAll('[data-speak]').forEach((b) => {
    const k = b.dataset.speak, on = TTS.on === k;
    b.textContent = on ? (TTS.loading ? '⏳ Préparation de la voix…' : '⏹ Arrêter la lecture') : k === 'sum' ? '🔊 Écouter le résumé' : '🔊 Écouter les actions';
    b.classList.toggle('pri', on);
  });
}
if (hasTTS) { speechSynthesis.getVoices(); speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', () => {}); }
const dLong = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
function summarySpeech(r) {
  const s = r.summary, nm = namer(r);
  const end = (x) => { x = nm(x).trim(); return /[.!?]$/.test(x) ? x : x + '.'; };
  let t = `Compte-rendu : ${r.title}. ${nm(s.resume)} `;
  if (s.points_cles && s.points_cles.length) t += 'Points clés : ' + s.points_cles.map(end).join(' ') + ' ';
  if (s.decisions && s.decisions.length) t += 'Décisions : ' + s.decisions.map(end).join(' ') + ' ';
  const p = s.prochaine_reunion;
  if (p) t += `Prochaine réunion le ${dLong(p.date)}${p.heure ? ' à ' + p.heure.replace(/^0?(\d+):00$/, '$1 heures').replace(/^0?(\d+):(\d+)$/, '$1 heures $2') : ''}. `;
  return t;
}
function actionsSpeech(r) {
  const nm = namer(r), open = r.summary.actions.filter((a) => !a.fait);
  if (!open.length) return 'Aucune action en attente.';
  return `${open.length} action${open.length > 1 ? 's' : ''} à réaliser. ` + open.map((a, i) =>
    `Action ${i + 1} : ${nm(a.action).replace(/\.$/, '')}.${a.responsable ? ' Responsable : ' + nm(a.responsable) + '.' : ''}${a.echeance_date ? ' Pour le ' + dLong(a.echeance_date) + '.' : a.echeance ? ' Échéance : ' + a.echeance + '.' : ''}${a.priorite === 'haute' ? ' Prioritaire.' : ''}`).join(' ');
}
async function openDetail(id) { if (id !== curId) stopSpeak(); curId = id; show('detail'); await renderDetail(); }
async function renderDetail() {
  const r = await getRec(curId);
  if (!r) { show('home'); return; }
  const s = r.summary, nm = namer(r), n = netMode();
  (renderDetail.urls || []).forEach((u) => URL.revokeObjectURL(u));
  const urls = (renderDetail.urls = (r.segments || []).filter(Boolean).map((b) => URL.createObjectURL(b)));
  const spk = speakerStats(r);
  const sizeMB = ((r.segments || []).reduce((a, b) => a + (b ? b.size : 0), 0) / 1048576).toFixed(1);
  const dated = s ? s.actions.filter((a) => a.echeance_date && !a.fait) : [];
  const calName = S.agenda === 'google' ? 'Google Agenda' : S.agenda === 'ics' ? 'fichier agenda' : 'Outlook';
  $('#vDetail').innerHTML = `
  <div class="card">
    <input type="text" id="dTitle" value="${esc(r.title)}" style="font-weight:600;font-size:17px">
    <div class="muted" style="margin-top:6px">${new Date(r.created).toLocaleString('fr-FR')} · ${fmt(r.duration || 0)} ${r.transcriptMode ? '· transcrit ' + (r.transcriptMode === 'cloud' ? 'dans le cloud' : 'sur le téléphone') : ''}</div>
    <div style="margin-top:8px">${badge(r)} <span class="muted">${esc(r.info || '')}</span></div>
    ${r.status === 'run' && r.pct != null ? `<div class="prog"><i style="width:${Math.round(r.pct * 100)}%"></i></div>` : ''}
    ${['wait', 'error', 'recorded'].includes(r.status) ? `<div class="row" style="margin-top:10px">
      <button class="pri" id="dRetry">Relancer</button>
      ${!r.transcript && n !== 'offline' && cloudKey() ? '<button id="dForceCloud">Transcrire dans le cloud maintenant</button>' : ''}
      ${!r.transcript && modelReady(S.localModel) ? '<button id="dForceLocal">Transcrire sur le téléphone</button>' : ''}
      ${r.transcript && !s && n === 'mobile' ? '<button id="dForceSum">Résumer maintenant (4G, texte seul)</button>' : ''}
    </div>` : ''}
  </div>
  ${spk.length ? `<div class="card"><h2>Intervenants</h2>
    <div class="muted" style="margin-bottom:6px">Nommez chaque voix : les noms sont repris partout (actions, transcription, exports).</div>
    ${spk.map((x) => `<div class="spk">
      <div class="row" style="flex-wrap:nowrap"><span class="dot" style="background:${spkColor(x.label)}"></span>
        <input type="text" class="spkName" data-l="${esc(x.label)}" value="${esc((r.names || {})[x.label] || '')}" placeholder="${esc(x.label)}">
        ${urls.length === 1 ? `<button class="spkPlay" data-t="${x.start}" title="Écouter">▶</button>` : ''}</div>
      <div class="m">${esc(x.label)} · ${x.pct} % du temps de parole${(r.guessed || {})[x.label] ? ' · <i>nom suggéré, à vérifier</i>' : ''}<br>« ${esc(x.first.slice(0, 90))}${x.first.length > 90 ? '…' : ''} »</div>
    </div>`).join('')}
  </div>` : ''}
  ${r.transcript && !hasSpeakers(r) && S.diarize && cloudKey() && n !== 'offline' && r.status !== 'run' ? `<div class="card"><div class="muted">Transcription faite sans distinguer les intervenants.</div>
    <button id="dDiar" style="margin-top:8px">👥 Identifier les intervenants (envoi audio ${sizeMB} Mo${n === 'mobile' ? ', en 4G' : ''})</button></div>` : ''}
  ${s ? `<div class="card">
    <h2>Résumé</h2>${hasTTS || S.mistralKey ? '<button data-speak="sum" class="speak">🔊 Écouter le résumé</button>' : ''}<div>${esc(nm(s.resume))}</div>
    ${s.points_cles && s.points_cles.length ? `<h3>Points clés</h3><ul>${s.points_cles.map((x) => `<li>${esc(nm(x))}</li>`).join('')}</ul>` : ''}
    ${s.decisions && s.decisions.length ? `<h3>Décisions</h3><ul>${s.decisions.map((x) => `<li>${esc(nm(x))}</li>`).join('')}</ul>` : ''}
  </div>
  <div class="card"><h2>Actions à réaliser</h2>${(hasTTS || S.mistralKey) && (s.actions || []).length ? '<button data-speak="act" class="speak">🔊 Écouter les actions</button>' : ''}
    ${(s.actions || []).length ? s.actions.map((a, i) => `<div class="act ${a.fait ? 'done' : ''}"><input type="checkbox" data-i="${i}" ${a.fait ? 'checked' : ''}>
      <div style="flex:1"><div class="t">${esc(nm(a.action))}</div>
      <div class="m">${a.responsable ? '👤 ' + esc(nm(a.responsable)) + ' · ' : ''}${a.echeance ? '« ' + esc(a.echeance) + ' » · ' : ''}<span class="prio-${esc(a.priorite)}">${esc(a.priorite || '')}</span></div>
      <div class="row" style="margin-top:4px;flex-wrap:nowrap"><input type="date" class="actDate" data-i="${i}" value="${esc(a.echeance_date || '')}" style="width:auto;padding:5px 8px;font-size:14px">
      <button class="actCal" data-i="${i}" ${a.echeance_date ? '' : 'disabled'} style="padding:5px 10px;font-size:14px">📅 ${calName}</button></div></div></div>`).join('') : '<div class="muted">Aucune action identifiée.</div>'}
    ${dated.length ? `<button id="dIcsAll" style="margin-top:10px">📅 Toutes les échéances ouvertes (${dated.length}) → fichier agenda .ics</button>` : ''}
  </div>
  ${s.prochaine_reunion ? `<div class="card"><h2>Prochaine réunion</h2><div>${esc(fmtD(s.prochaine_reunion.date))}${s.prochaine_reunion.heure ? ' à ' + esc(s.prochaine_reunion.heure) : ''} — ${esc(nm(s.prochaine_reunion.objet || ''))}</div>
    <button id="dNext" style="margin-top:8px">📅 Ajouter à ${calName}</button></div>` : ''}
  ${s.questions_ouvertes && s.questions_ouvertes.length ? `<div class="card"><h2>Questions ouvertes</h2><ul>${s.questions_ouvertes.map((x) => `<li>${esc(nm(x))}</li>`).join('')}</ul></div>` : ''}
  <div class="card"><h2>Envoyer</h2><div class="row">
    <button class="pri" id="dOutlook">✉ Outlook</button><button id="dShare">Autre appli</button><button id="dCopy">Copier</button><button id="dDl">.md</button>
  </div></div>
  <div class="card"><label for="dExtra" style="margin-top:0">Refaire le résumé avec une consigne</label>
    <textarea id="dExtra" placeholder="ex. : insister sur le planning, séparer les actions client / bureau d'études…"></textarea>
    <button id="dResum" style="margin-top:8px">Refaire le résumé</button></div>` : ''}
  ${r.transcript ? `<div class="card"><details><summary>Transcription intégrale</summary><div class="transcript">${
    hasSpeakers(r) ? r.utterances.map((u) => `<div class="utt"><b style="color:${spkColor(u.spk)}">${esc(nm(u.spk))}</b> <span class="m">${fmt(u.start * 1000)}</span><br>${esc(u.text)}</div>`).join('') : esc(r.transcript)
  }</div></details></div>` : ''}
  <div class="card"><details ${spk.length && urls.length === 1 ? 'open' : ''}><summary>Audio${urls.length > 1 ? ' (' + urls.length + ' fichiers)' : ''}</summary>${urls.map((u, i) => `<audio controls preload="metadata" ${i === 0 ? 'id="dAudio"' : ''} src="${u}"></audio>`).join('')}</details></div>
  <button class="dan big" id="dDel">Supprimer cet enregistrement</button>`;

  const on = (sel, fn) => { const el = $(sel); el && (el.onclick = fn); };
  $('#dTitle').onchange = (e) => patch(curId, { title: e.target.value, titleEdited: true });
  on('#dRetry', () => processRec(curId));
  on('#dForceCloud', () => processRec(curId, { forceCloud: true }));
  on('#dForceLocal', () => processRec(curId, { forceLocal: true }));
  on('#dForceSum', () => processRec(curId, { forceSummary: true }));
  on('#dDiar', () => {
    if (anyDone(r) && !confirm('Le résumé et les actions seront refaits (les cases cochées seront réinitialisées). Continuer ?')) return;
    if (n === 'mobile' && !confirm(`Envoyer ${sizeMB} Mo d'audio avec les données mobiles ?`)) return;
    processRec(curId, { rediarize: true, forceSummary: true });
  });
  on('#dResum', () => { if (!S.anthropicKey) return toast('Clé API Anthropic manquante'); processRec(curId, { resummarize: true, forceSummary: true, extra: $('#dExtra').value }); });
  on('#dOutlook', () => sendOutlook(r));
  on('#dShare', async () => { const t = exportText(r, false); if (navigator.share) { try { await navigator.share({ title: 'Compte-rendu – ' + r.title, text: t }); } catch (_) {} } else { await navigator.clipboard.writeText(t); toast('Copié'); } });
  on('#dCopy', async () => { await navigator.clipboard.writeText(exportText(r, false)); toast('Compte-rendu copié'); });
  on('#dDl', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([exportText(r, true)], { type: 'text/markdown' })); a.download = r.title.replace(/[^\w\- àâäéèêëïîôöùûüç]/gi, '_') + '.md'; a.click(); });
  on('#dIcsAll', () => shareIcs([...dated.map((a) => actionEvent(r, a)), ...(s.prochaine_reunion ? [meetingEvent(r)] : [])], 'Actions – ' + r.title));
  on('#dNext', () => addToCalendar(meetingEvent(r), r));
  on('#dDel', async () => { if (confirm('Supprimer définitivement cet enregistrement ?')) { await delRec(curId); await delChunks(curId); show('home'); renderList(); } });
  const all = (sel) => $('#vDetail').querySelectorAll(sel);
  all('.act input[type=checkbox]').forEach((cb) => (cb.onchange = async () => { const rr = await getRec(curId); rr.summary.actions[+cb.dataset.i].fait = cb.checked; await putRec(rr); renderDetail(); renderList(); }));
  all('.actDate').forEach((el) => (el.onchange = async () => { const rr = await getRec(curId); rr.summary.actions[+el.dataset.i].echeance_date = el.value; await putRec(rr); renderDetail(); }));
  all('.actCal').forEach((b) => (b.onclick = () => addToCalendar(actionEvent(r, s.actions[+b.dataset.i]), r)));
  all('.spkName').forEach((el) => (el.onchange = async () => {
    const rr = await getRec(curId); rr.names = rr.names || {}; rr.guessed = rr.guessed || {};
    rr.names[el.dataset.l] = el.value.trim(); delete rr.guessed[el.dataset.l]; await putRec(rr); renderDetail(); renderList();
  }));
  // Les fichiers webm enregistrés n'indiquent pas leur durée : on la force pour pouvoir se déplacer dans l'audio
  all('audio').forEach((au) => au.addEventListener('loadedmetadata', function fix() {
    au.removeEventListener('loadedmetadata', fix);
    if (au.duration === Infinity) { au.currentTime = 1e101; au.addEventListener('timeupdate', function back() { au.removeEventListener('timeupdate', back); au.currentTime = 0; }); }
  }));
  all('[data-speak]').forEach((b) => (b.onclick = () => speak(b.dataset.speak, b.dataset.speak === 'sum' ? summarySpeech(r) : actionsSpeech(r))));
  updSpeakBtns();
  all('.spkPlay').forEach((b) => (b.onclick = () => { const au = $('#dAudio'); if (!au) return; au.currentTime = Math.max(0, +b.dataset.t - 0.3); au.play(); }));
}
const SPK_COLORS = ['#166534', '#1d4ed8', '#b45309', '#7c3aed', '#be123c', '#0f766e', '#4d7c0f', '#9a3412'];
const spkColor = (l) => SPK_COLORS[((parseInt(String(l || '').replace(/\D/g, ''), 10) || 1) - 1) % SPK_COLORS.length];
function refresh(id) {
  if (view === 'detail' && id === curId) {
    const ae = document.activeElement;
    if (!ae || !(ae.id === 'dTitle' || ae.id === 'dExtra' || ae.classList.contains('spkName') || ae.classList.contains('actDate'))) {
      const au = $('#dAudio'); if (!(au && !au.paused)) renderDetail(); // ne coupe pas une écoute en cours
    }
  }
  renderList();
}
function toast(t, btn, onBtn, ms = 2600) {
  document.querySelectorAll('.toast').forEach((x) => x.remove());
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = t;
  if (btn) { const b = document.createElement('button'); b.textContent = btn; b.className = 'tbtn'; b.onclick = () => { onBtn(); d.remove(); }; d.appendChild(b); }
  document.body.appendChild(d); setTimeout(() => d.remove(), ms);
}

// ---------------- Réglages ----------------
const FIELDS = { policy: 's_policy', anthropicKey: 's_anthropicKey', claudeModel: 's_claudeModel', context: 's_context', stt: 's_stt', mistralKey: 's_mistralKey', openaiKey: 's_openaiKey', localModel: 's_localModel', outlook: 's_outlook', agenda: 's_agenda', mailTo: 's_mailTo', ttsRate: 's_ttsRate', ttsEngine: 's_ttsEngine' };
const CHECKS = { summaryMobile: 's_summaryMobile', unknownWifi: 's_unknownWifi', diarize: 's_diarize', autoDiarize: 's_autoDiarize' };
function fillSettings() {
  for (const [k, id] of Object.entries(FIELDS)) $('#' + id).value = S[k];
  for (const [k, id] of Object.entries(CHECKS)) $('#' + id).checked = S[k];
  $('#modelState').textContent = modelReady(S.localModel) ? '✓ Modèle téléchargé : la transcription hors wifi est disponible.' : 'Modèle pas encore téléchargé. Il le sera automatiquement au premier usage en wifi, ou maintenant avec le bouton.';
}
$('#s_localModel').onchange = (e) => { S.localModel = e.target.value; fillSettings(); };
$('#saveSet').onclick = () => {
  for (const [k, id] of Object.entries(FIELDS)) S[k] = $('#' + id).value.trim();
  for (const [k, id] of Object.entries(CHECKS)) S[k] = $('#' + id).checked;
  saveSettings(); updateNet(); toast('Réglages enregistrés'); show('home'); resumeQueue();
};
$('#dlModel').onclick = async () => {
  if (netMode() !== 'wifi' && !confirm("Vous n'êtes pas en wifi. Télécharger le modèle avec les données mobiles ?")) return;
  S.localModel = $('#s_localModel').value; saveSettings();
  $('#dlModel').disabled = true; $('#dlProg').classList.remove('hidden');
  try { await ensureModel((p) => ($('#dlProg i').style.width = Math.round(p * 100) + '%')); toast('Modèle prêt'); }
  catch (e) { toast('Échec : ' + e.message); }
  $('#dlModel').disabled = false; $('#dlProg').classList.add('hidden'); fillSettings(); updateNet();
};

$('#recBtn').onclick = () => (R.id ? stopRecording() : startRecording());
$('#setBtn').onclick = () => { fillSettings(); show('settings'); };
$('#backBtn').onclick = () => { stopSpeak(); show('home'); renderList(); };
window.addEventListener('beforeunload', (e) => { if (R.id) { e.preventDefault(); e.returnValue = ''; } });

// ---------------- Démarrage ----------------
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  // enregistrement interrompu (fermeture brutale) : on reconstitue l'audio à partir des morceaux sauvegardés
  for (const r of await allRecs()) if (r.status === 'recording') {
    await assemble(r.id, r.mime);
    await patch(r.id, { status: 'recorded', info: 'Enregistrement interrompu — audio récupéré jusqu\'à la coupure' });
  }
  $('#verHome').textContent = 'G ENVIRONNEMENT · Compte-rendu · version ' + VERSION;
  $('#verSet').textContent = 'Version ' + VERSION + ' — vos réglages et clés restent sur ce téléphone';
  updateNet(); renderList();
  if (!S.anthropicKey) toast('Commencez par renseigner vos clés API dans ⚙ Réglages');
  resumeQueue();
})();
$('#ttsTest').onclick = () => { localStorage.removeItem('ttsLevel'); localStorage.removeItem('ttsPhoneBroken'); S.ttsRate = $('#s_ttsRate').value; S.ttsEngine = $('#s_ttsEngine').value; const n = hasTTS ? speechSynthesis.getVoices().filter((v) => /^fr/i.test(v.lang)).length : 0; $('#ttsInfo').textContent = hasTTS ? (n ? n + ' voix française(s) trouvée(s) sur le téléphone.' : 'Aucune voix française listée : la voix par défaut du téléphone sera utilisée.') : 'Synthèse vocale non disponible dans ce navigateur.'; speak('test', 'Bonjour. Voici la lecture à haute voix du compte-rendu de réunion. Action 1 : envoyer l\'offre au client, pour le vendredi 27 novembre.'); };
