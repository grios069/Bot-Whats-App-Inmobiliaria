// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v19.0'; // Ajusta si Meta actualiza

// Airtable
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Leads';

// Estado en memoria (usar Redis/DB en prod)
const sessions = new Map(); // key: phone -> { flow, stage, data }

// --- Utilidades WhatsApp ---
async function sendText(to, body) {
  return axios({
    method: 'POST',
    url: `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    data: {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    }
  });
}

async function sendButtons(to, text, buttons) {
  // buttons: [{id:'BUY', title:'Comprar'}, ...]
  return axios({
    method: 'POST',
    url: `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    data: {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: {
          buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } }))
        }
      }
    }
  });
}

function getOrCreateSession(phone) {
  if (!sessions.has(phone)) sessions.set(phone, { flow: null, stage: null, data: {} });
  return sessions.get(phone);
}

async function saveLeadAirtable(fields) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return { ok: false, error: 'Airtable no configurado' };
  try {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;
    const res = await axios.post(url, { records: [{ fields }] }, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' }
    });
    const id = res?.data?.records?.[0]?.id;
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err?.response?.data || err.message };
  }
}

async function showMainMenu(to) {
  await sendButtons(to, '¡Hola! Soy tu asistente inmobiliario. ¿Qué deseas hacer hoy?', [
    { id: 'BUY', title: 'Comprar' },
    { id: 'SELL', title: 'Vender' },
    { id: 'RENT', title: 'Rentar' }
  ]);
}

