/**
 * WhatsApp Mass Sender Bot v4 — Rápido, para tras 1500, con feedback
 */
"use strict";

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const QRCode      = require('qrcode');
const pino        = require('pino');
const https       = require('https');
const http        = require('http');
const fs          = require('fs');
const path        = require('path');

// ─── CONFIGURACIÓN ───────────────────────────────────────────────────────────
const TELEGRAM_TOKEN     = process.env.TELEGRAM_TOKEN     || '8718387604:AAG6ICLoEKoV96G4zCTMq_9cA0lKKmWrcvs';
const AUTHORIZED_USER    = process.env.AUTHORIZED_USER    || 'K11000K';
const MESSAGES_PER_CYCLE = 1500;
const DELAY_MIN          = 4000;   // ms mínimo entre mensajes
const DELAY_MAX          = 7000;   // ms máximo entre mensajes (~10-15 msg/min)
const PAUSE_EVERY        = 25;     // pausa extra cada N mensajes
const PAUSE_MINI_MIN     = 8000;   // ms mínimo pausa mini
const PAUSE_MINI_MAX     = 18000;  // ms máximo pausa mini
const SESSION_DIR        = './wa_session';
const QR_MS              = 60000;
const MAX_RECONN         = 5;
const PROGRESS_EVERY     = 50;     // Notificar cada 50 mensajes
const PAUSE_AFTER_CYCLE  = 2 * 60 * 60 * 1000; // 2 horas en ms

// Caracteres invisibles para variar el mensaje (anti-spam)
const INVISIBLE_CHARS = ['\u200B','\u200C','\u200D','\uFEFF','\u2060','\u180E','\u200E','\u200F'];
// ─────────────────────────────────────────────────────────────────────────────

const log = pino({ level: 'silent' });

let sock          = null;
let connected     = false;
let connecting    = false;
let connChat      = null;
let qrMsgId       = null;
let qrTimer       = null;
let reconnN       = 0;
let reconnTimer   = null;

let contactList     = [];
let messageText     = '';
let isSending       = false;
let sentTotal       = 0;
let currentIndex    = 0;
let awaitingMessage  = false;
let awaitingContacts = false;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
bot.on('polling_error', e => {
  if (e.code !== 'ETELEGRAM' || !e.message?.includes('409'))
    console.error('[TG]', e.code || e.message);
});

// ─── UTILIDADES ──────────────────────────────────────────────────────────────
const sleep     = ms => new Promise(r => setTimeout(r, ms));
const randDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const isAuth    = msg => msg?.from?.username === AUTHORIZED_USER;
const timeout   = (p, ms, fb = null) => {
  let t;
  return Promise.race([p, new Promise(r => { t = setTimeout(() => r(fb), ms); })])
    .finally(() => clearTimeout(t));
};

function safeSend(chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts })
    .catch(e => console.error('safeSend error:', e.message));
}

function downloadText(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
  });
}

// Genera una variación del mensaje con caracteres invisibles únicos
function spinMessage(text, index) {
  const char = INVISIBLE_CHARS[index % INVISIBLE_CHARS.length];
  const extra = INVISIBLE_CHARS[(index + 3) % INVISIBLE_CHARS.length];
  // Inserta un carácter invisible al final y otro en el medio
  const mid = Math.floor(text.length / 2);
  return text.slice(0, mid) + char + text.slice(mid) + extra;
}

function hasCreds() {
  try {
    return fs.existsSync(SESSION_DIR) && fs.readdirSync(SESSION_DIR).length > 0;
  } catch (_) { return false; }
}

function clearSession() {
  try {
    if (fs.existsSync(SESSION_DIR))
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    console.log('[WA] Sesión borrada.');
  } catch (e) { console.error('[WA] Error borrando sesión:', e.message); }
}

