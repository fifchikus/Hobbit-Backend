/**
 * Express backend server for Hobbit Quiz Admin Panel
 * 
 * Environment variables required:
 * - ADMIN_PASSWORD: Password for admin authentication
 * - ADMIN_TOKEN: Token for admin authentication (alternative to password)
 * - DATABASE_URL: Postgres connection string (e.g., postgresql://user:pass@host:port/dbname)
 * - PORT: Server port (default: 3001)
 * - N8N_WEBHOOK_UPDATE_URL: n8n webhook URL for update notifications (optional)
 * - N8N_WEBHOOK_DELETE_URL: n8n webhook URL for delete notifications (optional)
 */

import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  'https://hobbit-quiz.vercel.app',
  // можна додати локальний для дебага:
  'http://localhost:8080',
];

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
  credentials: false,
}));

// важливо: обробити preflight
app.options('*', cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
}));
app.use(express.json());

// Postgres connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
  });  

// Test database connection
pool.query('SELECT NOW()', (err) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected successfully');
  }
});

/**
 * Helper function to notify n8n webhook about event updates
 * Fire-and-forget: errors are logged but don't affect the main response
 */
async function notifyN8nUpdate(event) {
  const webhookUrl = process.env.N8N_WEBHOOK_UPDATE_URL;
  
  if (!webhookUrl) {
    // Webhook not configured, skip silently
    return;
  }

  try {
    const payload = {
      type: 'event_updated',
      event: {
        id: event.id,
        player_id: event.player_id,
        hobbit_name: event.hobbit_name,
        event_type: event.event_type,
        event_timestamp: event.event_timestamp,
        created_at: event.created_at,
      },
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`n8n webhook returned status ${response.status}`);
    }
  } catch (error) {
    console.error('Failed to notify n8n (update):', error.message);
  }
}

/**
 * Helper function to notify n8n webhook about event deletions
 * Fire-and-forget: errors are logged but don't affect the main response
 */
async function notifyN8nDelete(id) {
  const webhookUrl = process.env.N8N_WEBHOOK_DELETE_URL;
  
  if (!webhookUrl) {
    // Webhook not configured, skip silently
    return;
  }

  try {
    const payload = {
      type: 'event_deleted',
      id: id,
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`n8n webhook returned status ${response.status}`);
    }
  } catch (error) {
    console.error('Failed to notify n8n (delete):', error.message);
  }
}

/**
 * Authentication middleware
 * Supports Basic Auth (admin:password) or x-admin-token header
 */
function authenticateAdmin(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminPassword && !adminToken) {
    return res.status(500).json({ error: 'Admin credentials not configured' });
  }

  // Check Basic Auth
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Basic ')) {
    const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const [username, password] = credentials.split(':');
    
    if (username === 'admin' && password === adminPassword) {
      return next();
    }
  }

  // Check token header
  const tokenHeader = req.headers['x-admin-token'];
  if (tokenHeader && tokenHeader === adminToken) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * GET /api/admin/events
 * Fetch all events from hobbit_quiz_events table
 * Optional query param: playerId to filter by player
 */
app.get('/api/admin/events', authenticateAdmin, async (req, res) => {
  try {
    const { playerId } = req.query;
    
    let query = 'SELECT * FROM hobbit_quiz_events';
    const params = [];
    
    if (playerId) {
      query += ' WHERE player_id = $1';
      params.push(playerId);
    }
    
    query += ' ORDER BY id DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

/**
 * PATCH /api/admin/events/:id
 * Update an event by id
 * Body: { hobbitName?: string, eventType?: string }
 */
app.patch('/api/admin/events/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { hobbitName, eventType } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (hobbitName !== undefined) {
      updates.push(`hobbit_name = $${paramCount++}`);
      values.push(hobbitName);
    }

    if (eventType !== undefined) {
      updates.push(`event_type = $${paramCount++}`);
      values.push(eventType);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const query = `
      UPDATE hobbit_quiz_events 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const updated = result.rows[0];
    
    // Send response to client immediately
    res.json(updated);
    
    // Notify n8n webhook (fire-and-forget)
    notifyN8nUpdate(updated).catch(err => {
      // Error already logged in notifyN8nUpdate
    });
  } catch (error) {
    console.error('Error updating event:', error);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

/**
 * DELETE /api/admin/events/:id
 * Delete an event by id
 */
app.delete('/api/admin/events/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM hobbit_quiz_events WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const deletedId = result.rows[0].id;
    
    // Send response to client immediately
    res.status(204).send();
    
    // Notify n8n webhook (fire-and-forget)
    notifyN8nDelete(deletedId).catch(err => {
      // Error already logged in notifyN8nDelete
    });
  } catch (error) {
    console.error('Error deleting event:', error);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Admin routes available at /api/admin/*`);
});