// --- Webhook Verify ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Webhook Receiver ---
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return res.sendStatus(200);

    const msg = messages[0];
    const from = msg.from; // phone (msisdn)
    const session = getOrCreateSession(from);

    // Parse input
    let inputId = null; // for interactive button/list id
    let text = null;

    if (msg.type === 'text') {
      text = (msg.text?.body || '').trim();
    } else if (msg.type === 'interactive') {
      const inter = msg.interactive;
      inputId = inter?.button_reply?.id || inter?.list_reply?.id;
      text = inter?.button_reply?.title || inter?.list_reply?.title || '';
    }

    const tUpper = (text || '').toUpperCase();

    // Shortcuts
    if (tUpper === 'RESET') {
      sessions.delete(from);
      await sendText(from, 'Conversación reiniciada.');
      await showMainMenu(from);
      return res.sendStatus(200);
    }

    // If new/neutral → show menu
    if (!session.flow && !['BUY','SELL','RENT','COMPRAR','VENDER','RENTAR','MENU','HOLA','HI','HELLO'].includes(tUpper) && !inputId) {
      await showMainMenu(from);
      return res.sendStatus(200);
    }

    // Detect flow selection
    const chosen = inputId || tUpper;
    if (!session.flow && ['BUY','COMPRAR'].includes(chosen)) {
      session.flow = 'BUY'; session.stage = 'ASK_LOCATION'; session.data = { Fuente: 'WhatsApp', Flujo: 'Comprar', Telefono: from };
      await sendText(from, 'Perfecto 🏠 ¿En qué zona o ciudad te interesa comprar?');
      return res.sendStatus(200);
    }
    if (!session.flow && ['SELL','VENDER'].includes(chosen)) {
      session.flow = 'SELL'; session.stage = 'ASK_LOCATION'; session.data = { Fuente: 'WhatsApp', Flujo: 'Vender', Telefono: from };
      await sendText(from, '¡Excelente! 📍 ¿Dónde está ubicada la propiedad (ciudad/barrio)?');
      return res.sendStatus(200);
    }
    if (!session.flow && ['RENT','RENTAR'].includes(chosen)) {
      session.flow = 'RENT'; session.stage = 'ASK_LOCATION'; session.data = { Fuente: 'WhatsApp', Flujo: 'Rentar', Telefono: from };
      await sendText(from, 'Genial 🗺️ ¿En qué zona deseas rentar?');
      return res.sendStatus(200);
    }
    if (!session.flow && ['MENU','HOLA','HI','HELLO'].includes(chosen)) {
      await showMainMenu(from);
      return res.sendStatus(200);
    }

    // --- FLOW LOGIC ---
    const d = session.data;

    if (session.flow === 'SELL') {
      switch (session.stage) {
        case 'ASK_LOCATION':
          d.Ubicacion = text; session.stage = 'ASK_TYPE';
          await sendButtons(from, '¿Qué tipo de propiedad es?', [
            { id: 'TYPE_CASA', title: 'Casa' },
            { id: 'TYPE_APTO', title: 'Apartamento' },
            { id: 'TYPE_TERRENO', title: 'Terreno' },
            { id: 'TYPE_LOCAL', title: 'Local' }
          ]);
          break;
        case 'ASK_TYPE':
          if (chosen.startsWith('TYPE_')) d.TipoPropiedad = text; else d.TipoPropiedad = text;
          session.stage = 'ASK_METERS';
          await sendText(from, '¿Cuántos m² construidos y de terreno? (ej: "120 construidos / 300 terreno")');
          break;
        case 'ASK_METERS':
          d.Metros = text; session.stage = 'ASK_ROOMS';
          await sendText(from, 'Número de recámaras y baños (ej: "3 recámaras / 2 baños").');
          break;
        case 'ASK_ROOMS':
          d.Habitabilidad = text; session.stage = 'ASK_PARKING';
          await sendText(from, '¿Cuántos estacionamientos?');
          break;
        case 'ASK_PARKING':
          d.Estacionamientos = text; session.stage = 'ASK_PRICE';
          await sendText(from, '¿Precio de venta? (moneda y monto)');
          break;
        case 'ASK_PRICE':
          d.PrecioOPresupuesto = text; session.stage = 'ASK_CONTACT_NAME';
          await sendText(from, 'Tu nombre completo, por favor.');
          break;
        case 'ASK_CONTACT_NAME':
          d.Nombre = text; session.stage = 'ASK_EMAIL';
          await sendText(from, 'Tu correo electrónico (opcional, puedes escribir "no").');
          break;
        case 'ASK_EMAIL':
          if (text.toLowerCase() !== 'no') d.Email = text; session.stage = 'ASK_CONSENT';
          await sendButtons(from, '¿Autorizas que compartamos tus datos con nuestro asesor para contacto?', [
            { id: 'CONSENT_YES', title: 'Sí, autorizo' },
            { id: 'CONSENT_NO', title: 'No' }
          ]);
          break;
        case 'ASK_CONSENT':
          if (['CONSENT_YES','SI','SÍ'].includes(chosen) || text.toLowerCase().startsWith('s')) {
            d.Consentimiento = 'Sí'; d.Fecha = new Date().toISOString();
            const { ok, id, error } = await saveLeadAirtable(d);
            if (ok) {
              await sendText(from, `¡Listo! Registramos tu propiedad. ID: ${id}. Un asesor te contactará pronto.`);
            } else {
              await sendText(from, `Guardamos tu información localmente pero hubo un problema con el CRM. Un asesor dará seguimiento. Detalle: ${JSON.stringify(error).slice(0,200)}...`);
            }
            sessions.delete(from);
          } else {
            await sendText(from, 'Entendido. No compartiremos tus datos. Si cambias de opinión, escribe MENU.');
            sessions.delete(from);
          }
          break;
      }
    }

    if (session.flow === 'BUY') {
      switch (session.stage) {
        case 'ASK_LOCATION':
          d.Ubicacion = text; session.stage = 'ASK_TYPE';
          await sendButtons(from, '¿Qué tipo de propiedad buscas?', [
            { id: 'TYPE_CASA', title: 'Casa' },
            { id: 'TYPE_APTO', title: 'Apartamento' },
            { id: 'TYPE_TERRENO', title: 'Terreno' },
            { id: 'TYPE_LOCAL', title: 'Local' }
          ]);
          break;
        case 'ASK_TYPE':
          if (chosen.startsWith('TYPE_')) d.TipoPropiedad = text; else d.TipoPropiedad = text;
          session.stage = 'ASK_BUDGET';
          await sendText(from, '¿Cuál es tu presupuesto máximo? (moneda y monto)');
          break;
        case 'ASK_BUDGET':
          d.PrecioOPresupuesto = text; session.stage = 'ASK_ROOMS';
          await sendText(from, '¿Cuántas recámaras y baños necesitas?');
          break;
        case 'ASK_ROOMS':
          d.Habitabilidad = text; session.stage = 'ASK_PAYMENT';
          await sendButtons(from, '¿Piensas comprar con crédito o contado?', [
            { id: 'PAY_CREDITO', title: 'Crédito' },
            { id: 'PAY_CONTADO', title: 'Contado' }
          ]);
          break;
        case 'ASK_PAYMENT':
          d.FormaPago = (chosen === 'PAY_CREDITO' || text.toUpperCase().includes('CRED')) ? 'Crédito' : 'Contado';
          session.stage = 'ASK_TIMING';
          await sendText(from, '¿En cuánto tiempo te gustaría comprar? (ej: 1-3 meses)');
          break;
        case 'ASK_TIMING':
          d.TiempoCompra = text; session.stage = 'ASK_CONTACT_NAME';
          await sendText(from, 'Tu nombre completo, por favor.');
          break;
        case 'ASK_CONTACT_NAME':
          d.Nombre = text; session.stage = 'ASK_EMAIL';
          await sendText(from, 'Tu correo electrónico (opcional, puedes escribir "no").');
          break;
        case 'ASK_EMAIL':
          if (text.toLowerCase() !== 'no') d.Email = text; session.stage = 'ASK_CONSENT';
          await sendButtons(from, '¿Autorizas que compartamos tus datos con nuestro asesor para contactarte?', [
            { id: 'CONSENT_YES', title: 'Sí, autorizo' },
            { id: 'CONSENT_NO', title: 'No' }
          ]);
          break;
        case 'ASK_CONSENT':
          if (['CONSENT_YES','SI','SÍ'].includes(chosen) || text.toLowerCase().startsWith('s')) {
            d.Consentimiento = 'Sí'; d.Fecha = new Date().toISOString();
            const { ok, id, error } = await saveLeadAirtable(d);
            if (ok) await sendText(from, `¡Gracias! Registramos tu búsqueda. ID: ${id}. Un asesor te contactará.`);
            else await sendText(from, `Guardamos tu info localmente pero falló el CRM. Seguimiento manual. Detalle: ${JSON.stringify(error).slice(0,200)}...`);
            sessions.delete(from);
          } else {
            await sendText(from, 'OK, no compartiremos tus datos. Si quieres volver al menú, escribe MENU.');
            sessions.delete(from);
          }
          break;
      }
    }

    if (session.flow === 'RENT') {
      switch (session.stage) {
        case 'ASK_LOCATION':
          d.Ubicacion = text; session.stage = 'ASK_TYPE';
          await sendButtons(from, '¿Qué tipo de propiedad deseas rentar?', [
            { id: 'TYPE_CASA', title: 'Casa' },
            { id: 'TYPE_APTO', title: 'Apartamento' },
            { id: 'TYPE_LOCAL', title: 'Local' }
          ]);
          break;
        case 'ASK_TYPE':
          if (chosen.startsWith('TYPE_')) d.TipoPropiedad = text; else d.TipoPropiedad = text;
          session.stage = 'ASK_BUDGET';
          await sendText(from, '¿Presupuesto mensual (moneda y monto)?');
          break;
        case 'ASK_BUDGET':
          d.PrecioOPresupuesto = text; session.stage = 'ASK_ROOMS';
          await sendText(from, '¿Recámaras y baños que necesitas?');
          break;
        case 'ASK_ROOMS':
          d.Habitabilidad = text; session.stage = 'ASK_PETS';
          await sendButtons(from, '¿Aceptan/traes mascotas?', [
            { id: 'PETS_YES', title: 'Sí' },
            { id: 'PETS_NO', title: 'No' }
          ]);
          break;
        case 'ASK_PETS':
          d.Mascotas = (chosen === 'PETS_YES' || text.toLowerCase().startsWith('s')) ? 'Sí' : 'No';
          session.stage = 'ASK_STAY';
          await sendText(from, '¿Por cuántos meses planeas rentar?');
          break;
        case 'ASK_STAY':
          d.EstanciaMeses = text; session.stage = 'ASK_CONTACT_NAME';
          await sendText(from, 'Tu nombre completo, por favor.');
          break;
        case 'ASK_CONTACT_NAME':
          d.Nombre = text; session.stage = 'ASK_EMAIL';
          await sendText(from, 'Tu correo electrónico (opcional, puedes escribir "no").');
          break;
        case 'ASK_EMAIL':
          if (text.toLowerCase() !== 'no') d.Email = text; session.stage = 'ASK_CONSENT';
          await sendButtons(from, '¿Autorizas que compartamos tus datos con nuestro asesor para contacto?', [
            { id: 'CONSENT_YES', title: 'Sí, autorizo' },
            { id: 'CONSENT_NO', title: 'No' }
          ]);
          break;
        case 'ASK_CONSENT':
          if (['CONSENT_YES','SI','SÍ'].includes(chosen) || text.toLowerCase().startsWith('s')) {
            d.Consentimiento = 'Sí'; d.Fecha = new Date().toISOString();
            const { ok, id, error } = await saveLeadAirtable(d);
            if (ok) await sendText(from, `¡Perfecto! Registramos tu solicitud de renta. ID: ${id}. Un asesor te contactará.`);
            else await sendText(from, `Guardamos tu info localmente pero falló el CRM. Seguimiento manual. Detalle: ${JSON.stringify(error).slice(0,200)}...`);
            sessions.delete(from);
          } else {
            await sendText(from, 'Entendido. No compartiremos tus datos. Para menú, escribe MENU.');
            sessions.delete(from);
          }
          break;
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(200);
  }
});

app.get('/', (req, res) => res.send('Bot Inmobiliaria OK'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot escuchando en puerto ${port}`));