// ─── MENÚ PRINCIPAL ───────────────────────────────────────────────────────────
function mainMenu(chatId) {
  const waIcon   = connected ? '🟢' : '🔴';
  const sendIcon = isSending ? '🟢' : '⚫';

  safeSend(chatId,
    `🤖 *WhatsApp Mass Sender*\n\n` +
    `${waIcon} WhatsApp: ${connected ? 'Conectado' : 'Desconectado'}\n` +
    `📋 Contactos: ${contactList.length}\n` +
    `💬 Mensaje: ${messageText ? '✅ Configurado' : '❌ Sin configurar'}\n` +
    `${sendIcon} Enviando: ${isSending ? 'Activo' : 'Parado'}\n` +
    `📤 Total enviados: ${sentTotal}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: connected ? '🔄 Reconectar WA' : '📱 Conectar WhatsApp', callback_data: 'conectar' },
            { text: '🗑️ Borrar sesión', callback_data: 'borrar_sesion' }
          ],
          [
            { text: '📂 Cargar lista .txt', callback_data: 'cargar' },
            { text: '✏️ Escribir mensaje',  callback_data: 'mensaje' }
          ],
          [
            { text: '▶️ Iniciar envío',     callback_data: 'iniciar' },
            { text: '⏹ Parar envío',        callback_data: 'parar'   }
          ],
          [
            { text: '📊 Ver estado',        callback_data: 'estado'  },
            { text: '🔄 Resetear',          callback_data: 'reset'   }
          ]
        ]
      }
    }
  );
}

// ─── EDITAR CAPTION DEL MENSAJE QR ───────────────────────────────────────────
function editCaption(chat, msgId, text, replyMarkup) {
  if (!chat || !msgId) return Promise.resolve();
  return bot.editMessageCaption(text, {
    chat_id: chat, message_id: msgId,
    parse_mode: 'Markdown',
    reply_markup: replyMarkup
  }).catch(() => safeSend(chat, text,
    replyMarkup ? { reply_markup: replyMarkup } : {}
  ));
}

// ─── DESTROY ────────────────────────────────────────────────────────────────
function destroy() {
  clearTimeout(qrTimer);   qrTimer   = null;
  clearTimeout(reconnTimer); reconnTimer = null;
  qrMsgId = null;
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end(); }
    catch (_) { try { sock.ws?.close(); } catch (_) {} }
    sock = null;
  }
  connected  = false;
  connecting = false;
}

// ─── CONECTAR WHATSAPP ────────────────────────────────────────────────────────
async function connectWA(chat) {
  if (connecting) {
    if (chat) safeSend(chat, '⏳ *Conexión en curso, espera...*');
    return;
  }
  if (connected && sock) return;

  destroy();
  connecting = true;
  connChat   = chat;

  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(SESSION_DIR));
  } catch (e) {
    connecting = false;
    if (chat) safeSend(chat, '❌ *Error al iniciar sesión*\nIntenta borrar la sesión e intentarlo de nuevo.');
    return;
  }

  let ver;
  try {
    const r = await timeout(fetchLatestBaileysVersion(), 10000, null);
    ver = r?.version;
  } catch (_) { ver = undefined; }

  try {
    const opts = {
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, log)
      },
      logger:                  log,
      printQRInTerminal:       false,
      browser:                 ['WA Sender', 'Chrome', '22.0'],
      connectTimeoutMs:        45000,
      defaultQueryTimeoutMs:   25000,
      keepAliveIntervalMs:     15000,
      emitOwnEvents:           false,
      generateHighQualityLinkPreview: false
    };
    if (ver) opts.version = ver;
    sock = makeWASocket(opts);
  } catch (e) {
    connecting = false;
    if (chat) safeSend(chat, `❌ *Error creando socket:* \`${e.message}\``);
    return;
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async up => {
    const { connection, lastDisconnect, qr } = up;

    if (qr) {
      clearTimeout(qrTimer);
      qrTimer = setTimeout(() => {
        if (!connected) {
          const c = connChat, m = qrMsgId;
          destroy();
          if (c && m) editCaption(c, m,
            '⏰ *QR expirado*\nPulsa 📱 *Conectar* para generar uno nuevo.',
            { inline_keyboard: [[{ text: '📱 Conectar WhatsApp', callback_data: 'conectar' }]] }
          );
          else if (c) safeSend(c, '⏰ *QR expirado*\nPulsa 📱 *Conectar* para generar uno nuevo.');
        }
      }, QR_MS);

      QRCode.toBuffer(qr, { scale: 8 }).then(async buf => {
        if (!connChat) return;
        if (qrMsgId) {
          bot.deleteMessage(connChat, qrMsgId).catch(() => {});
          qrMsgId = null;
        }
        const caption =
          `📱 *Escanea este código QR con WhatsApp*\n` +
          `1️⃣ WhatsApp → ⋮ → Dispositivos vinculados\n` +
          `2️⃣ Vincular dispositivo\n` +
          `3️⃣ Escanea el código\n\n` +
          `_⚠️ Tienes ~60 segundos antes de que expire_`;
        const m = await bot.sendPhoto(connChat, buf, {
          caption, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ Cancelar', callback_data: 'cancelar_qr' }]] }
        }).catch(() => null);
        if (m) qrMsgId = m.message_id;
      }).catch(() => {
        if (connChat) safeSend(connChat, '⚠️ No pude generar el QR como imagen. Pulsa *🗑️ Borrar sesión* y vuelve a conectar.');
      });
    }

    if (connection === 'open') {
      connected  = true;
      connecting = false;
      reconnN    = 0;
      clearTimeout(qrTimer); qrTimer = null;

      const ph = sock?.user?.id?.split(':')[0] || sock?.user?.id?.split('@')[0] || '?';
      const txt = `✅ *WhatsApp vinculado correctamente*\n📱 Cuenta: +${ph}`;

      if (connChat && qrMsgId) {
        editCaption(connChat, qrMsgId, txt, null);
        qrMsgId = null;
      } else if (connChat) {
        safeSend(connChat, txt);
      }
      if (connChat) mainMenu(connChat);
    }

    if (connection === 'close') {
      const wasConnected = connected;
      connected  = false;
      connecting = false;
      clearTimeout(qrTimer); qrTimer = null;

      const code    = lastDisconnect?.error?.output?.statusCode;
      const reason  = lastDisconnect?.error?.message || 'desconocido';
      const savedQr = qrMsgId;
      qrMsgId = null;
      console.log(`[WA] Close → code=${code} reason=${reason} wasConnected=${wasConnected}`);

      if (code === DisconnectReason.loggedOut) {
        clearSession();
        sock = null;
        const t = '🔴 *Sesión cerrada*\nPulsa 📱 *Conectar* para vincular de nuevo.';
        if (connChat && savedQr) editCaption(connChat, savedQr, t, null);
        else if (connChat) safeSend(connChat, t);
        if (connChat) mainMenu(connChat);
        return;
      }

      const BANNED_CODES = [401, 403, 440, 411, 500];
      if (BANNED_CODES.includes(code)) {
        clearSession();
        sock = null;
        const t = `🚫 *Sesión inválida o cuenta bloqueada* (${code})\nPulsa 📱 *Conectar* para vincular de nuevo.`;
        if (connChat && savedQr) editCaption(connChat, savedQr, t, null);
        else if (connChat) safeSend(connChat, t);
        if (connChat) mainMenu(connChat);
        return;
      }

      if (!hasCreds()) {
        sock = null;
        const t = '🔴 *No hay sesión activa*\nPulsa 📱 *Conectar* para vincular.';
        if (connChat && savedQr) editCaption(connChat, savedQr, t, null);
        else if (connChat) safeSend(connChat, t);
        return;
      }

      reconnN++;
      if (reconnN > MAX_RECONN) {
        destroy();
        clearSession();
        if (connChat) safeSend(connChat,
          `⚠️ *Reconexión fallida tras ${MAX_RECONN} intentos*\n` +
          `Sesión eliminada. Pulsa 📱 *Conectar* para vincular de nuevo.`
        );
        if (connChat) mainMenu(connChat);
        return;
      }

      const delay = !wasConnected
        ? 2000
        : Math.min(5000 * Math.pow(1.5, reconnN - 1), 60000);

      if (!wasConnected && savedQr && connChat) {
        editCaption(connChat, savedQr, '🔄 *Vinculando cuenta...*', null);
      } else if (wasConnected && connChat) {
        safeSend(connChat, `⚠️ *Reconectando* (${reconnN}/${MAX_RECONN}) en ${Math.round(delay / 1000)}s...`);
      }

      try { sock.ev.removeAllListeners(); } catch (_) {}
      sock = null;

      clearTimeout(reconnTimer);
      reconnTimer = setTimeout(() => {
        connecting = false;
        connectWA(connChat).catch(() => { connecting = false; });
      }, delay);
    }
  });
}

