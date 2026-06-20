import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = join(ROOT, "data");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_DAYS = 14;

await mkdir(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, "blog.db"));
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 50),
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 3 AND 150),
    body TEXT NOT NULL CHECK(length(body) BETWEEN 10 AND 20000),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`);
db.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { ...jsonHeaders, ...headers });
  res.end(JSON.stringify(data));
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body is too large.");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = stored.split(":");
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const [key, ...value] = part.trim().split("=");
        return [key, decodeURIComponent(value.join("="))];
      }),
  );
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function currentUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  return (
    db
      .prepare(`
        SELECT users.id, users.name, users.email, users.created_at
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.expires_at > CURRENT_TIMESTAMP
      `)
      .get(tokenHash(token)) || null
  );
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) fail(res, 401, "You must be logged in.");
  return user;
}

function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
  ).run(tokenHash(token), userId, expires.toISOString());
  return {
    token,
    cookie: `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
  };
}

function validateCredentials({ name, email, password }, registering = false) {
  if (registering && (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 50)) {
    return "Name must be between 2 and 50 characters.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))) {
    return "Enter a valid email address.";
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return "Password must be between 8 and 128 characters.";
  }
  return null;
}

function validatePost({ title, body }) {
  const cleanTitle = String(title || "").trim();
  const cleanBody = String(body || "").trim();
  if (cleanTitle.length < 3 || cleanTitle.length > 150) {
    return "Title must be between 3 and 150 characters.";
  }
  if (cleanBody.length < 10 || cleanBody.length > 20000) {
    return "Post content must be between 10 and 20,000 characters.";
  }
  return null;
}

function ensureSameOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const expected = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
  if (origin !== expected) {
    fail(res, 403, "Cross-origin request rejected.");
    return false;
  }
  return true;
}

