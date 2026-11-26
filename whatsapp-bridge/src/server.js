import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import admin from 'firebase-admin';
import makeWASocket, { Browsers, DisconnectReason, generateMessageIDV2, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';

const PORT = Number(process.env.PORT || 3000);
const MASTER_EMAIL = (process.env.MASTER_EMAIL || 'joaosoaresthi@gmail.com').toLowerCase();
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || '/data/auth');
const origins = new Set((process.env.APP_ORIGINS || 'https://dona-vina.vercel.app').split(',').map((v) => v.trim()).filter(Boolean));
if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Configure FIREBASE_SERVICE_ACCOUNT.');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const sessions = new Map();
const seen = new Set();
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin(origin, cb) { if (!origin || origins.has(origin)) return cb(null, true); cb(new Error('Origem não autorizada.')); }, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Authorization','Content-Type'], maxAge: 600 }));
app.use(express.json({ limit: '100kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

function slugOf(value) { const slug = String(value || '').toLowerCase(); if (!/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(slug)) { const e = new Error('Slug inválido.'); e.status = 400; throw e; } return slug; }
// shortcut: pauses live in memory and reset on Railway restart; persist per chat if pauses must survive redeploys.
function sessionFor(slug) { if (!sessions.has(slug)) sessions.set(slug, { state: 'disconnected', qr: null, phone: null, error: null, socket: null, starting: null, timer: null, generation: 0, automatedMessageIds: new Set(), pendingMessages: new Map(), pausedChats: new Set() }); return sessions.get(slug); }
function stateOf(slug) { const s = sessionFor(slug); return { store: slug, state: s.state, qr: s.qr, phone: s.phone, error: s.error }; }
async function authorize(req, res, next) {
  try {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return res.status(401).json({ error: 'Faça login para continuar.' });
    const user = await admin.auth().verifyIdToken(token); const slug = slugOf(req.params.slug);
    const snap = await db.collection('stores').doc(slug).get();
    if (!snap.exists) return res.status(404).json({ error: 'Loja não encontrada.' });
    const email = String(user.email || '').toLowerCase();
    if (email !== MASTER_EMAIL && (!email || email !== String(snap.get('ownerEmail') || '').toLowerCase())) return res.status(403).json({ error: 'Sem acesso a esta loja.' });
    req.slug = slug; next();
  } catch (e) { res.status(e.status || 401).json({ error: e.status ? e.message : 'Sessão inválida ou expirada.' }); }
}
function phoneDigits(value) { let d = String(value || '').replace(/\D/g, ''); if (d.length === 10 || d.length === 11) d = '55' + d; return d.startsWith('55') && d.length >= 12 && d.length <= 13 ? d : null; }
function isBotTrigger(text) {
  const t = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  return /^(1|1️⃣|2|2️⃣|3|3️⃣|4|4️⃣)$/.test(t) ||
    /\b(cardapio|menu|produtos|fazer pedido|pedir|pedido|pix|pagamento|pagar|horario|funcionamento|endereco|localizacao|onde fica|atendente|equipe|pessoa|humano|falar com alguem|oi|ola|bom dia|boa tarde|boa noite|ajuda|inicio|comecar)\b/.test(t);
}
function markAutomated(s, id) { s.automatedMessageIds.add(id); const timer = setTimeout(() => s.automatedMessageIds.delete(id), 60_000); timer.unref(); }
function failPending(s, error) {
  for (const pending of new Set(s.pendingMessages.values())) pending.finish(error);
}
function watchSendResult(s, messageId, slug) {
  let settled = false, timer;
  const ids = new Set([messageId]);
  let pending;
  const promise = new Promise((resolve, reject) => {
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const id of ids) if (s.pendingMessages.get(id) === pending) s.pendingMessages.delete(id);
      if (error) reject(error); else resolve(result);
    };
    pending = { slug, finish };
    s.pendingMessages.set(messageId, pending);
    timer = setTimeout(() => {
      const error = new Error('O WhatsApp não confirmou a entrega em 20 segundos. Verifique se a sessão continua conectada e tente reenviar.');
      error.status = 504;
      finish(error);
    }, 20_000);
    timer.unref();
  });
  promise.catch(() => {});
  return {
    promise,
    addId(id) { if (id && !ids.has(id)) { ids.add(id); s.pendingMessages.set(id, pending); } },
    cancel(error) { pending.finish(error || new Error('Envio cancelado.')); }
  };
}
async function recipientJid(s, jid) {
  if (!jid.endsWith('@s.whatsapp.net')) return jid;
  try {
    const lid = await s.socket?.signalRepository?.lidMapping?.getLIDForPN(jid);
    if (typeof lid === 'string' && lid.endsWith('@lid')) return lid;
  } catch (err) {
    logger.warn({ err }, 'Could not resolve WhatsApp phone JID to LID; using phone JID');
  }
  return jid;
}
async function sendAutomated(slug, s, jid, text) {
  return send(slug, jid, text);
}
function botReply(text, store = {}, slug = '') {
  const w = store.whatsapp || {};
  if (w.botEnabled === false) return null;
  const t = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const menuUrl = `https://dona-vina.vercel.app/?loja=${encodeURIComponent(slug)}`;
  const name = store.name || 'nossa loja';
  const menu = () => {
    const products = (store.products || []).filter((p) => p && p.available !== false).slice(0, 12);
    const lines = products.map((p) => `• ${p.name} — ${Number(p.price || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`);
    return `🍽️ Cardápio de ${name}\n\n${lines.length ? lines.join('\n') + '\n\n' : ''}Veja todos os itens e faça seu pedido pelo link:\n${menuUrl}`;
  };
  const greeting = () => `${w.botWelcome || `Olá! 😊 Bem-vindo(a) à ${name}.`}\n\nComo posso ajudar? Responda com uma opção:\n1️⃣ Ver cardápio / fazer pedido\n2️⃣ Horário e endereço\n3️⃣ Pagamento / Pix\n4️⃣ Falar com a equipe`;
  if (/^(1|1️⃣)$/.test(t) || /\b(cardapio|menu|produtos|fazer pedido|pedir|pedido)\b/.test(t)) return menu();
  if (/^(2|2️⃣)$/.test(t) || /\b(horario|funcionamento|endereco|localizacao|onde fica)\b/.test(t)) {
    const hours = w.botHours || store.hours || 'Consulte o horário diretamente com a equipe.';
    const addressValue = w.botAddress || store.address;
    const address = addressValue ? `\n📍 Endereço: ${addressValue}` : '';
    return `🕒 Funcionamento: ${hours}${address}`;
  }
  if (/^(3|3️⃣)$/.test(t) || /\b(pix|pagamento|pagar)\b/.test(t)) {
    if (store.pixKey) return (w.botPix || '💳 Pix: {pix}\n\nEnvie o comprovante por aqui!').replace(/\{pix\}|12\.345\.678\/0001-99/g, store.pixKey);
    return (w.botPix || 'A chave Pix ainda não foi cadastrada. Responda 4 para falar com a equipe.').replace(/[^\n]*\{pix\}[^\n]*/g, 'A chave Pix ainda não foi cadastrada. Responda 4 para falar com a equipe.');
  }
  if (/^(4|4️⃣)$/.test(t) || /\b(atendente|equipe|pessoa|humano|falar com alguem)\b/.test(t)) {
    return w.botHandoff || `👋 Certo! A equipe de ${name} pode continuar esta conversa por aqui. Escreva sua dúvida ou o que deseja pedir.`;
  }
  if (/\b(oi|ola|bom dia|boa tarde|boa noite|ajuda|inicio|comecar)\b/.test(t) || !t) return greeting();
  return w.botFallback || 'Não entendi essa opção. 😊\n\nResponda 1 para ver o cardápio, 2 para horário/endereço, 3 para Pix ou 4 para falar com a equipe.';
}
async function incoming(slug, msg) {
  const id = msg.key?.id, jid = msg.key?.remoteJid;
  const seenId = `${slug}:${id}`;
  if (!id || !jid || msg.key.fromMe || jid === 'status@broadcast' || jid.endsWith('@g.us') || seen.has(seenId)) return;
  seen.add(seenId); if (seen.size > 2000) seen.delete(seen.values().next().value);
  const m = msg.message || {}; const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';
  if (!text.trim()) return;
  try {
    const s = sessionFor(slug);
    if (s.pausedChats.has(jid)) { if (!isBotTrigger(text)) return; s.pausedChats.delete(jid); }
    const snap = await db.collection('stores').doc(slug).get(); const store = snap.data() || {}; const reply = botReply(text, store, slug); if (reply) await sendAutomated(slug, s, jid, reply);
  }
  catch (e) { logger.error({ err: e, slug }, 'Falha ao responder'); }
}
async function start(slug) {
  const s = sessionFor(slug); if (s.starting) return s.starting; if (s.state === 'connected' && s.socket) return s;
  s.starting = (async () => {
    const folder = path.join(AUTH_DIR, slug); await fs.mkdir(folder, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(folder); const generation = ++s.generation;
    s.state = 'connecting'; s.qr = null; s.error = null;
    const sock = makeWASocket({ auth: state, logger, printQRInTerminal: false, browser: Browsers.macOS('Desktop'), markOnlineOnConnect: false, syncFullHistory: false }); s.socket = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        const pending = key?.id && s.pendingMessages.get(key.id);
        if (!pending) continue;
        const status = Number(update?.status);
        if ([3, 4, 5].includes(status)) {
          logger.info({ slug: pending.slug, messageId: key.id, status }, 'WhatsApp confirmed message delivery');
          pending.finish(null, { deliveryConfirmed: true, deliveryStatus: status >= 4 ? 'read' : 'delivered' });
          continue;
        }
        if (status !== 0) continue;
        const code = update.messageStubParameters?.find((value) => /^\d+$/.test(String(value)));
        logger.warn({ slug: pending.slug, messageId: key.id, code: code || 'unknown' }, 'WhatsApp rejected an outgoing message');
        pending.finish(new Error(code === '463'
          ? 'O WhatsApp recusou o envio (código 463). Confira se o destinatário está acessível pela sessão e tente novamente.'
          : `O WhatsApp recusou a mensagem${code ? ` (código ${code})` : ''}.`));
      }
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        const jid = m.key?.remoteJid;
        if (m.key?.fromMe) {
          if (s.automatedMessageIds.delete(m.key.id)) continue;
          if (jid && jid !== 'status@broadcast' && !jid.endsWith('@g.us')) s.pausedChats.add(jid);
          continue;
        }
        void incoming(slug, m);
      }
    });
    sock.ev.on('connection.update', (u) => {
      if (s.generation !== generation) return;
      if (u.qr) { s.qr = u.qr; s.state = 'qr'; }
      if (u.connection === 'open') { s.state = 'connected'; s.qr = null; s.error = null; s.phone = sock.user?.id?.split(':')[0] || null; }
      if (u.connection === 'close') { const loggedOut = u.lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut; failPending(s, new Error(loggedOut ? 'A sessão do WhatsApp foi removida. Gere e leia um novo QR Code.' : 'A conexão do WhatsApp caiu durante o envio.')); s.state = loggedOut ? 'logged_out' : 'disconnected'; s.socket = null; s.qr = null; s.phone = null; s.error = loggedOut ? 'WhatsApp desconectado; gere outro QR.' : 'Conexão caiu; tentando reconectar.'; if (!loggedOut) { clearTimeout(s.timer); s.timer = setTimeout(() => void start(slug), 3000); } }
    });
    return s;
  })().catch((e) => { s.state = 'error'; s.error = e.message; throw e; }).finally(() => { s.starting = null; });
  return s.starting;
}
async function send(slug, jid, text) {
  const s = sessionFor(slug);
  if (s.state !== 'connected' || !s.socket) { const e = new Error('WhatsApp da loja não está conectado.'); e.status = 503; throw e; }
  const target = await recipientJid(s, jid);
  const messageId = generateMessageIDV2(s.socket.user?.id);
  markAutomated(s, messageId);
  const delivery = watchSendResult(s, messageId, slug);
  try {
    const sent = await s.socket.sendMessage(target, { text }, { messageId });
    if (!sent?.key?.id) throw new Error('O WhatsApp não retornou a confirmação de aceite do envio.');
    delivery.addId(sent.key.id);
    markAutomated(s, sent.key.id);
    const result = await delivery.promise;
    return { accepted: true, ...result };
  } catch (e) {
    delivery.cancel(e);
    s.automatedMessageIds.delete(messageId);
    throw e;
  }
}
function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function orderText(tpl, order, store) {
  const items = (order.items || []).map((i) => String(i.qty || 1) + 'x ' + (i.name || 'Item')).join('\n');
  const v = { cliente: order.customerName || 'cliente', pedido: order.id || '', itens: items, total: brl(order.total), endereco: order.address || 'Retirada no balcão', tempo: store.eta || '' };
  return String(tpl || 'Olá {cliente}! Recebemos seu pedido {pedido}. Total: {total}.').replace(/\{(cliente|pedido|itens|total|endereco|tempo)\}/g, (_, k) => v[k]);
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/stores/:slug/whatsapp/status', authorize, (req, res) => res.json(stateOf(req.slug)));
app.post('/api/stores/:slug/whatsapp/connect', authorize, async (req, res) => { try { const s = sessionFor(req.slug); if (s.state === 'logged_out') { await fs.rm(path.join(AUTH_DIR, req.slug), { recursive: true, force: true }); s.state = 'disconnected'; s.error = null; } await start(req.slug); res.json(stateOf(req.slug)); } catch (e) { res.status(500).json({ error: e.message, ...stateOf(req.slug) }); } });
app.post('/api/stores/:slug/whatsapp/disconnect', authorize, async (req, res) => {
  const s = sessionFor(req.slug); clearTimeout(s.timer); s.generation++; try { await s.socket?.logout(); } catch {} s.socket?.end(undefined); s.socket = null; s.state = 'disconnected'; s.qr = null; s.phone = null; s.error = null;
  await fs.rm(path.join(AUTH_DIR, req.slug), { recursive: true, force: true }); res.json(stateOf(req.slug));
});
app.post('/api/stores/:slug/whatsapp/send', authorize, async (req, res) => {
  const phone = phoneDigits(req.body?.phone), text = String(req.body?.text || '').trim();
  if (!phone || !text || text.length > 4000) return res.status(400).json({ error: 'WhatsApp inválido ou mensagem acima de 4.000 caracteres.' });
  try { const result = await send(req.slug, phone + '@s.whatsapp.net', text); res.json({ ok: true, ...result }); } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
// Checkout público: só envia para pedido existente e registra uma confirmação por pedido.
app.post('/api/stores/:slug/orders/:orderId/confirmation', async (req, res) => {
  let slug; try { slug = slugOf(req.params.slug); } catch (e) { return res.status(400).json({ error: e.message }); }
  const id = String(req.params.orderId || ''); if (!/^[A-Za-z0-9_-]{1,150}$/.test(id)) return res.status(400).json({ error: 'Pedido inválido.' });
  const ref = db.collection('stores').doc(slug).collection('orders').doc(id); let order; let duplicate = false;
  try { await db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) { const e = new Error('Pedido não encontrado.'); e.status = 404; throw e; } order = snap.data(); if (['sending','accepted','sent','sent_unconfirmed'].includes(order.whatsappConfirmationStatus)) { duplicate = true; return; } tx.update(ref, { whatsappConfirmationStatus: 'sending' }); }); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  if (duplicate) return res.json({ ok: true, duplicate: true });
  try {
    const store = (await db.collection('stores').doc(slug).get()).data(); const phone = phoneDigits(order.customerPhone); if (!phone) throw new Error('Pedido sem WhatsApp válido.');
    const result = await send(slug, phone + '@s.whatsapp.net', orderText(store.whatsapp?.tplConfirmacao, order, store));
    await ref.update({ whatsappConfirmationStatus: 'accepted', whatsappConfirmationDeliveryConfirmed: result.deliveryConfirmed, whatsappConfirmationDeliveryStatus: result.deliveryStatus, whatsappConfirmationSentAt: admin.firestore.FieldValue.serverTimestamp() }); res.json({ ok: true, ...result });
  } catch (e) { await ref.update({ whatsappConfirmationStatus: 'failed', whatsappConfirmationError: String(e.message).slice(0,180) }).catch(() => {}); res.status(e.status || 502).json({ error: e.message }); }
});

const server = app.listen(PORT, '0.0.0.0', async () => {
  await fs.mkdir(AUTH_DIR, { recursive: true }); logger.info({ port: PORT }, 'WhatsApp bridge online');
  const entries = await fs.readdir(AUTH_DIR, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isDirectory() && /^[a-z0-9-]{1,60}$/.test(e.name)) void start(e.name).catch((err) => logger.error({ err, slug: e.name }, 'Falha ao restaurar sessão'));
});
function shutdown() { server.close(); for (const s of sessions.values()) { clearTimeout(s.timer); s.socket?.end(undefined); } setTimeout(() => process.exit(0), 1000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