// ─── ENVÍO ────────────────────────────────────────────────────────────────────
async function runSendCycle(chatId) {
  if (!connected)          { safeSend(chatId, '❌ WhatsApp no conectado.'); isSending = false; return; }
  if (!contactList.length) { safeSend(chatId, '❌ Lista vacía.');            isSending = false; return; }
  if (!messageText)        { safeSend(chatId, '❌ Sin mensaje.');            isSending = false; return; }

  // Bucle infinito: envía → pausa 2h → repite (mientras isSending siga true)
  while (isSending) {
    if (currentIndex >= contactList.length) {
      currentIndex = 0;
      safeSend(chatId, '🔁 Lista completada, volviendo al inicio...');
    }

    const slice = contactList.slice(currentIndex, currentIndex + MESSAGES_PER_CYCLE);
    safeSend(chatId,
      `🚀 *Iniciando tanda:* ${slice.length} mensajes\n` +
      `⚡ Velocidad: ~10-15 mensajes/minuto (anti-ban)\n` +
      `🛡️ Modo: delays aleatorios + variación de mensaje\n` +
      `⏱ Duración estimada: ~100-150 minutos\n` +
      `🔔 Progreso cada ${PROGRESS_EVERY} mensajes`
    );

    let sent = 0, errors = 0;
    const startTime = Date.now();

    for (let i = 0; i < slice.length; i++) {
      if (!isSending) {
        safeSend(chatId, `⏹ Envío detenido.\n✅ ${sent} enviados | ❌ ${errors} errores`);
        mainMenu(chatId);
        return;
      }

      const raw = slice[i].trim().replace(/[\+\s\-\(\)]/g, '');
      if (!raw || raw.length < 7) { currentIndex++; continue; }

      const jid     = `${raw}@s.whatsapp.net`;
      const varMsg  = spinMessage(messageText, currentIndex); // Variación única por envío
      try {
        await sock.sendMessage(jid, { text: varMsg });
        sent++;
        currentIndex++;
      } catch (e) {
        errors++;
        currentIndex++;
        // Si hay demasiados errores seguidos, pausa 30s (posible throttle de WA)
        if (errors > 0 && errors % 10 === 0) {
          safeSend(chatId, `⚠️ ${errors} errores acumulados. Pausando 30s para proteger la cuenta...`);
          await sleep(30000);
        }
      }

      // Notificar progreso cada PROGRESS_EVERY mensajes
      if (sent > 0 && sent % PROGRESS_EVERY === 0) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const rate    = Math.round((sent / elapsed) * 60);
        safeSend(chatId,
          `📊 Progreso: *${sent}/${slice.length}* enviados | ❌ ${errors} errores | ⏱ ${elapsed}s | ⚡ ${rate} msg/min`
        );
      }

      // Pausa extra cada PAUSE_EVERY mensajes (simula comportamiento humano)
      if ((i + 1) % PAUSE_EVERY === 0 && i < slice.length - 1) {
        const miniPause = randDelay(PAUSE_MINI_MIN, PAUSE_MINI_MAX);
        await sleep(miniPause);
      } else {
        // Delay aleatorio normal entre mensajes
        await sleep(randDelay(DELAY_MIN, DELAY_MAX));
      }
    }

    // ── Tanda completada ──────────────────────────────────────────────────
    sentTotal += sent;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    safeSend(chatId,
      `✅ *Tanda completada*\n` +
      `📤 Enviados: ${sent}\n` +
      `❌ Errores: ${errors}\n` +
      `⏱ Tiempo: ${elapsed}s\n` +
      `📊 Total acumulado: ${sentTotal}\n\n` +
      `💤 *Pausa de 2 horas...*\n` +
      `_Próximo envío a las ${new Date(Date.now() + PAUSE_AFTER_CYCLE).toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'})}_\n\n` +
      `_Pulsa ⏹ Parar si no quieres más ciclos_`
    );

    // ── Pausa 2 horas (comprobando isSending cada 30s) ────────────────────
    const pauseEnd = Date.now() + PAUSE_AFTER_CYCLE;
    while (Date.now() < pauseEnd) {
      if (!isSending) {
        safeSend(chatId, '⏹ *Ciclo cancelado durante la pausa.*');
        mainMenu(chatId);
        return;
      }
      await sleep(30000); // revisar cada 30 segundos
    }

    if (!isSending) {
      safeSend(chatId, '⏹ *Ciclo cancelado.*');
      mainMenu(chatId);
      return;
    }

    safeSend(chatId, '🔄 *Pausa terminada, iniciando siguiente tanda...*');
  }
}