async function handleApi(req, res, url) {
  const method = req.method;
  const parts = url.pathname.split("/").filter(Boolean);
  const id = Number(parts[2]);

  if (!["GET", "HEAD"].includes(method) && !ensureSameOrigin(req, res)) return;

  if (method === "POST" && url.pathname === "/api/auth/register") {
    const input = await readJson(req);
    const validationError = validateCredentials(input, true);
    if (validationError) return fail(res, 400, validationError);
    try {
      const result = db
        .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
        .run(input.name.trim(), normalizeEmail(input.email), hashPassword(input.password));
      const session = createSession(Number(result.lastInsertRowid));
      const user = db
        .prepare("SELECT id, name, email, created_at FROM users WHERE id = ?")
        .get(Number(result.lastInsertRowid));
      return sendJson(res, 201, { user }, { "Set-Cookie": session.cookie });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        return fail(res, 409, "An account with that email already exists.");
      }
      throw error;
    }
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const input = await readJson(req);
    const validationError = validateCredentials(input);
    if (validationError) return fail(res, 400, validationError);
    const row = db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(input.email));
    if (!row || !verifyPassword(input.password, row.password_hash)) {
      return fail(res, 401, "Invalid email or password.");
    }
    const session = createSession(row.id);
    return sendJson(
      res,
      200,
      { user: { id: row.id, name: row.name, email: row.email, created_at: row.created_at } },
      { "Set-Cookie": session.cookie },
    );
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    const token = parseCookies(req).session;
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
    return sendJson(res, 200, { ok: true }, {
      "Set-Cookie": "session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0",
    });
  }

  if (method === "GET" && url.pathname === "/api/auth/me") {
    return sendJson(res, 200, { user: currentUser(req) });
  }

  if (method === "GET" && url.pathname === "/api/posts") {
    const posts = db.prepare(`
      SELECT posts.id, posts.title, posts.body, posts.created_at, posts.updated_at,
             users.id AS author_id, users.name AS author_name,
             COUNT(comments.id) AS comment_count
      FROM posts
      JOIN users ON users.id = posts.user_id
      LEFT JOIN comments ON comments.post_id = posts.id
      GROUP BY posts.id
      ORDER BY posts.created_at DESC
    `).all();
    return sendJson(res, 200, { posts });
  }

  if (method === "GET" && parts[1] === "posts" && Number.isInteger(id)) {
    const post = db.prepare(`
      SELECT posts.id, posts.title, posts.body, posts.created_at, posts.updated_at,
             users.id AS author_id, users.name AS author_name
      FROM posts JOIN users ON users.id = posts.user_id
      WHERE posts.id = ?
    `).get(id);
    if (!post) return fail(res, 404, "Post not found.");
    const comments = db.prepare(`
      SELECT comments.id, comments.body, comments.created_at,
             users.id AS author_id, users.name AS author_name
      FROM comments JOIN users ON users.id = comments.user_id
      WHERE comments.post_id = ?
      ORDER BY comments.created_at ASC
    `).all(id);
    return sendJson(res, 200, { post, comments });
  }

  if (method === "POST" && url.pathname === "/api/posts") {
    const user = requireUser(req, res);
    if (!user) return;
    const input = await readJson(req);
    const validationError = validatePost(input);
    if (validationError) return fail(res, 400, validationError);
    const result = db
      .prepare("INSERT INTO posts (user_id, title, body) VALUES (?, ?, ?)")
      .run(user.id, input.title.trim(), input.body.trim());
    return sendJson(res, 201, { id: Number(result.lastInsertRowid) });
  }

  if (method === "PUT" && parts[1] === "posts" && Number.isInteger(id)) {
    const user = requireUser(req, res);
    if (!user) return;
    const post = db.prepare("SELECT user_id FROM posts WHERE id = ?").get(id);
    if (!post) return fail(res, 404, "Post not found.");
    if (post.user_id !== user.id) return fail(res, 403, "You can only edit your own posts.");
    const input = await readJson(req);
    const validationError = validatePost(input);
    if (validationError) return fail(res, 400, validationError);
    db.prepare(
      "UPDATE posts SET title = ?, body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(input.title.trim(), input.body.trim(), id);
    return sendJson(res, 200, { ok: true });
  }

  if (method === "DELETE" && parts[1] === "posts" && Number.isInteger(id)) {
    const user = requireUser(req, res);
    if (!user) return;
    const result = db.prepare("DELETE FROM posts WHERE id = ? AND user_id = ?").run(id, user.id);
    if (!result.changes) return fail(res, 404, "Post not found or not owned by you.");
    return sendJson(res, 200, { ok: true });
  }

  if (method === "POST" && parts[1] === "posts" && Number.isInteger(id) && parts[3] === "comments") {
    const user = requireUser(req, res);
    if (!user) return;
    if (!db.prepare("SELECT id FROM posts WHERE id = ?").get(id)) {
      return fail(res, 404, "Post not found.");
    }
    const input = await readJson(req);
    const body = String(input.body || "").trim();
    if (!body || body.length > 2000) {
      return fail(res, 400, "Comment must be between 1 and 2,000 characters.");
    }
    const result = db
      .prepare("INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)")
      .run(id, user.id, body);
    return sendJson(res, 201, { id: Number(result.lastInsertRowid) });
  }

  if (method === "DELETE" && parts[1] === "comments" && Number.isInteger(id)) {
    const user = requireUser(req, res);
    if (!user) return;
    const comment = db.prepare(`
      SELECT comments.user_id, posts.user_id AS post_owner_id
      FROM comments JOIN posts ON posts.id = comments.post_id
      WHERE comments.id = ?
    `).get(id);
    if (!comment) return fail(res, 404, "Comment not found.");
    if (comment.user_id !== user.id && comment.post_owner_id !== user.id) {
      return fail(res, 403, "You cannot delete this comment.");
    }
    db.prepare("DELETE FROM comments WHERE id = ?").run(id);
    return sendJson(res, 200, { ok: true });
  }

  fail(res, 404, "API endpoint not found.");
}

async function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    return fail(res, 404, "Page not found.");
  }
  const data = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600",
  });
  res.end(data);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health") {
      return sendJson(res, 200, { status: "ok" });
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(res, url.pathname);
    }
  } catch (error) {
    console.error(error);
    fail(res, error.message.includes("Request body") ? 400 : 500, error.message || "Internal server error.");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Inkwell is running at http://${HOST}:${PORT}`);
});
