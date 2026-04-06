require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory session store (swap for a DB in production)
const sessions = new Map();

// ─── Health check ───
app.get('/', (req, res) => {
  res.json({
    service: 'DontForget SMS Backend',
    status: 'running',
    version: '1.0.0'
  });
});

// ─── Register a guest session ───
// Called when a guest enters their phone number and selects items
app.post('/api/sessions', (req, res) => {
  const { phone, items, room, hotel } = req.body;

  if (!phone || !items || items.length === 0) {
    return res.status(400).json({ error: 'Phone number and at least one item required' });
  }

  // Normalize phone number
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return res.status(400).json({ error: 'Invalid phone number format' });
  }

  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  sessions.set(sessionId, {
    phone: normalizedPhone,
    items,
    room: room || 'N/A',
    hotel: hotel || 'Hotel',
    createdAt: new Date().toISOString(),
    reminderSent: false,
    active: true
  });

  console.log(`[SESSION] Created ${sessionId} for ${normalizedPhone} — ${items.length} items`);

  res.json({
    sessionId,
    message: 'Session registered. You\'ll receive an SMS when you leave your room area.'
  });
});

// ─── Send welcome text with app link ───
// Called by hotel front desk system when guest checks in
app.post('/api/send-link', (req, res) => {
  const { phone, room, hotel, appUrl } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Phone number required' });
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return res.status(400).json({ error: 'Invalid phone number format' });
  }

  const hotelName = hotel || 'your hotel';
  const roomNum = room || 'your room';
  const link = appUrl || 'https://russellcolevop.github.io/dontforget-app/';

  const message = `Welcome to ${hotelName}! ` +
    `Never forget your belongings — set a quick reminder for Room ${roomNum}: ${link}`;

  twilioClient.messages.create({
    body: message,
    from: TWILIO_PHONE,
    to: normalizedPhone
  })
  .then(msg => {
    console.log(`[LINK] Sent welcome SMS to ${normalizedPhone} — SID: ${msg.sid}`);
    res.json({ success: true, messageSid: msg.sid });
  })
  .catch(err => {
    console.error(`[ERROR] Failed to send welcome SMS:`, err.message);
    res.status(500).json({ error: 'Failed to send SMS', details: err.message });
  });
});

// ─── Trigger reminder SMS ───
// Called by the frontend when geofence is breached
app.post('/api/remind', (req, res) => {
  const { sessionId, phone, items, room, hotel } = req.body;

  // Support both session-based and direct reminders
  let targetPhone, targetItems, targetRoom, targetHotel;

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    if (session.reminderSent) {
      return res.json({ success: true, message: 'Reminder already sent for this session' });
    }
    targetPhone = session.phone;
    targetItems = session.items;
    targetRoom = session.room;
    targetHotel = session.hotel;
    session.reminderSent = true;
  } else {
    // Direct reminder (no session)
    if (!phone || !items || items.length === 0) {
      return res.status(400).json({ error: 'Phone and items required' });
    }
    targetPhone = normalizePhone(phone);
    targetItems = items;
    targetRoom = room || 'your room';
    targetHotel = hotel || 'the hotel';
  }

  if (!targetPhone) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  // Build the SMS
  const itemList = targetItems.join(', ');
  const message = `DontForget! Before you leave ${targetHotel} (Room ${targetRoom}), ` +
    `make sure you have: ${itemList}. ` +
    `Have a great trip!`;

  twilioClient.messages.create({
    body: message,
    from: TWILIO_PHONE,
    to: targetPhone
  })
  .then(msg => {
    console.log(`[REMIND] SMS sent to ${targetPhone} — SID: ${msg.sid}`);
    res.json({ success: true, messageSid: msg.sid });
  })
  .catch(err => {
    console.error(`[ERROR] Failed to send reminder:`, err.message);
    res.status(500).json({ error: 'Failed to send SMS', details: err.message });
  });
});

// ─── Get session status ───
app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({
    room: session.room,
    hotel: session.hotel,
    itemCount: session.items.length,
    reminderSent: session.reminderSent,
    active: session.active,
    createdAt: session.createdAt
  });
});

// ─── Deactivate session (guest checked out) ───
app.delete('/api/sessions/:id', (req, res) => {
  if (sessions.has(req.params.id)) {
    sessions.get(req.params.id).active = false;
    sessions.delete(req.params.id);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// ─── Phone number normalization ───
function normalizePhone(phone) {
  // Strip everything except digits and leading +
  let cleaned = phone.replace(/[^\d+]/g, '');

  // If it starts with 1 and is 11 digits, add +
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return '+' + cleaned;
  }
  // If it's 10 digits (US), add +1
  if (cleaned.length === 10) {
    return '+1' + cleaned;
  }
  // If it already has +, return as-is
  if (cleaned.startsWith('+') && cleaned.length >= 11) {
    return cleaned;
  }

  return null; // Invalid
}

// ─── Start server ───
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   DontForget SMS Backend              ║
  ║   Running on port ${PORT}                ║
  ║                                       ║
  ║   Endpoints:                          ║
  ║   POST /api/sessions   — register     ║
  ║   POST /api/send-link  — welcome SMS  ║
  ║   POST /api/remind     — reminder SMS ║
  ║   GET  /api/sessions/:id — status     ║
  ╚═══════════════════════════════════════╝
  `);
});