// ─── CALLBACKS DE BOTONES ─────────────────────────────────────────────────────
bot.on('callback_query', async query => {
  if (query.from.username !== AUTHORIZED_USER) {
    bot.answerCallbackQuery(query.id, { text: '⛔ No autorizado' });
    return;
  }

  const chatId = query.message.chat.id;
  bot.answerCallbackQuery(query.id).catch(() => {});

  switch (query.data) {

    case 'conectar':
      destroy();
      clearSession();
      reconnN = 0;
      safeSend(chatId, '🔄 *Generando nueva sesión...*');
      connectWA(chatId).catch(e => { connecting = false; safeSend(chatId, `❌ \`${e.message}\``); });
      break;

    case 'cancelar_qr':
      { const m = qrMsgId; destroy();
        if (m) editCaption(chatId, m, '❌ *Conexión cancelada*', null);
        else safeSend(chatId, '❌ *Conexión cancelada*');
        mainMenu(chatId); }
      break;

    case 'borrar_sesion':
      destroy();
      clearSession();
      reconnN = 0;
      safeSend(chatId, '🗑️ Sesión borrada. Ahora pulsa *📱 Conectar WhatsApp* para escanear el QR.');
      mainMenu(chatId);
      break;

    case 'cargar':
      awaitingContacts = true;
      awaitingMessage  = false;
      safeSend(chatId,
        '📎 *Envíame el archivo .txt* con los números (uno por línea).\n\nEjemplo:\n`34612345678`\n`34698765432`'
      );
      break;

    case 'mensaje':
      awaitingMessage  = true;
      awaitingContacts = false;
      safeSend(chatId, '✏️ *Escribe el mensaje* que quieres enviar:', { reply_markup: { force_reply: true } });
      break;

    case 'iniciar':
      if (isSending) { safeSend(chatId, '⚠️ Ya hay un envío activo. Pulsa ⏹ Parar primero.'); break; }
      if (!connected || !contactList.length || !messageText) {
        safeSend(chatId,
          `❌ *Requisitos pendientes:*\n` +
          `${connected           ? '✅' : '❌'} WhatsApp conectado\n` +
          `${contactList.length  ? '✅' : '❌'} Lista cargada (${contactList.length} contactos)\n` +
          `${messageText         ? '✅' : '❌'} Mensaje configurado\n\n` +
          `_Si ya conectaste WA pero aparece ❌, pulsa 🔄 Reconectar WA_`
        );
        break;
      }
      isSending = true;
      safeSend(chatId,
        `✅ *Ciclo automático activado*\n` +
        `📋 Lista: ${contactList.length} contactos\n` +
        `⚡ Velocidad: ~10-15 mensajes/minuto (anti-ban)\n` +
        `🛡️ Delays aleatorios + variación de mensaje activos\n` +
        `⏱ Duración por tanda: ~100-150 minutos\n` +
        `💤 Pausa entre tandas: 2 horas\n` +
        `🔔 Progreso cada ${PROGRESS_EVERY} mensajes\n\n` +
        `_Pulsa ⏹ Parar cuando quieras detener el ciclo_`
      );
      runSendCycle(chatId);
      break;

    case 'parar':
      isSending = false;
      safeSend(chatId, `⏹ *Envío detenido.*\n📊 Total enviados: ${sentTotal}`);
      mainMenu(chatId);
      break;

    case 'estado': {
      const preview = messageText
        ? `"${messageText.substring(0, 60)}${messageText.length > 60 ? '...' : ''}"`
        : '❌ Sin configurar';
      safeSend(chatId,
        `📊 *Estado actual:*\n\n` +
        `📱 WhatsApp: ${connected ? '🟢 Conectado' : '🔴 Desconectado'}\n` +
        `📋 Contactos: ${contactList.length}\n` +
        `📍 Posición: ${currentIndex} / ${contactList.length}\n` +
        `💬 Mensaje: ${preview}\n` +
        `🔄 Enviando: ${isSending ? '🟢 Activo' : '⚫ Parado'}\n` +
        `📤 Total enviados: ${sentTotal}`,
        { reply_markup: { inline_keyboard: [[{ text: '⬅️ Volver al menú', callback_data: 'menu' }]] } }
      );
      break;
    }

    case 'reset':
      currentIndex = 0;
      sentTotal    = 0;
      safeSend(chatId, '🔄 Índice y contador reiniciados a 0.');
      mainMenu(chatId);
      break;

    case 'menu':
      mainMenu(chatId);
      break;
  }
});

