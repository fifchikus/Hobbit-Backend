/**
 * Express backend server for Hobbit Quiz Admin Panel
 * 
 * Environment variables required:
 * - ADMIN_PASSWORD: Password for admin authentication
 * - ADMIN_TOKEN: Token for admin authentication (alternative to password)
 * - DATABASE_URL: Postgres connection string (e.g., postgresql://user:pass@host:port/dbname)
 * - PORT: Server port (default: 3001)
 */

import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
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

    res.json(result.rows[0]);
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

    res.status(204).send();
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
