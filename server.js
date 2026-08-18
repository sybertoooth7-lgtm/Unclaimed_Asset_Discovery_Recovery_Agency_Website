const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

dotenv.config();

const VALID_STATUSES = ['new', 'in_review', 'contacted', 'needs_documents', 'resolved', 'rejected'];

function getDefaultAdminCredentials() {
  return {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123',
  };
}

async function initializeDatabase() {
  const dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const db = await open({
    filename: path.join(dataDir, 'app.db'),
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS enquiries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact TEXT NOT NULL,
      type TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const { username, password } = getDefaultAdminCredentials();
  const existing = await db.get('SELECT id FROM admin_users WHERE username = ?', [username]);

  if (!existing) {
    const passwordHash = await bcrypt.hash(password, 10);
    await db.run('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)', [username, passwordHash]);
  }

  return db;
}

function getTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

function normalizeEnquiry(row) {
  return {
    id: row.id,
    name: row.name,
    contact: row.contact,
    type: row.type,
    details: row.details,
    status: row.status || 'new',
    note: row.note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateEnquiry(payload) {
  const { name, contact, details } = payload || {};
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  const normalizedContact = typeof contact === 'string' ? contact.trim() : '';
  const normalizedDetails = typeof details === 'string' ? details.trim() : '';

  if (!normalizedName) {
    return 'Name is required.';
  }

  if (!normalizedContact) {
    return 'Contact information is required.';
  }

  if (!normalizedDetails) {
    return 'Please share a brief description of the case.';
  }

  return null;
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminUser) {
    return next();
  }

  return res.status(401).json({ message: 'Unauthorized. Please log in.' });
}

async function createApp() {
  const app = express();
  const db = await initializeDatabase();

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(
    session({
      secret: process.env.SESSION_SECRET || 'uadr-session-secret-change-me',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        maxAge: 1000 * 60 * 60 * 8,
      },
    })
  );
  app.use(express.static(__dirname));

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/api/admin/login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required.' });
    }

    const user = await db.get('SELECT * FROM admin_users WHERE username = ?', [username]);
    if (!user) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    req.session.adminUser = { id: user.id, username: user.username };
    return res.json({ ok: true, user: { id: user.id, username: user.username } });
  });

  app.post('/api/admin/logout', requireAdmin, (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  app.get('/api/admin/me', (req, res) => {
    if (!req.session || !req.session.adminUser) {
      return res.status(401).json({ authenticated: false });
    }

    return res.json({ authenticated: true, user: req.session.adminUser });
  });

  app.get('/api/admin/enquiries', requireAdmin, async (req, res) => {
    const rows = await db.all('SELECT * FROM enquiries ORDER BY created_at DESC');
    const enquiries = rows.map(normalizeEnquiry);
    res.json({ enquiries });
  });

  app.patch('/api/admin/enquiries/:id/status', requireAdmin, async (req, res) => {
    const enquiryId = String(req.params.id || '').trim();
    const nextStatus = String(req.body.status || 'new').trim();
    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';

    if (!enquiryId) {
      return res.status(400).json({ message: 'Enquiry ID is required.' });
    }

    if (!VALID_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ message: 'Invalid status value.' });
    }

    const existing = await db.get('SELECT * FROM enquiries WHERE id = ?', [enquiryId]);
    if (!existing) {
      return res.status(404).json({ message: 'Enquiry not found.' });
    }

    const updatedAt = new Date().toISOString();
    await db.run(
      'UPDATE enquiries SET status = ?, note = ?, updated_at = ? WHERE id = ?',
      [nextStatus, note || existing.note || '', updatedAt, enquiryId]
    );

    const updated = await db.get('SELECT * FROM enquiries WHERE id = ?', [enquiryId]);
    return res.json({ enquiry: normalizeEnquiry(updated) });
  });

  app.get('/api/enquiries', async (req, res) => {
    const rows = await db.all('SELECT * FROM enquiries ORDER BY created_at DESC');
    res.json(rows.map(normalizeEnquiry));
  });

  app.post('/api/enquiries', async (req, res) => {
    const validationError = validateEnquiry(req.body);

    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const now = new Date().toISOString();
    const enquiry = {
      id: cryptoRandomId(),
      name: String(req.body.name).trim(),
      contact: String(req.body.contact).trim(),
      type: String(req.body.type || 'Other').trim(),
      details: String(req.body.details).trim(),
      status: 'new',
      note: '',
      createdAt: now,
      updatedAt: now,
    };

    await db.run(
      'INSERT INTO enquiries (id, name, contact, type, details, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [enquiry.id, enquiry.name, enquiry.contact, enquiry.type, enquiry.details, enquiry.status, enquiry.note, enquiry.createdAt, enquiry.updatedAt]
    );

    const transporter = getTransport();
    if (transporter) {
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'noreply@uadr.local',
          to: process.env.RECIPIENT_EMAIL || 'hello@uadr.co.ke',
          subject: `New case enquiry: ${enquiry.type}`,
          text: `Name: ${enquiry.name}\nContact: ${enquiry.contact}\nType: ${enquiry.type}\nStatus: ${enquiry.status}\n\nDetails:\n${enquiry.details}`,
        });
      } catch (error) {
        console.error('Email send failed:', error.message);
      }
    }

    return res.status(201).json({
      message: 'Your case enquiry has been received. We will contact you soon.',
      enquiry,
    });
  });

  app.get('/admin', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
  });

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  return app;
}

function cryptoRandomId() {
  return `case_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  createApp().then((app) => {
    app.listen(PORT, () => {
      const credentials = getDefaultAdminCredentials();
      console.log(`UADR backend running on http://localhost:${PORT}`);
      console.log(`Admin login: ${credentials.username} / ${credentials.password}`);
    });
  }).catch((error) => {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  });
}

module.exports = { createApp, getDefaultAdminCredentials };