// ─── MENSAJES DE TEXTO ────────────────────────────────────────────────────────
bot.on('message', async msg => {
  if (!isAuth(msg)) return;
  if (msg.document) return;

  const text   = msg.text?.trim();
  const chatId = msg.chat.id;

  if (awaitingMessage && text && !text.startsWith('/')) {
    messageText     = text;
    awaitingMessage = false;
    safeSend(chatId, `✅ *Mensaje guardado:*\n\n"${messageText}"`);
    mainMenu(chatId);
    return;
  }

  if (text === '/start' || text === '/menu') mainMenu(chatId);
});

// ─── RECEPCIÓN DE ARCHIVO TXT ─────────────────────────────────────────────────
bot.on('document', async msg => {
  if (!isAuth(msg)) return;

  const doc    = msg.document;
  const chatId = msg.chat.id;

  if (!doc.file_name?.endsWith('.txt') && !doc.mime_type?.includes('text')) {
    safeSend(chatId, '❌ Por favor envía un archivo .txt');
    return;
  }

  safeSend(chatId, '⏳ Descargando lista...');

  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const content  = await downloadText(fileLink);
    const lines    = content.split('\n').map(l => l.trim()).filter(l => l.length >= 7);

    if (!lines.length) {
      safeSend(chatId, '❌ El archivo está vacío o los números no tienen formato correcto.');
      return;
    }

    contactList      = lines;
    currentIndex     = 0;
    awaitingContacts = false;

    safeSend(chatId,
      `✅ *Lista cargada!*\n\n📋 Contactos: ${contactList.length}\n👤 Primero: \`${contactList[0]}\`\n👤 Último: \`${contactList[contactList.length - 1]}\``
    );
    mainMenu(chatId);
  } catch (err) {
    safeSend(chatId, `❌ Error: ${err.message}`);
  }
});

// ─── SHUTDOWN ─────────────────────────────────────────────────────────────────
function shutdown(sig) {
  console.log(`[${sig}] Cerrando...`);
  isSending = false;
  destroy();
  try { bot.stopPolling(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  e => console.error('[FATAL]', e.message));
process.on('unhandledRejection', r => console.error('[FATAL]', r));

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══ WhatsApp Mass Sender v4 ═══');
  if (hasCreds()) {
    console.log('[WA] Sesión encontrada, reconectando...');
    connectWA(null).catch(() => { connecting = false; });
  } else {
    console.log('[WA] Sin sesión. Esperando que el usuario pulse Conectar...');
  }
  console.log('✅ Bot arrancado. Esperando mensajes...');
}
main().catch(e => console.error('[MAIN]', e));
